import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_CONNECTORS,
  customManifest,
  isLoopbackHost,
  loadCustomConnectors,
  upstreamProblem,
} from "./connectors.js";
import { buildProvider, stripVendor } from "./providers.js";
import { chatBody, harness } from "./test/helpers.js";
import { REAL_OPENAI_KEY } from "./test/mock-upstream.js";
import { Vault } from "./vault.js";

const tempDir = () => mkdtempSync(join(tmpdir(), "purser-conn-"));

const writeConnector = (dir: string, file: string, body: unknown) => {
  mkdirSync(join(dir, "connectors"), { recursive: true });
  writeFileSync(
    join(dir, "connectors", file),
    typeof body === "string" ? body : JSON.stringify(body),
  );
};

const acme = {
  id: "acme",
  name: "Acme AI",
  kind: "openai-compatible",
  upstream: "https://api.acme.example/v1/",
};

describe("built-in connectors", () => {
  it("have unique ids and mounts, and keep the original three in place", () => {
    const providers = BUILTIN_CONNECTORS.map(buildProvider);
    expect(new Set(providers.map((p) => p.id)).size).toBe(providers.length);
    expect(new Set(providers.map((p) => p.mount)).size).toBe(providers.length);
    const mounts = Object.fromEntries(providers.map((p) => [p.id, p.mount]));
    expect(mounts).toMatchObject({
      openai: "/openai/v1",
      anthropic: "/anthropic/v1",
      openrouter: "/openrouter/api/v1",
      xai: "/xai/v1",
      gemini: "/gemini/v1",
      mistral: "/mistral/v1",
      groq: "/groq/v1",
      deepseek: "/deepseek/v1",
      "azure-openai": "/azure-openai/v1",
    });
    for (const m of BUILTIN_CONNECTORS) {
      expect(upstreamProblem(m.upstream)).toBeNull();
      expect(m.docsUrl).toMatch(/^https:\/\//);
    }
  });

  it("send the real key the way each provider expects", () => {
    const headersFor = (id: string) => {
      const manifest = BUILTIN_CONNECTORS.find((m) => m.id === id);
      if (!manifest) throw new Error(id);
      const h = new Headers();
      buildProvider(manifest).setAuth(h, "k");
      return Object.fromEntries(h.entries());
    };
    expect(headersFor("xai")).toEqual({ authorization: "Bearer k" });
    expect(headersFor("anthropic")).toEqual({ "x-api-key": "k" });
    expect(headersFor("azure-openai")).toEqual({ "api-key": "k" });
  });

  it("maps vendor-prefixed model names to the price table", () => {
    expect(stripVendor("openai/gpt-oss-20b")).toBe("gpt-oss-20b");
    expect(stripVendor("gpt-4o")).toBe("gpt-4o");
  });
});

describe("upstream rules", () => {
  it("wants https, except on this machine", () => {
    expect(upstreamProblem("https://x.example/v1")).toBeNull();
    expect(upstreamProblem("http://127.0.0.1:8080/v1")).toBeNull();
    expect(upstreamProblem("http://localhost/v1")).toBeNull();
    expect(upstreamProblem("http://[::1]:9/v1")).toBeNull();
    expect(upstreamProblem("http://models.localhost/v1")).toBeNull();
    expect(upstreamProblem("http://evil.example/v1")).toMatch(/https/);
    expect(upstreamProblem("ftp://x.example")).toMatch(/https/);
    expect(upstreamProblem("not a url")).toMatch(/full URL/);
    expect(upstreamProblem("https://u:p@x.example")).toMatch(/password/);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
  });
});

describe("custom connectors", () => {
  it("loads valid manifests with safe defaults", () => {
    const dir = tempDir();
    writeConnector(dir, "acme.json", acme);
    writeConnector(dir, "local.json", {
      id: "local-llm",
      name: "Local",
      kind: "anthropic",
      upstream: "http://127.0.0.1:11434/v1",
    });
    writeConnector(dir, "notes.txt", "ignored");
    const { manifests, problems } = loadCustomConnectors(dir);
    expect(problems).toEqual([]);
    expect(manifests.map((m) => [m.id, m.mount, m.auth, m.source])).toEqual([
      ["acme", "/acme/v1", "bearer", "custom"],
      ["local-llm", "/local-llm/v1", "x-api-key", "custom"],
    ]);
    expect(manifests[0]?.upstream).toBe("https://api.acme.example/v1");
    expect(manifests[0]?.endpoints).toEqual(["chat.completions", "responses"]);
    expect(manifests[1]?.envHint.baseUrlVar).toBe("ANTHROPIC_BASE_URL");
  });

  it("skips and reports bad files, never half-loading them", () => {
    const dir = tempDir();
    writeConnector(dir, "a-builtin.json", { ...acme, id: "openai" });
    writeConnector(dir, "b-reserved.json", { ...acme, id: "admin" });
    writeConnector(dir, "b-reserved-v1.json", { ...acme, id: "v1" });
    writeConnector(dir, "c-plain-http.json", {
      ...acme,
      id: "plain",
      upstream: "http://api.acme.example/v1",
    });
    writeConnector(dir, "d-bad-id.json", { ...acme, id: "Bad Id" });
    writeConnector(dir, "e-broken.json", "{");
    writeConnector(dir, "f-wrong-endpoint.json", {
      ...acme,
      id: "mixed",
      endpoints: ["messages"],
    });
    writeConnector(dir, "g-extra-field.json", {
      ...acme,
      id: "extra",
      evil: 1,
    });
    writeConnector(dir, "g-keys-url.json", {
      ...acme,
      id: "scripted",
      keysUrl: "javascript:alert(1)",
    });
    writeConnector(dir, "h-dupe-1.json", { ...acme, id: "twice" });
    writeConnector(dir, "i-dupe-2.json", { ...acme, id: "twice" });
    const { manifests, problems } = loadCustomConnectors(dir);
    expect(manifests.map((m) => m.id)).toEqual(["twice"]);
    expect(problems).toHaveLength(10);
    expect(problems.join("\n")).toMatch(/already used/);
    expect(problems.join("\n")).toMatch(/reserved/);
    expect(problems.join("\n")).toMatch(/https/);
  });

  it("returns nothing when there is no connectors directory", () => {
    expect(loadCustomConnectors(tempDir())).toEqual({
      manifests: [],
      problems: [],
    });
  });

  it("proxies and meters through a custom connector like a built-in one", async () => {
    const custom = customManifest({
      id: "acme",
      name: "Acme AI",
      kind: "openai-compatible",
      upstream: "http://mock/openai/v1",
      stripVendorPrefix: true,
    });
    const h = harness({
      customConnectors: [custom],
      providerKeys: { acme: REAL_OPENAI_KEY },
    });
    const { id, key } = h.addAgent();
    const res = await h.call("/acme/v1/chat/completions", {
      method: "POST",
      body: chatBody(),
      key,
    });
    expect(res.status).toBe(200);
    expect(h.store.listUsage(id)[0]).toMatchObject({
      provider: "acme",
      priced: "table",
    });
    const views = (await (await h.admin("GET", "/providers")).json()) as {
      id: string;
      source: string;
    }[];
    expect(views.find((v) => v.id === "acme")?.source).toBe("custom");
  });
});

describe("new built-in connectors through the gateway", () => {
  it("proxies xAI with a bearer key to its own upstream", async () => {
    const h = harness({
      providerKeys: { xai: REAL_OPENAI_KEY },
      upstreams: { xai: "http://mock/openai/v1" },
    });
    const { id, key } = h.addAgent();
    const res = await h.call("/xai/v1/chat/completions", {
      method: "POST",
      body: chatBody({ stream: true }),
      key,
    });
    await res.text();
    expect(res.status).toBe(200);
    // xAI is not asked to add usage to streams; the mock leaves it out, so
    // Purser charges an estimate rather than nothing.
    expect(h.upstream.seen.at(-1)?.body).not.toHaveProperty("stream_options");
    expect(h.store.listUsage(id)[0]).toMatchObject({
      provider: "xai",
      priced: "estimate",
    });
  });

  it("sends Azure the api-key header and needs a resource address first", async () => {
    const seen: Headers[] = [];
    const h = harness({
      providerKeys: { "azure-openai": "azure-key" },
      fetch: (input, init) => {
        seen.push(new Headers(init?.headers));
        return Promise.resolve(
          Response.json({
            model: "gpt-4o-mini",
            usage: { prompt_tokens: 10, completion_tokens: 5 },
            url: String(input),
          }),
        );
      },
    });
    const { key } = h.addAgent();
    const before = await h.call("/azure-openai/v1/chat/completions", {
      method: "POST",
      body: chatBody(),
      key,
    });
    expect(before.status).toBe(503);
    h.vault.set("azure-openai", {
      upstream: "https://contoso.openai.azure.com/openai/v1",
    });
    const after = await h.call("/azure-openai/v1/chat/completions", {
      method: "POST",
      body: chatBody(),
      key,
    });
    expect(after.status).toBe(200);
    const body = (await after.json()) as { url: string };
    expect(body.url).toBe(
      "https://contoso.openai.azure.com/openai/v1/chat/completions",
    );
    expect(seen[0]?.get("api-key")).toBe("azure-key");
    expect(seen[0]?.has("authorization")).toBe(false);
  });
});

describe("vault", () => {
  it("keeps keys in a file only its owner can read, and survives a restart", () => {
    const dir = tempDir();
    const vault = new Vault(dir);
    vault.set("openai", { apiKey: "sk-secret-123456789" });
    expect(statSync(join(dir, "vault.json")).mode & 0o077).toBe(0);
    const again = new Vault(dir);
    expect(again.get("openai")?.apiKey).toBe("sk-secret-123456789");
    again.removeKey("openai");
    again.removeKey("nobody");
    expect(new Vault(dir).get("openai")?.apiKey).toBeUndefined();
  });
});
