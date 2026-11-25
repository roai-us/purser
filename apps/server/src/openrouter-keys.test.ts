import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentKeySecret,
  desiredFor,
  MANAGEMENT_SECRET,
  mayUseOpenRouter,
  OpenRouterKeys,
  type AgentKeyRecord,
  type OpenRouterKeysView,
} from "./openrouter-keys.js";
import { Store } from "./store.js";
import { harness, routerBody, type Harness } from "./test/helpers.js";
import {
  OPENROUTER_COST,
  OPENROUTER_MANAGEMENT_KEY,
  REAL_OPENROUTER_KEY,
} from "./test/mock-upstream.js";
import type { Agent } from "./types.js";
import { Vault } from "./vault.js";

const CHAT = "/openrouter/api/v1/chat/completions";
const NOW = new Date("2026-11-07T12:00:00Z");

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: "agt_1",
  name: "bot",
  owner: "Dana",
  keyHash: "h",
  keyHint: "k",
  status: "active",
  limits: {},
  createdAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

async function setUp(h: Harness, enable = true) {
  const res = await h.admin("PUT", "/openrouter/management-key", {
    key: OPENROUTER_MANAGEMENT_KEY,
  });
  expect(res.status).toBe(200);
  if (enable) {
    const on = await h.admin("PUT", "/openrouter/agent-keys", {
      enabled: true,
    });
    expect(on.status).toBe(200);
    await h.openRouterKeys.settle();
  }
}

const call = (h: Harness, key: string) =>
  h.call(CHAT, { method: "POST", body: routerBody(), key });

/** The key the mock OpenRouter saw on its last chat call. */
const lastUpstreamKey = (h: Harness) =>
  h.upstream.seen
    .filter((s) => s.path.endsWith("/chat/completions"))
    .at(-1)
    ?.headers.authorization?.replace("Bearer ", "");

const mockKeys = (h: Harness) => [...h.upstream.orKeys.values()];
const record = (h: Harness, id: string) =>
  h.openRouterKeys.forAgent(id) as AgentKeyRecord;

describe("what an agent's OpenRouter key should be", () => {
  it("takes the tighter daily cap, else the monthly one, with raises", () => {
    expect(desiredFor(agent(), NOW)).toEqual({
      limit: null,
      limitReset: null,
      disabled: false,
      expiresAt: null,
    });
    expect(
      desiredFor(agent({ limits: { dailyUsd: 10, monthlyUsd: 100 } }), NOW),
    ).toMatchObject({ limit: 10, limitReset: "daily" });
    expect(
      desiredFor(
        agent({
          limits: { dailyUsd: 10 },
          serviceLimits: { openrouter: { dailyUsd: 2.555 } },
        }),
        NOW,
      ),
    ).toMatchObject({ limit: 2.56, limitReset: "daily" });
    expect(
      desiredFor(
        agent({ serviceLimits: { openrouter: { monthlyUsd: 40 } } }),
        NOW,
      ),
    ).toMatchObject({ limit: 40, limitReset: "monthly" });
    expect(
      desiredFor(
        agent({
          limits: { dailyUsd: 10 },
          raises: [
            {
              window: "day",
              period: "2026-11-07",
              amountUsd: 5,
              at: NOW.toISOString(),
              by: "admin",
            },
          ],
        }),
        NOW,
      ).limit,
    ).toBe(15);
  });

  it("is disabled while paused and expires at the end date, to the second", () => {
    expect(
      desiredFor(
        agent({ status: "paused", endsAt: "2026-12-31T23:59:59.500Z" }),
        NOW,
      ),
    ).toMatchObject({ disabled: true, expiresAt: "2026-12-31T23:59:59Z" });
  });

  it("only for agents that may use OpenRouter", () => {
    expect(mayUseOpenRouter(agent())).toBe(true);
    expect(mayUseOpenRouter(agent({ providers: [] }))).toBe(true);
    expect(mayUseOpenRouter(agent({ providers: ["openrouter"] }))).toBe(true);
    expect(mayUseOpenRouter(agent({ providers: ["openai"] }))).toBe(false);
  });
});

describe("the management key", () => {
  it("is checked with OpenRouter, saved in the vault and never shown", async () => {
    const h = harness();
    const ordinary = await h.admin("PUT", "/openrouter/management-key", {
      key: REAL_OPENROUTER_KEY + "-longer",
    });
    expect(ordinary.status).toBe(400);
    const plain = await h.admin("PUT", "/openrouter/management-key", {
      key: REAL_OPENROUTER_KEY,
    });
    expect(plain.status).toBe(400);
    expect(await plain.text()).toContain("ordinary OpenRouter API key");
    expect(
      (await h.admin("PUT", "/openrouter/management-key", { key: "x" })).status,
    ).toBe(400);

    await setUp(h, false);
    const view = (await (
      await h.admin("GET", "/openrouter/agent-keys")
    ).json()) as OpenRouterKeysView;
    expect(view).toMatchObject({
      managementKey: { set: true },
      enabled: false,
      connected: true,
      keys: 0,
    });
    expect(JSON.stringify(view)).not.toContain(OPENROUTER_MANAGEMENT_KEY);
    expect(h.vault.get(MANAGEMENT_SECRET)?.apiKey).toBe(
      OPENROUTER_MANAGEMENT_KEY,
    );
    expect(JSON.stringify(h.store.listAudit())).not.toContain(
      OPENROUTER_MANAGEMENT_KEY,
    );

    expect((await h.admin("DELETE", "/openrouter/management-key")).status).toBe(
      200,
    );
    expect(h.vault.get(MANAGEMENT_SECRET)?.apiKey).toBeUndefined();
  });

  it("can't be removed while per-agent keys are on", async () => {
    const h = harness();
    expect(
      (await h.admin("PUT", "/openrouter/agent-keys", { enabled: true }))
        .status,
    ).toBe(409);
    await setUp(h);
    expect((await h.admin("DELETE", "/openrouter/management-key")).status).toBe(
      409,
    );
    expect(
      (await h.admin("PUT", "/openrouter/agent-keys", { enabled: "yes" }))
        .status,
    ).toBe(400);
  });
});

describe("per-agent keys", () => {
  it("are made for agents that list or use OpenRouter, and used for their calls", async () => {
    const h = harness();
    const listed = h.addAgent(
      "listed",
      { dailyUsd: 5 },
      { providers: ["openrouter"] },
    );
    const other = h.addAgent("other", {}, { providers: ["openai"] });
    const any = h.addAgent("any");
    await setUp(h);

    expect(mockKeys(h).map((k) => k.name)).toEqual(["Purser: listed"]);
    expect(mockKeys(h)[0]).toMatchObject({ limit: 5, limit_reset: "daily" });
    expect(record(h, listed.id)).toMatchObject({
      limit: 5,
      limitReset: "daily",
      disabled: false,
    });
    expect(h.openRouterKeys.forAgent(other.id)).toBeUndefined();

    // The listed agent's calls go out on its own key.
    expect((await call(h, listed.key)).status).toBe(200);
    const own = h.vault.get(agentKeySecret(listed.id))?.apiKey;
    expect(own).toMatch(/^sk-or-v1-agent/);
    expect(lastUpstreamKey(h)).toBe(own);
    expect(mockKeys(h)[0]?.usage).toBe(OPENROUTER_COST);

    // An agent allowed any service gets one after its first OpenRouter call,
    // which used the shared key.
    expect((await call(h, any.key)).status).toBe(200);
    expect(lastUpstreamKey(h)).toBe(REAL_OPENROUTER_KEY);
    await h.openRouterKeys.settle();
    expect(record(h, any.id).limit).toBeNull();
    expect((await call(h, any.key)).status).toBe(200);
    expect(lastUpstreamKey(h)).toBe(
      h.vault.get(agentKeySecret(any.id))?.apiKey,
    );

    // The agent's view, without the key itself.
    const view = await (
      await h.admin("GET", `/agents/${listed.id}/openrouter-key`)
    ).text();
    expect(view).toContain('"limitReset":"daily"');
    expect(view).not.toContain(own);
    expect(
      (await h.admin("GET", "/agents/agt_nope/openrouter-key")).status,
    ).toBe(404);
    expect(JSON.stringify(h.store.listAudit())).not.toContain(own);
    expect(h.store.listAudit().at(-1)).toMatchObject({
      type: "openrouter.key",
      agentId: any.id,
      detail: { action: "created" },
    });
  });

  it("are disabled when the agent stops, so OpenRouter refuses it too", async () => {
    const h = harness();
    const bot = h.addAgent("bot", {}, { providers: ["openrouter"] });
    await setUp(h);
    const own = h.vault.get(agentKeySecret(bot.id))?.apiKey as string;

    await h.admin("POST", `/agents/${bot.id}/kill`);
    await h.openRouterKeys.settle();
    expect(mockKeys(h)[0]?.disabled).toBe(true);
    expect(record(h, bot.id).disabled).toBe(true);
    // The second layer: even straight to OpenRouter, the key no longer works.
    const direct = await h.upstream.app.fetch(
      new Request(`http://mock${CHAT}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${own}`,
          "content-type": "application/json",
        },
        body: routerBody(),
      }),
    );
    expect(direct.status).toBe(401);

    await h.admin("POST", `/agents/${bot.id}/resume`);
    await h.openRouterKeys.settle();
    expect(mockKeys(h)[0]?.disabled).toBe(false);
    expect(
      h.store
        .listAudit()
        .filter((e) => e.type === "openrouter.key")
        .map((e) => e.detail?.action),
    ).toEqual(["created", "disabled", "enabled"]);
  });

  it("follow the agent's limits, and OpenRouter enforces them as a backstop", async () => {
    const h = harness();
    const bot = h.addAgent(
      "bot",
      { monthlyUsd: 50 },
      { providers: ["openrouter"] },
    );
    await setUp(h);
    expect(mockKeys(h)[0]).toMatchObject({ limit: 50, limit_reset: "monthly" });

    await h.admin("PATCH", `/agents/${bot.id}/limits`, { dailyUsd: 3 });
    await h.openRouterKeys.settle();
    expect(mockKeys(h)[0]).toMatchObject({ limit: 3, limit_reset: "daily" });
    await h.admin("POST", `/agents/${bot.id}/raise-limit`, {
      window: "day",
      amountUsd: 2,
    });
    await h.openRouterKeys.settle();
    expect(mockKeys(h)[0]?.limit).toBe(5);

    // If OpenRouter's count runs out first, its refusal comes back as it is.
    const key = mockKeys(h)[0];
    if (key) key.usage = 5;
    const res = await call(h, bot.key);
    expect(res.status).toBe(402);
    expect(await res.text()).toContain("openrouter_key_limit");
  });

  it("expire with the agent, are remade for a new end date, and go when it ends", async () => {
    const h = harness();
    const bot = h.addAgent(
      "bot",
      {},
      { providers: ["openrouter"], endsAt: "2026-11-30T00:00:00.000Z" },
    );
    await setUp(h);
    expect(mockKeys(h)[0]?.expires_at).toBe("2026-11-30T00:00:00Z");
    const first = record(h, bot.id).hash;

    await h.admin("PATCH", `/agents/${bot.id}`, {
      endsAt: "2026-12-15T00:00:00.000Z",
    });
    await h.openRouterKeys.settle();
    expect(mockKeys(h)).toHaveLength(1);
    expect(mockKeys(h)[0]?.expires_at).toBe("2026-12-15T00:00:00Z");
    expect(record(h, bot.id).hash).not.toBe(first);
    expect((await call(h, bot.key)).status).toBe(200);

    h.clock.now = new Date("2026-12-16T00:00:00Z");
    await h.openRouterKeys.sweep();
    expect(mockKeys(h)).toHaveLength(0);
    expect(h.openRouterKeys.forAgent(bot.id)).toBeUndefined();
    expect(h.vault.get(agentKeySecret(bot.id))?.apiKey).toBeUndefined();
  });

  it("are deleted when OpenRouter is taken off the agent, or the feature is turned off", async () => {
    const h = harness();
    const a = h.addAgent("a", {}, { providers: ["openrouter", "openai"] });
    const b = h.addAgent("b", {}, { providers: ["openrouter"] });
    await setUp(h);
    expect(mockKeys(h)).toHaveLength(2);

    await h.admin("PATCH", `/agents/${a.id}`, { providers: ["openai"] });
    await h.openRouterKeys.settle();
    expect(mockKeys(h).map((k) => k.name)).toEqual(["Purser: b"]);

    await h.admin("PUT", "/openrouter/agent-keys", { enabled: false });
    await h.openRouterKeys.settle();
    expect(mockKeys(h)).toHaveLength(0);
    expect(h.vault.get(agentKeySecret(b.id))?.apiKey).toBeUndefined();
    expect((await call(h, b.key)).status).toBe(200);
    expect(lastUpstreamKey(h)).toBe(REAL_OPENROUTER_KEY);
    expect((await h.admin("DELETE", "/openrouter/management-key")).status).toBe(
      200,
    );
  });
});

describe("keeping keys honest", () => {
  it("reads what each key spent, and refuses a key someone deleted until it's replaced", async () => {
    const h = harness();
    const bot = h.addAgent("bot", {}, { providers: ["openrouter"] });
    await setUp(h);
    await call(h, bot.key);
    await h.openRouterKeys.sweep();
    expect(record(h, bot.id).usage).toMatchObject({
      today: OPENROUTER_COST,
      month: OPENROUTER_COST,
    });

    h.upstream.orKeys.clear();
    await h.openRouterKeys.sweep();
    expect(record(h, bot.id)).toMatchObject({ broken: true });
    const view = (await (
      await h.admin("GET", "/openrouter/agent-keys")
    ).json()) as OpenRouterKeysView;
    expect(view.problems).toEqual([
      {
        agentId: bot.id,
        agentName: "bot",
        problem: expect.stringContaining("gone from OpenRouter") as string,
      },
    ]);
    // Never quietly back to the shared key.
    const refused = await call(h, bot.key);
    expect(refused.status).toBe(503);
    expect(refused.headers.get("x-purser-denied")).toBe(
      "agent_key_unavailable",
    );

    const replaced = await h.admin("POST", `/agents/${bot.id}/openrouter-key`);
    expect(replaced.status).toBe(200);
    expect(mockKeys(h)).toHaveLength(1);
    expect((await call(h, bot.key)).status).toBe(200);
    expect(
      (await h.admin("POST", "/agents/agt_nope/openrouter-key")).status,
    ).toBe(404);
  });

  it("leaves a key someone disabled at OpenRouter alone", async () => {
    const h = harness();
    const bot = h.addAgent("bot", {}, { providers: ["openrouter"] });
    await setUp(h);
    const key = mockKeys(h)[0];
    if (key) key.disabled = true;
    await h.openRouterKeys.sweep();
    expect(record(h, bot.id)).toMatchObject({
      broken: true,
      problem: expect.stringContaining("Someone disabled") as string,
    });
    await h.admin("PATCH", `/agents/${bot.id}/limits`, { dailyUsd: 1 });
    await h.openRouterKeys.settle();
    expect(mockKeys(h)[0]).toMatchObject({ disabled: true, limit: null });
  });

  it("retries a rate limit, and shows a failure until a sweep gets through", async () => {
    const h = harness();
    await setUp(h);
    h.upstream.orKeyReplies.push(429);
    h.addAgent("a", {}, { providers: ["openrouter"] });
    await h.openRouterKeys.settle();
    expect(mockKeys(h)).toHaveLength(1);

    h.upstream.orKeyReplies.push(500);
    const b = h.addAgent("b", {}, { providers: ["openrouter"] });
    await h.openRouterKeys.settle();
    const failed = (await (
      await h.admin("GET", `/agents/${b.id}/openrouter-key`)
    ).json()) as { key: unknown; failure: string };
    expect(failed).toMatchObject({
      key: null,
      failure: "OpenRouter answered 500: mock failure",
    });
    expect(h.openRouterKeys.view().problems[0]?.agentName).toBe("b");
    // Until it has a key, the shared one carries its calls.
    expect((await call(h, b.key)).status).toBe(200);
    expect(lastUpstreamKey(h)).toBe(REAL_OPENROUTER_KEY);

    await h.openRouterKeys.sweep();
    expect(h.openRouterKeys.forAgent(b.id)).toBeDefined();
    expect(h.openRouterKeys.view().problems).toEqual([]);

    // A change that fails is shown on the key, and tried again later.
    h.upstream.orKeyReplies.push(500);
    await h.admin("POST", `/agents/${b.id}/kill`);
    await h.openRouterKeys.settle();
    expect(record(h, b.id).problem).toContain("500");
    await h.openRouterKeys.sweep();
    expect(record(h, b.id)).toMatchObject({ disabled: true });
    expect(record(h, b.id).problem).toBeUndefined();
  });

  it("can't make a key for an agent that may not use OpenRouter", async () => {
    const h = harness();
    const other = h.addAgent("other", {}, { providers: ["openai"] });
    await setUp(h);
    expect(
      (await h.admin("POST", `/agents/${other.id}/openrouter-key`)).status,
    ).toBe(409);
  });
});

describe("per-agent keys on disk", () => {
  it("keep the setting and records, with the keys only in the vault", async () => {
    const dir = mkdtempSync(join(tmpdir(), "purser-orkeys-"));
    const h = harness();
    const vault = new Vault(dir);
    vault.set(MANAGEMENT_SECRET, { apiKey: OPENROUTER_MANAGEMENT_KEY });
    const make = () => {
      const keys = new OpenRouterKeys(
        {
          store: h.store,
          vault,
          fetch: (input, init) =>
            Promise.resolve(h.upstream.app.fetch(new Request(input, init))),
          now: () => NOW,
          retryDelaysMs: [0],
        },
        dir,
      );
      keys.useOpenRouter({
        upstream: () => "http://mock/openrouter/api/v1",
        connected: () => true,
      });
      return keys;
    };
    const bot = h.addAgent("bot", {}, { providers: ["openrouter"] });
    const first = make();
    first.setEnabled(true);
    await first.settle();
    const own = vault.get(agentKeySecret(bot.id))?.apiKey as string;
    expect(own).toMatch(/^sk-or-v1-agent/);

    const again = make();
    expect(again.enabled()).toBe(true);
    expect(again.forAgent(bot.id)?.hash).toBe(first.forAgent(bot.id)?.hash);
    expect(again.gatewayKey(bot.id)).toEqual({ key: own });
    expect(
      readFileSync(join(dir, "openrouter-keys.json"), "utf8"),
    ).not.toContain(own);
    expect(new Store().agentCount()).toBe(0);
  });
});
