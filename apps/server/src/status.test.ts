import { describe, expect, it } from "vitest";
import { listAgents, overview, statusBoard } from "./queries.js";
import { Store } from "./store.js";
import { emptyUsage, type Agent, type UsageRecord } from "./types.js";

const NOW = new Date("2026-11-08T12:00:00Z");
const NAMES = new Map([
  ["openai", "OpenAI"],
  ["openrouter", "OpenRouter"],
  ["anthropic", "Anthropic"],
]);

function agent(id: string, extra: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
    owner: "Ana Silva",
    team: "Finance EMEA",
    keyHash: `hash-${id}`,
    keyHint: "purser_xx...xxxx",
    status: "active",
    limits: {},
    createdAt: "2026-10-01T00:00:00.000Z",
    ...extra,
  };
}

function usage(agentId: string, provider: string, costUsd = 0.01): UsageRecord {
  return {
    ...emptyUsage(),
    id: `${agentId}-${provider}-${costUsd}`,
    agentId,
    provider,
    endpoint: "chat.completions",
    model: "m",
    at: "2026-11-08T11:00:00.000Z",
    costUsd,
    priced: "table",
    status: 200,
    durationMs: 10,
    outcome: "complete",
  };
}

/** One agent in each state, plus a spread of owners, teams and providers. */
function fleet(): Store {
  const store = new Store();
  store.createAgent(
    agent("invoice-bot", { owner: "Ana Silva", providers: ["openrouter"] }),
  );
  store.createAgent(
    agent("hr-helper", {
      owner: "Ben Okafor",
      team: "People AMER",
      status: "paused",
      pausedAt: "2026-11-08T09:00:00.000Z",
      pausedBy: "admin",
    }),
  );
  store.createAgent(
    agent("old-pilot", {
      owner: "Chen Wei",
      team: "Sales APAC",
      endsAt: "2026-11-01T00:00:00.000Z",
    }),
  );
  store.createAgent(
    agent("lapsed-key", {
      owner: "Dev Cruz",
      team: "Sales APAC",
      keyExpiresAt: "2026-11-05T00:00:00.000Z",
    }),
  );
  store.createAgent(
    agent("big-spender", {
      owner: "Ana Silva",
      team: "Legal EMEA",
      limits: { dailyUsd: 0.01 },
    }),
  );
  store.recordUsage(usage("big-spender", "anthropic", 0.02));
  store.recordUsage(usage("invoice-bot", "openai"));
  return store;
}

describe("agent state", () => {
  it("counts a lapsed key as a reason the agent can't run", () => {
    const page = listAgents(fleet(), NOW, { pageSize: 50 });
    const state = Object.fromEntries(page.items.map((a) => [a.id, a.state]));
    expect(state).toEqual({
      "big-spender": "at_limit",
      "hr-helper": "paused",
      "invoice-bot": "running",
      "lapsed-key": "key_expired",
      "old-pilot": "expired",
    });
    const o = overview(fleet(), NOW, { configured: 1, total: 9 });
    expect(o.agents).toEqual({
      total: 5,
      running: 1,
      paused: 1,
      atLimit: 1,
      expired: 1,
      keyExpired: 1,
    });
  });

  it("filters to every agent that can't run", () => {
    const page = listAgents(fleet(), NOW, { state: "not_running" });
    expect(page.items.map((a) => a.id)).toEqual([
      "big-spender",
      "hr-helper",
      "lapsed-key",
      "old-pilot",
    ]);
    expect(listAgents(fleet(), NOW, { state: "key_expired" }).total).toBe(1);
    const light = (l: "green" | "yellow" | "red") =>
      listAgents(fleet(), NOW, { light: l }).items.map((a) => a.id);
    expect(light("green")).toEqual(["invoice-bot"]);
    expect(light("yellow")).toEqual(["big-spender"]);
    expect(light("red")).toEqual(["hr-helper", "lapsed-key", "old-pilot"]);
  });
});

describe("search", () => {
  const ids = (q: string, field?: "name" | "owner" | "team" | "provider") =>
    listAgents(fleet(), NOW, { q, in: field }, NAMES).items.map((a) => a.id);

  it("matches name, owner, department and provider by default", () => {
    expect(ids("invoice")).toEqual(["invoice-bot"]);
    expect(ids("okafor")).toEqual(["hr-helper"]);
    expect(ids("apac")).toEqual(["lapsed-key", "old-pilot"]);
    // By connector id, by display name, allowed or only used.
    expect(ids("openrouter")).toEqual(["invoice-bot"]);
    expect(ids("anthropic")).toEqual(["big-spender"]);
    expect(ids("openai")).toEqual(["invoice-bot"]);
  });

  it("needs every word to match", () => {
    expect(ids("ana emea")).toEqual(["big-spender", "invoice-bot"]);
    expect(ids("ana legal")).toEqual(["big-spender"]);
    expect(ids("ana   openrouter  ")).toEqual(["invoice-bot"]);
    expect(ids("ana sales")).toEqual([]);
  });

  it("can be narrowed to one field", () => {
    // "sales" is a department, so a name search finds nothing.
    expect(ids("sales", "name")).toEqual([]);
    expect(ids("sales", "team")).toEqual(["lapsed-key", "old-pilot"]);
    expect(ids("ana", "owner")).toEqual(["big-spender", "invoice-bot"]);
    expect(ids("ana", "team")).toEqual([]);
    expect(ids("router", "provider")).toEqual(["invoice-bot"]);
    expect(ids("invoice", "provider")).toEqual([]);
  });
});

describe("status board", () => {
  it("lists the agents that can't run, most recently stopped first", () => {
    const board = statusBoard(fleet(), NOW, 100);
    expect(board).toMatchObject({
      total: 5,
      running: 1,
      notRunning: 4,
      atLimit: 1,
    });
    expect(board.stopped.map((s) => [s.id, s.state, s.since, s.by])).toEqual([
      ["big-spender", "at_limit", "2026-11-08T11:00:00.000Z", undefined],
      ["hr-helper", "paused", "2026-11-08T09:00:00.000Z", "admin"],
      ["lapsed-key", "key_expired", "2026-11-05T00:00:00.000Z", undefined],
      ["old-pilot", "expired", "2026-11-01T00:00:00.000Z", undefined],
    ]);
  });

  it("caps the list but still counts them all", () => {
    const board = statusBoard(fleet(), NOW, 2);
    expect(board.notRunning).toBe(4);
    expect(board.stopped).toHaveLength(2);
    expect(statusBoard(fleet(), NOW, -5).stopped).toHaveLength(0);
  });

  it("is all green for a healthy fleet", () => {
    const store = new Store();
    store.createAgent(agent("a"));
    store.createAgent(agent("b"));
    expect(statusBoard(store, NOW, 100)).toEqual({
      total: 2,
      running: 2,
      notRunning: 0,
      atLimit: 0,
      stopped: [],
    });
  });
});
