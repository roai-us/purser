import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOGIN_ATTEMPTS_PER_MINUTE, SESSION_TTL_MS } from "./sessions.js";
import { serveUi } from "./static.js";
import { ADMIN_TOKEN, harness } from "./test/helpers.js";
import { REAL_OPENAI_KEY } from "./test/mock-upstream.js";

const cookieFrom = (res: Response): string => {
  const set = res.headers.get("set-cookie") ?? "";
  return set.split(";")[0] ?? "";
};

async function signIn(h: ReturnType<typeof harness>): Promise<string> {
  const code = h.sessions.issueLoginCode();
  const res = await h.app.request(`/login?code=${code}`);
  return cookieFrom(res);
}

describe("signing in to the web UI", () => {
  it("turns the one-time link into a strict, http-only session cookie", async () => {
    const h = harness();
    const code = h.sessions.issueLoginCode();
    const res = await h.app.request(`/login?code=${code}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/^purser_session=/);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    expect(set).toMatch(/Path=\//);
    expect(set).not.toMatch(/Secure/);
    // The link works once.
    const again = await h.app.request(`/login?code=${code}`);
    expect(again.headers.get("location")).toBe("/?login=failed");
    expect((await h.app.request("/login")).headers.get("location")).toBe(
      "/?login=failed",
    );
  });

  it("marks the cookie Secure behind https, and refuses a stale link", async () => {
    const h = harness();
    const fresh = h.sessions.issueLoginCode();
    const secure = await h.app.request(
      `https://purser.example/login?code=${fresh}`,
    );
    expect(secure.headers.get("set-cookie")).toMatch(/Secure/);
    // Behind a proxy that ends HTTPS, the request arrives as plain http.
    const proxied = harness({ baseUrl: "https://purser.example.com" });
    const behind = await proxied.app.request(
      `http://127.0.0.1:4141/login?code=${proxied.sessions.issueLoginCode()}`,
    );
    expect(behind.headers.get("set-cookie")).toMatch(/Secure/);
    const stale = h.sessions.issueLoginCode();
    h.clock.now = new Date(h.clock.now.getTime() + 16 * 60_000);
    const res = await h.app.request(`/login?code=${stale}`);
    expect(res.headers.get("location")).toBe("/?login=failed");
  });

  it("lets a session read, and change only with the CSRF header", async () => {
    const h = harness();
    h.addAgent();
    const cookie = await signIn(h);
    const read = await h.app.request("/admin/agents", { headers: { cookie } });
    expect(read.status).toBe(200);
    const blocked = await h.app.request("/admin/agents/support-bot/kill", {
      method: "POST",
      headers: { cookie },
    });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({
      error: { code: "csrf_required" },
    });
    const allowed = await h.app.request("/admin/agents/support-bot/kill", {
      method: "POST",
      headers: { cookie, "x-purser-csrf": "1" },
    });
    expect(allowed.status).toBe(200);
    expect(
      ((await allowed.json()) as { agent: { pausedBy: string } }).agent
        .pausedBy,
    ).toBe("web");
  });

  it("refuses an agent key even alongside a session, and expired sessions", async () => {
    const h = harness();
    const { key } = h.addAgent();
    const cookie = await signIn(h);
    const res = await h.app.request("/admin/agents", {
      headers: { cookie, authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(401);
    h.clock.now = new Date(h.clock.now.getTime() + SESSION_TTL_MS + 1);
    expect(
      (await h.app.request("/admin/agents", { headers: { cookie } })).status,
    ).toBe(401);
    expect(
      await (
        await h.app.request("/auth/session", { headers: { cookie } })
      ).json(),
    ).toEqual({ authenticated: false });
  });

  it("signs in with the admin token, rate limits guesses, and signs out", async () => {
    const h = harness();
    const post = (body: string) =>
      h.app.request("/auth/session", { method: "POST", body });
    expect((await post("{")).status).toBe(400);
    expect((await post(JSON.stringify({ token: "nope" }))).status).toBe(401);
    const ok = await post(JSON.stringify({ token: ADMIN_TOKEN }));
    expect(ok.status).toBe(200);
    const cookie = cookieFrom(ok);
    expect(
      await (
        await h.app.request("/auth/session", { headers: { cookie } })
      ).json(),
    ).toEqual({
      authenticated: true,
      viewer: { kind: "owner", role: "admin", name: "Purser admin" },
    });
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_MINUTE; i++) {
      await post(JSON.stringify({ token: "guess" }));
    }
    expect((await post(JSON.stringify({ token: ADMIN_TOKEN }))).status).toBe(
      429,
    );
    const out = await h.app.request("/auth/session", {
      method: "DELETE",
      headers: { cookie },
    });
    expect(await out.json()).toEqual({ authenticated: false });
    expect(
      (await h.app.request("/admin/agents", { headers: { cookie } })).status,
    ).toBe(401);
  });
});

describe("serving the web UI", () => {
  const webDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "purser-web-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>UI</title>");
    writeFileSync(join(dir, "assets", "app-1234.js"), "console.log(1)");
    writeFileSync(join(dir, "favicon.svg"), "<svg/>");
    return dir;
  };

  it("serves files with strict headers, and the app for its own routes", async () => {
    const dir = webDir();
    const index = serveUi(dir, "/");
    expect(await index.text()).toContain("<title>UI</title>");
    expect(index.headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
    expect(index.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(index.headers.get("x-content-type-options")).toBe("nosniff");
    expect(index.headers.get("referrer-policy")).toBe("no-referrer");
    expect(index.headers.get("cache-control")).toBe("no-cache");
    const asset = serveUi(dir, "/assets/app-1234.js");
    expect(asset.headers.get("content-type")).toMatch(/javascript/);
    expect(asset.headers.get("cache-control")).toMatch(/immutable/);
    expect(serveUi(dir, "/favicon.svg").headers.get("content-type")).toBe(
      "image/svg+xml",
    );
    expect(await serveUi(dir, "/agents/agt_1").text()).toContain("UI");
    expect(serveUi(dir, "/missing.js").status).toBe(404);
  });

  it("never leaves the web directory", () => {
    const dir = webDir();
    for (const path of [
      "/../package.json",
      "/..%2f..%2fetc%2fpasswd",
      "/%2e%2e/%2e%2e/etc/passwd",
      "/assets/..%5c..%5cindex.html",
      "/index.html%00.js",
      "/%E0%A4%A",
    ]) {
      const res = serveUi(dir, path);
      expect(res.status, path).toBe(404);
    }
  });

  it("says plainly when the UI is not built", async () => {
    const dir = mkdtempSync(join(tmpdir(), "purser-empty-"));
    const res = serveUi(dir, "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/not built/);
    expect(serveUi(dir, "/agents").status).toBe(404);
  });

  it("is wired into the app without shadowing the APIs", async () => {
    const h = harness({ webDir: webDir() });
    expect(await (await h.app.request("/")).text()).toContain("UI");
    expect(await (await h.app.request("/agents")).text()).toContain("UI");
    expect((await h.app.request("/health")).status).toBe(200);
    const unknownAdmin = await h.admin("GET", "/nothing-here");
    expect(unknownAdmin.status).toBe(404);
    expect(await unknownAdmin.json()).toMatchObject({
      error: { code: "not_found" },
    });
    expect((await h.app.request("/auth/whatever")).status).toBe(404);
  });
});

describe("providers in the admin API", () => {
  it("lists every connector with the base URL to paste and no key", async () => {
    const h = harness({ providerKeys: { openai: REAL_OPENAI_KEY } });
    const views = (await (await h.admin("GET", "/providers")).json()) as {
      id: string;
      configured: boolean;
      keySource?: string;
      keyHint?: string;
      agentBaseUrl: string;
      needsUpstream?: boolean;
    }[];
    expect(views).toHaveLength(9);
    const openai = views.find((v) => v.id === "openai");
    expect(openai).toMatchObject({
      configured: true,
      keySource: "env",
      agentBaseUrl: "http://127.0.0.1:4141/openai/v1",
    });
    expect(openai?.keyHint).not.toContain(REAL_OPENAI_KEY);
    expect(views.find((v) => v.id === "anthropic")?.agentBaseUrl).toBe(
      "http://127.0.0.1:4141/anthropic",
    );
    expect(views.find((v) => v.id === "azure-openai")).toMatchObject({
      configured: false,
      needsUpstream: true,
    });
    expect(JSON.stringify(views)).not.toContain(REAL_OPENAI_KEY);
  });

  it("stores a key in the vault, tests it, and removes it again", async () => {
    const h = harness({ providerKeys: {} });
    const put = await h.admin("PUT", "/providers/openai/key", {
      apiKey: REAL_OPENAI_KEY,
    });
    expect(put.status).toBe(200);
    const view = (await put.json()) as {
      configured: boolean;
      keySource: string;
      lastTest: { ok: boolean; latencyMs: number };
    };
    expect(view).toMatchObject({ configured: true, keySource: "vault" });
    expect(view.lastTest.ok).toBe(true);
    expect(h.vault.get("openai")?.apiKey).toBe(REAL_OPENAI_KEY);
    expect(h.store.listAudit().at(-1)).toMatchObject({
      type: "provider.key_set",
      detail: { provider: "openai" },
    });
    expect(JSON.stringify(h.store.listAudit())).not.toContain(REAL_OPENAI_KEY);

    const retest = (await (
      await h.admin("POST", "/providers/openai/test")
    ).json()) as { ok: boolean };
    expect(retest.ok).toBe(true);

    const removed = (await (
      await h.admin("DELETE", "/providers/openai/key")
    ).json()) as { configured: boolean };
    expect(removed.configured).toBe(false);
    expect(
      await (await h.admin("POST", "/providers/openai/test")).json(),
    ).toMatchObject({ ok: false, error: "No key is set for this connector." });
  });

  it("reports a rejected key, a provider error and an unreachable provider", async () => {
    const h = harness({ providerKeys: {} });
    const bad = (await (
      await h.admin("PUT", "/providers/openai/key", { apiKey: "sk-wrong-key" })
    ).json()) as { lastTest: { ok: boolean; error: string } };
    expect(bad.lastTest).toMatchObject({ ok: false });
    expect(bad.lastTest.error).toMatch(/rejected/);
    // The mock has no Anthropic model list: a 404 is not a rejected key.
    const notFound = (await (
      await h.admin("PUT", "/providers/anthropic/key", {
        apiKey: "sk-ant-real",
      })
    ).json()) as { lastTest: { error: string } };
    expect(notFound.lastTest.error).toMatch(/status 404/);

    const down = harness({
      providerKeys: { openai: "sk-x-12345678" },
      fetch: () => Promise.reject(new Error("offline")),
    });
    expect(
      await (await down.admin("POST", "/providers/openai/test")).json(),
    ).toMatchObject({ ok: false, error: "Could not reach mock." });
  });

  it("asks Azure for its address, and checks it", async () => {
    const h = harness({
      providerKeys: {},
      fetch: () => Promise.resolve(Response.json({ data: [] })),
    });
    const missing = await h.admin("PUT", "/providers/azure-openai/key", {
      apiKey: "azure-key-123",
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({
      error: { code: "upstream_required" },
    });
    const plain = await h.admin("PUT", "/providers/azure-openai/key", {
      apiKey: "azure-key-123",
      upstream: "http://contoso.openai.azure.com/openai/v1",
    });
    expect(plain.status).toBe(400);
    const notForOpenai = await h.admin("PUT", "/providers/openai/key", {
      apiKey: "sk-12345678",
      upstream: "https://elsewhere.example/v1",
    });
    expect(await notForOpenai.json()).toMatchObject({
      error: { code: "upstream_not_allowed" },
    });
    const ok = await h.admin("PUT", "/providers/azure-openai/key", {
      apiKey: "azure-key-123",
      upstream: "https://contoso.openai.azure.com/openai/v1/",
    });
    expect(await ok.json()).toMatchObject({
      configured: true,
      upstream: "https://contoso.openai.azure.com/openai/v1",
    });
    // A new key keeps the stored address.
    const rekey = await h.admin("PUT", "/providers/azure-openai/key", {
      apiKey: "azure-key-456",
    });
    expect(rekey.status).toBe(200);
  });

  it("answers 404 and 400 for unknown connectors and bad bodies", async () => {
    const h = harness();
    expect((await h.admin("PUT", "/providers/nope/key", {})).status).toBe(404);
    expect((await h.admin("POST", "/providers/nope/test")).status).toBe(404);
    expect((await h.admin("DELETE", "/providers/nope/key")).status).toBe(404);
    expect(
      (await h.admin("PUT", "/providers/openai/key", { apiKey: "short" }))
        .status,
    ).toBe(400);
  });
});
