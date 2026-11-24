import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "./org.js";
import { DEFAULT_PRICES } from "./prices.js";
import { auditPage, listAgents, overview } from "./queries.js";
import { DEMO_PROVIDER_KEY } from "./demo-upstream.js";
import { Vault } from "./vault.js";
import { generateSeed, rng, writeSeed } from "./seed.js";
import { Store } from "./store.js";
import { harness } from "./test/helpers.js";
import {
  emptyUsage,
  type Agent,
  type PublicAgent,
  type UsageRecord,
} from "./types.js";

const NOW = new Date("2026-11-07T12:00:00Z");

function bigStore(agents: number, records: number): Store {
  const store = new Store();
  const teams = Array.from({ length: 40 }, (_, i) => `Team ${i}`);
  for (let i = 0; i < agents; i++) {
    const agent: Agent = {
      id: `agt_${i}`,
      name: `agent-${String(i).padStart(5, "0")}`,
      owner: `Owner ${i % 300}`,
      team: teams[i % 40],
      keyHash: `hash${i}`,
      keyHint: "purser_xx...xxxx",
      status: i % 20 === 0 ? "paused" : "active",
      limits: { dailyUsd: 5 },
      createdAt: "2026-10-01T00:00:00.000Z",
      providers: i % 2 === 0 ? ["openai"] : undefined,
    };
    store.createAgent(agent);
  }
  const base: UsageRecord = {
    ...emptyUsage(),
    id: "",
    agentId: "",
    provider: "openai",
    endpoint: "chat.completions",
    model: "gpt-4o-mini",
    at: "",
    costUsd: 0.001,
    priced: "table",
    status: 200,
    durationMs: 100,
    outcome: "complete",
  };
  for (let i = 0; i < records; i++) {
    const day = 7 - (i % 7);
    store.recordUsage({
      ...base,
      id: `u${i}`,
      agentId: `agt_${i % agents}`,
      at: `2026-11-0${day}T0${i % 10}:00:00.000Z`,
    });
  }
  return store;
}

/**
 * Times a call several times and returns the fastest run. One slow run on a
 * busy CI machine or a garbage collection pause shouldn't fail the test, but a
 * real slowdown makes every run slow.
 */
function fastest<T>(fn: () => T, runs = 3): { ms: number; result: T } {
  let ms = Infinity;
  let result = fn();
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    result = fn();
    ms = Math.min(ms, performance.now() - t0);
  }
  return { ms, result };
}

describe("at enterprise scale", () => {
  it("lists a page of 10,000 agents with 1,000,000 usage records in well under 100 ms", () => {
    const store = bigStore(10_000, 1_000_000);
    const timings: number[] = [];
    for (const query of [
      {},
      { sort: "spend_today" as const, pageSize: 200 },
      { q: "team 3", state: "running" as const },
      { provider: "openai", sort: "last_used" as const, page: 3 },
      { owner: "Owner 7" },
    ]) {
      const { ms, result: page } = fastest(() => listAgents(store, NOW, query));
      timings.push(ms);
      expect(page.items.length).toBeGreaterThan(0);
    }
    expect(Math.max(...timings)).toBeLessThan(100);
    const { ms, result: o } = fastest(() =>
      overview(store, NOW, { configured: 1, total: 9 }),
    );
    expect(ms).toBeLessThan(100);
    expect(o.agents.total).toBe(10_000);
    expect(o.requests.today).toBeGreaterThan(0);
  }, 60_000);

  it("filters, sorts, pages and returns facets", () => {
    const store = bigStore(500, 2_000);
    const first = listAgents(store, NOW, { pageSize: 10 });
    expect(first).toMatchObject({ total: 500, page: 1, pageSize: 10 });
    expect(first.items[0]?.name).toBe("agent-00000");
    expect(first.facets.teams).toHaveLength(40);
    expect(first.facets.owners).toHaveLength(300);
    expect(first.facets.providers).toEqual(["openai"]);
    const desc = listAgents(store, NOW, { pageSize: 10, dir: "desc" });
    expect(desc.items[0]?.name).toBe("agent-00499");
    const last = listAgents(store, NOW, { pageSize: 200, page: 3 });
    expect(last.items).toHaveLength(100);
    expect(listAgents(store, NOW, { pageSize: 9999 }).pageSize).toBe(200);
    expect(listAgents(store, NOW, { team: "Team 1" }).total).toBe(13);
    expect(listAgents(store, NOW, { state: "paused" }).total).toBe(25);
    expect(listAgents(store, NOW, { q: "AGT_49" }).total).toBe(11);
    const bySpend = listAgents(store, NOW, { sort: "spend_month" });
    const spends = bySpend.items.map((a: PublicAgent) => a.spend.month);
    expect([...spends].sort((a, b) => b - a)).toEqual(spends);
    expect(
      listAgents(store, NOW, { sort: "created", dir: "asc" }).items,
    ).toHaveLength(50);
  });
});

describe("agent usage over time", () => {
  it("returns a zero-filled daily series and the newest records", async () => {
    const h = harness();
    const { key } = h.addAgent();
    for (const day of [
      "2026-11-05T10:00:00Z",
      "2026-11-07T10:00:00Z",
      "2026-11-07T11:00:00Z",
    ]) {
      h.clock.now = new Date(day);
      await h.call("/openai/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4o-mini", messages: [] }),
        key,
      });
    }
    h.clock.now = NOW;
    const res = (await (
      await h.admin("GET", "/agents/support-bot/usage?days=3")
    ).json()) as {
      daily: { date: string; requests: number; costUsd: number }[];
      recent: { at: string }[];
    };
    expect(res.daily.map((d) => [d.date, d.requests])).toEqual([
      ["2026-11-05", 1],
      ["2026-11-06", 0],
      ["2026-11-07", 2],
    ]);
    expect(res.recent.map((r) => r.at)).toEqual([
      "2026-11-07T11:00:00.000Z",
      "2026-11-07T10:00:00.000Z",
      "2026-11-05T10:00:00.000Z",
    ]);
    expect(
      (await h.admin("GET", "/agents/support-bot/usage?days=0")).status,
    ).toBe(400);
    expect((await h.admin("GET", "/agents/ghost/usage")).status).toBe(404);
  });

  it("limits the usage log and the overview's top spenders", async () => {
    const h = harness();
    const a = h.addAgent("a");
    for (let i = 0; i < 3; i++) {
      await h.call("/openai/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4o-mini", messages: [] }),
        key: a.key,
      });
    }
    const one = (await (await h.admin("GET", "/usage?limit=1")).json()) as {
      usage: unknown[];
    };
    expect(one.usage).toHaveLength(1);
    const o = (await (await h.admin("GET", "/overview")).json()) as {
      topToday: PublicAgent[];
      spend: { today: number };
      providers: { configured: number; total: number };
    };
    expect(o.topToday.map((t) => t.name)).toEqual(["a"]);
    expect(o.spend.today).toBeGreaterThan(0);
    expect(o.providers).toEqual({ configured: 3, total: 9 });
    expect((await h.admin("GET", "/agents?pageSize=0")).status).toBe(400);
  });
});

describe("audit pages", () => {
  it("pages newest first with a cursor, by agent or before a time", async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) {
      h.clock.now = new Date(Date.UTC(2026, 10, 7, 12, i));
      h.addAgent(`a${i}`);
    }
    const first = (await (await h.admin("GET", "/audit?limit=2")).json()) as {
      items: { detail: { name: string } }[];
      next: string;
    };
    expect(first.items.map((e) => e.detail.name)).toEqual(["a4", "a3"]);
    const second = (await (
      await h.admin("GET", `/audit?limit=2&before=${first.next}`)
    ).json()) as { items: { detail: { name: string } }[]; next: string };
    expect(second.items.map((e) => e.detail.name)).toEqual(["a2", "a1"]);
    const third = (await (
      await h.admin("GET", `/audit?limit=2&before=${second.next}`)
    ).json()) as { items: unknown[]; next?: string };
    expect(third.items).toHaveLength(1);
    expect(third.next).toBeUndefined();
    const byTime = auditPage(h.store, { before: "2026-11-07T12:02:00.000Z" });
    expect(byTime.items).toHaveLength(2);
    const byAgent = (await (
      await h.admin("GET", "/audit?agent=a1")
    ).json()) as {
      items: unknown[];
    };
    expect(byAgent.items).toHaveLength(1);
    expect((await h.admin("GET", "/audit?agent=ghost")).status).toBe(404);
    expect(auditPage(h.store, { agentId: "none" }).items).toEqual([]);
  });
});

describe("demo seed", () => {
  it("is deterministic and believable", () => {
    const a = generateSeed({
      agents: 1000,
      days: 14,
      now: NOW,
      prices: DEFAULT_PRICES,
      seed: 7,
    });
    const b = generateSeed({
      agents: 1000,
      days: 14,
      now: NOW,
      prices: DEFAULT_PRICES,
      seed: 7,
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.agents).toHaveLength(1000);
    expect(new Set(a.agents.map((x) => x.name)).size).toBe(1000);
    expect(a.usage.length).toBeGreaterThan(1000);
    const store = new Store();
    for (const agent of a.agents) store.createAgent(agent);
    for (const u of a.usage) store.recordUsage(u);
    const o = overview(store, NOW, { configured: 0, total: 9 });
    expect(o.agents.paused).toBeGreaterThan(0);
    expect(o.agents.atLimit).toBeGreaterThan(0);
    expect(o.agents.expired).toBeGreaterThan(0);
    expect(o.agents.keyExpired).toBeGreaterThan(0);
    // A healthy fleet: only a few percent can't run.
    expect(o.agents.running / o.agents.total).toBeGreaterThan(0.93);
    expect(o.keys.expiring).toBeGreaterThan(0);
    expect(o.keys.expired).toBeGreaterThan(0);
    const withPolicy = a.agents.filter((x) => x.rotation?.everyDays === 90);
    expect(withPolicy.length / a.agents.length).toBeGreaterThan(0.6);
    expect(rng(1)()).toBe(rng(1)());
    // A day of sample calls in the call log, each tied to its usage record.
    expect(a.calls.length).toBeGreaterThan(50);
    const logged = new Set(a.usage.filter((u) => u.logged).map((u) => u.id));
    expect(a.calls.every((c) => logged.has(c.id))).toBe(true);
    expect(a.calls[0]?.requestPreview).not.toBe("");
    // Every owner is a person; every department has a manager; work is waiting.
    const emails = new Set(a.org.people.map((p) => p.email));
    expect(
      a.agents.every((x) => x.ownerEmail && emails.has(x.ownerEmail)),
    ).toBe(true);
    const teams = new Set(a.agents.map((x) => x.team));
    for (const team of teams) {
      expect(a.org.people.some((p) => p.manages?.includes(team ?? ""))).toBe(
        true,
      );
    }
    expect(a.org.people.filter((p) => p.role === "admin")).toHaveLength(2);
    expect(a.org.requests.some((x) => x.status === "pending")).toBe(true);
    const leaver = a.org.people.find((p) => p.status === "disabled");
    expect(
      a.agents
        .filter((x) => x.ownerEmail === leaver?.email)
        .every((x) => x.status === "paused"),
    ).toBe(true);
  });

  it("refuses to overwrite real agents unless forced", () => {
    const dir = mkdtempSync(join(tmpdir(), "purser-seed-"));
    const seed = generateSeed({
      agents: 5,
      days: 2,
      now: NOW,
      prices: DEFAULT_PRICES,
    });
    writeSeed(dir, seed, false);
    expect(statSync(join(dir, "usage.jsonl")).mode & 0o077).toBe(0);
    expect(
      (
        JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as {
          logging: { mode: string };
        }
      ).logging.mode,
    ).toBe("all");
    // Every connector gets the demo key, and a real one is never replaced.
    const vault = new Vault(dir);
    expect(vault.get("openai")?.apiKey).toBe(DEMO_PROVIDER_KEY);
    // Keys of different ages, and an old one left to delete, for the Security page.
    expect(Date.parse(vault.get("openai")?.updatedAt ?? "")).toBeLessThan(
      Date.now() - 90 * 86_400_000,
    );
    expect(vault.get("xai")?.oldKeys).toHaveLength(1);
    expect(vault.get("azure-openai")).toBeUndefined();
    vault.set("openai", { apiKey: "sk-real" });
    expect(() => writeSeed(dir, seed, false)).toThrow(/already has 5 agents/);
    writeSeed(
      dir,
      {
        agents: [],
        usage: [],
        audit: [],
        calls: [],
        workflows: { workflows: [], outcomes: [], audit: [] },
        org: {
          people: [],
          departments: [],
          requests: [],
          settings: { selfService: true, defaults: DEFAULT_POLICY },
          audit: [],
        },
      },
      true,
    );
    writeSeed(dir, seed, false);
    const loaded = new Store(dir);
    expect(loaded.agentCount()).toBe(5);
    expect(new Vault(dir).get("openai")?.apiKey).toBe("sk-real");
  });
});

describe("store files", () => {
  it("skips a torn line and writes agents once per batch", () => {
    const dir = mkdtempSync(join(tmpdir(), "purser-store-"));
    const store = new Store(dir);
    const h = harness({ store });
    h.addAgent("a");
    h.addAgent("b");
    appendFileSync(join(dir, "audit.jsonl"), '{"at":"torn');
    writeFileSync(join(dir, "usage.jsonl"), "\n");
    const reloaded = new Store(dir);
    expect(reloaded.agentCount()).toBe(2);
    expect(reloaded.listAudit()).toHaveLength(2);
    store.batch(() => {
      store.updateAgent(store.listAgents()[0]?.id ?? "", { owner: "x" });
      store.batch(() =>
        store.updateAgent(store.listAgents()[1]?.id ?? "", { owner: "y" }),
      );
      // Nothing written until the outer batch ends.
      expect(readFileSync(join(dir, "agents.json"), "utf8")).not.toContain(
        '"x"',
      );
    });
    expect(readFileSync(join(dir, "agents.json"), "utf8")).toContain('"y"');
    expect(statSync(join(dir, "agents.json")).mode & 0o077).toBe(0);
    expect(() => store.updateAgent("ghost", {})).toThrow(/No agent/);
    expect(() =>
      store.createAgent({ ...(store.listAgents()[0] as Agent) }),
    ).toThrow(/already exists/);
  });
});

describe("the demo's agent accounts", () => {
  it("has a coding agent with a second service, and agents asking for one", () => {
    const seed = generateSeed({
      agents: 400,
      days: 2,
      now: NOW,
      prices: DEFAULT_PRICES,
    });
    const partner = seed.agents.find((a) => a.name === "code-review-partner");
    expect(partner?.providers).toEqual(["anthropic", "openai"]);
    expect(partner?.serviceLimits?.openai?.dailyUsd).toBe(2);
    const asks = seed.org.requests.filter((r) => r.kind === "service");
    expect(asks.length).toBeGreaterThan(0);
    expect(asks.every((r) => r.askedByAgent && r.status === "pending")).toBe(
      true,
    );
    expect(asks.some((r) => r.ownerMayDecide)).toBe(true);
    expect(asks.some((r) => !r.ownerMayDecide)).toBe(true);
    for (const r of asks) {
      const agent = seed.agents.find((a) => a.id === r.service?.agentId);
      expect(agent?.ownerEmail).toBe(r.by);
    }
  });
});
