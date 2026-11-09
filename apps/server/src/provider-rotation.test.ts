import { describe, expect, it } from "vitest";
import { BUILTIN_CONNECTORS } from "./connectors.js";
import { secretHint } from "./keys.js";
import { chatBody, harness } from "./test/helpers.js";

const OLD = "sk-old-key-0000000000";
const NEW = "sk-new-key-1111111111";
const CHAT = "/openai/v1/chat/completions";

/** A provider that takes only the keys it's told to, and notes who called. */
function provider(
  good: string[],
  bad: { status?: number; offline?: boolean } = {},
) {
  const calls: { url: string; key: string | null }[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    const key =
      new Headers(init?.headers)
        .get("authorization")
        ?.replace(/^Bearer /, "") ?? null;
    calls.push({ url: String(input), key });
    if (key === null || !good.includes(key)) {
      if (bad.offline) return Promise.reject(new Error("offline"));
      return Promise.resolve(new Response("{}", { status: bad.status ?? 401 }));
    }
    return Promise.resolve(
      Response.json({
        model: "gpt-4o-mini",
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  };
  return { calls, fetch: fetchFn };
}

interface View {
  keyHint?: string;
  keySource?: string;
  keySetAt?: string;
  keysUrl?: string;
  upstream?: string;
  lastTest?: { ok: boolean };
  oldKeys?: { hint: string; replacedAt: string }[];
}

async function setUp(p: ReturnType<typeof provider>) {
  const h = harness({ providerKeys: {}, fetch: p.fetch });
  await h.admin("PUT", "/providers/openai/key", { apiKey: OLD });
  return h;
}

describe("replacing a provider key", () => {
  it("switches to a key that works, with no change to any agent", async () => {
    const p = provider([OLD, NEW]);
    const h = await setUp(p);
    const { id, key } = h.addAgent();
    expect(
      (await h.call(CHAT, { method: "POST", body: chatBody(), key })).status,
    ).toBe(200);

    const res = await h.admin("PUT", "/providers/openai/key", { apiKey: NEW });
    expect(res.status).toBe(200);
    const view = (await res.json()) as View;
    expect(view.keyHint).toBe(secretHint(NEW));
    expect(view.lastTest?.ok).toBe(true);
    expect(view.keySetAt).toBeDefined();
    expect(view.oldKeys?.map((k) => k.hint)).toEqual([secretHint(OLD)]);
    expect(h.vault.get("openai")?.apiKey).toBe(NEW);

    // The same agent key carries on, and the provider now sees the new key.
    expect(
      (await h.call(CHAT, { method: "POST", body: chatBody(), key })).status,
    ).toBe(200);
    expect(p.calls.at(-1)?.key).toBe(NEW);
    expect(h.store.listUsage(id)).toHaveLength(2);

    expect(h.store.listAudit().at(-1)).toMatchObject({
      type: "provider.key_rotated",
      detail: { provider: "openai", oldKey: secretHint(OLD) },
    });
    const everything = JSON.stringify([view, h.store.listAudit()]);
    expect(everything).not.toContain(OLD);
    expect(everything).not.toContain(NEW);
  });

  it.each([
    ["rejects it", { status: 401 }, "rejected this key"],
    ["answers 400, as xAI and Gemini do", { status: 400 }, "rejected this key"],
    ["fails", { status: 500 }, "status 500"],
    ["can't be reached", { offline: true }, "Could not reach"],
  ])("changes nothing when the provider %s", async (_name, bad, message) => {
    const p = provider([OLD], bad);
    const h = await setUp(p);
    const { key } = h.addAgent();

    const res = await h.admin("PUT", "/providers/openai/key", {
      apiKey: NEW,
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("key_test_failed");
    expect(body.error.message).toContain(message);
    expect(body.error.message).toContain("still using your current key");

    const entry = h.vault.get("openai");
    expect(entry?.apiKey).toBe(OLD);
    expect(entry?.lastTest?.ok).toBe(true);
    expect(entry?.oldKeys).toBeUndefined();
    expect(
      (await h.call(CHAT, { method: "POST", body: chatBody(), key })).status,
    ).toBe(200);
    expect(p.calls.at(-1)?.key).toBe(OLD);
    expect(h.store.listAudit().at(-1)).toMatchObject({
      type: "provider.key_rejected",
    });
    expect(JSON.stringify(h.store.listAudit())).not.toContain(NEW);
  });

  it("refuses the key already in use", async () => {
    const p = provider([OLD]);
    const h = await setUp(p);
    const before = p.calls.length;
    const res = await h.admin("PUT", "/providers/openai/key", { apiKey: OLD });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "same_key" } });
    expect(p.calls).toHaveLength(before);
  });

  it("still saves a first key that fails its test", async () => {
    const h = harness({ providerKeys: {}, fetch: provider([]).fetch });
    const res = await h.admin("PUT", "/providers/openai/key", { apiKey: OLD });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      configured: true,
      lastTest: { ok: false },
    });
    expect(h.store.listAudit().at(-1)?.type).toBe("provider.key_set");
  });

  it("can replace a key that had failed its test", async () => {
    const h = harness({ providerKeys: {}, fetch: provider([NEW]).fetch });
    await h.admin("PUT", "/providers/openai/key", { apiKey: OLD });
    const res = await h.admin("PUT", "/providers/openai/key", { apiKey: NEW });
    expect(res.status).toBe(200);
    expect(h.vault.get("openai")?.apiKey).toBe(NEW);
    // A key the provider turned down isn't worth a reminder to delete it.
    expect(((await res.json()) as View).oldKeys).toBeUndefined();
    expect(h.store.listAudit().at(-1)?.type).toBe("provider.key_rotated");
  });

  it("still reminds you about a key that only failed because of an outage", async () => {
    const p = provider([NEW], { status: 500 });
    const h = await setUp(p);
    const res = await h.admin("PUT", "/providers/openai/key", { apiKey: NEW });
    expect(((await res.json()) as View).oldKeys).toHaveLength(1);
  });

  it("tests a new Azure address with the new key, and keeps the old one if it fails", async () => {
    const seen: string[] = [];
    let accept = true;
    const h = harness({
      providerKeys: {},
      fetch: (input) => {
        seen.push(String(input));
        return Promise.resolve(
          new Response("{}", { status: accept ? 200 : 401 }),
        );
      },
    });
    const first = "https://one.openai.azure.com/openai/v1";
    await h.admin("PUT", "/providers/azure-openai/key", {
      apiKey: OLD,
      upstream: first,
    });
    accept = false;
    const second = "https://two.openai.azure.com/openai/v1";
    const failed = await h.admin("PUT", "/providers/azure-openai/key", {
      apiKey: NEW,
      upstream: `${second}/`,
    });
    expect(failed.status).toBe(422);
    expect(seen.at(-1)).toBe(`${second}/models`);
    expect(h.vault.get("azure-openai")?.upstream).toBe(first);

    accept = true;
    const moved = await h.admin("PUT", "/providers/azure-openai/key", {
      apiKey: NEW,
      upstream: second,
    });
    expect(((await moved.json()) as View).upstream).toBe(second);
  });

  it("takes over from a key in the environment and remembers it", async () => {
    const h = harness({
      providerKeys: { openai: OLD },
      fetch: provider([OLD, NEW]).fetch,
    });
    const before = (await (
      await h.admin("GET", "/providers")
    ).json()) as (View & {
      id: string;
    })[];
    const openai = before.find((v) => v.id === "openai");
    expect(openai?.keySource).toBe("env");
    expect(openai?.keySetAt).toBeUndefined();
    const view = (await (
      await h.admin("PUT", "/providers/openai/key", { apiKey: NEW })
    ).json()) as View;
    expect(view.keySource).toBe("vault");
    expect(view.oldKeys?.[0]?.hint).toBe(secretHint(OLD));
  });

  it("keeps a reminder for every old key until someone says they're gone", async () => {
    const keys = Array.from(
      { length: 23 },
      (_, i) => `sk-key-${i}-00000000000`,
    );
    const h = harness({ providerKeys: {}, fetch: provider(keys).fetch });
    for (const apiKey of keys.slice(0, 3)) {
      await h.admin("PUT", "/providers/openai/key", { apiKey });
    }
    let view = (await (await h.admin("GET", "/providers")).json()) as (View & {
      id: string;
    })[];
    expect(
      view.find((v) => v.id === "openai")?.oldKeys?.map((k) => k.hint),
    ).toEqual([secretHint(keys[0] ?? ""), secretHint(keys[1] ?? "")]);

    const done = await h.admin("POST", "/providers/openai/old-keys/deleted");
    expect(done.status).toBe(200);
    expect(((await done.json()) as View).oldKeys).toBeUndefined();
    expect(h.store.listAudit().at(-1)).toMatchObject({
      type: "provider.old_keys_deleted",
      detail: { provider: "openai" },
    });

    // Saying so again changes nothing, and isn't recorded twice.
    const events = h.store.listAudit().length;
    await h.admin("POST", "/providers/openai/old-keys/deleted");
    expect(h.store.listAudit()).toHaveLength(events);

    // The list doesn't grow forever.
    for (const apiKey of keys.slice(3)) {
      await h.admin("PUT", "/providers/openai/key", { apiKey });
    }
    expect(h.vault.get("openai")?.oldKeys).toHaveLength(20);
    view = (await (await h.admin("GET", "/providers")).json()) as (View & {
      id: string;
    })[];
    expect(view.find((v) => v.id === "openai")?.keyHint).toBe(
      secretHint(keys.at(-1) ?? ""),
    );
  });

  it("answers 404 for an unknown connector", async () => {
    const h = harness();
    expect(
      (await h.admin("POST", "/providers/nope/old-keys/deleted")).status,
    ).toBe(404);
  });

  it("is for admins", async () => {
    const h = harness({ providerKeys: {} });
    const anon = await h.app.request(
      "/admin/providers/openai/old-keys/deleted",
      { method: "POST" },
    );
    expect(anon.status).toBe(401);
  });
});

describe("what the provider list says about keys", () => {
  it("links every built-in connector to where its keys are made", async () => {
    for (const c of BUILTIN_CONNECTORS) {
      expect(c.keysUrl, c.id).toMatch(/^https:\/\//);
    }
    const h = harness({ providerKeys: {} });
    const views = (await (
      await h.admin("GET", "/providers")
    ).json()) as (View & {
      id: string;
    })[];
    expect(views.find((v) => v.id === "openrouter")?.keysUrl).toBe(
      "https://openrouter.ai/settings/keys",
    );
  });
});

describe("OpenRouter's key test", () => {
  it("asks about the key, because its model list answers anyone", async () => {
    const h = harness({ providerKeys: {} });
    const bad = (await (
      await h.admin("PUT", "/providers/openrouter/key", {
        apiKey: "sk-or-not-a-real-key-000",
      })
    ).json()) as View;
    expect(bad.lastTest?.ok).toBe(false);
    expect(h.upstream.seen.at(-1)?.path).toBe("/openrouter/api/v1/key");
  });

  it("passes a real key", async () => {
    const h = harness();
    const result = (await (
      await h.admin("POST", "/providers/openrouter/test")
    ).json()) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(h.upstream.seen.at(-1)?.path).toBe("/openrouter/api/v1/key");
  });
});
