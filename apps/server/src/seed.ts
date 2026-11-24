import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { hashKey } from "./keys.js";
import { DEFAULT_LOG_SETTINGS, type CallEntry } from "./logs.js";
import { costUsd, findPrice, type PriceTable } from "./pricing.js";
import { BUILTIN_CONNECTORS } from "./connectors.js";
import { DEMO_PROVIDER_KEY } from "./demo-upstream.js";
import { Vault } from "./vault.js";
import { demoCalls } from "./seed-logs.js";
import { generateOrg, type SeedOrg } from "./seed-org.js";
import { writeAtomic } from "./store.js";
import {
  emptyUsage,
  type Agent,
  type AuditEvent,
  type UsageRecord,
} from "./types.js";
import { generateWorkflows, type SeedWorkflows } from "./seed-workflows.js";

export interface SeedOptions {
  agents: number;
  days: number;
  now: Date;
  prices: PriceTable;
  /** Same seed, same data. */
  seed?: number | undefined;
}

export interface SeedResult {
  agents: Agent[];
  usage: UsageRecord[];
  audit: AuditEvent[];
  /** Sample call log entries for the last day, newest first. */
  calls: CallEntry[];
  /** People, departments and requests. */
  org: SeedOrg;
  /** Workflows with a month of results. */
  workflows: SeedWorkflows;
}

/** A small, fast, deterministic random number generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEPARTMENTS = [
  "Finance",
  "Customer Support",
  "Sales",
  "Marketing",
  "Engineering",
  "Legal",
  "HR",
  "Operations",
  "Procurement",
  "Data",
];
const REGIONS = ["Americas", "EMEA", "APAC", "Platform"];

const FIRST = [
  "Avery",
  "Blake",
  "Casey",
  "Dana",
  "Eli",
  "Farah",
  "Gus",
  "Hana",
  "Ivan",
  "Jo",
  "Kai",
  "Lena",
  "Malik",
  "Nora",
  "Omar",
  "Priya",
  "Quinn",
  "Rosa",
  "Sam",
  "Tariq",
  "Uma",
  "Vera",
  "Wes",
  "Ximena",
  "Yuki",
  "Zane",
  "Ana",
  "Ben",
  "Chloe",
  "Dev",
];
const LAST = [
  "Ortiz",
  "Lee",
  "Nguyen",
  "Okafor",
  "Schmidt",
  "Rossi",
  "Kowalski",
  "Haddad",
  "Silva",
  "Tanaka",
];

/** What each kind of agent does, with the models and connectors it tends to use. */
/**
 * Each seeded usage record stands for a batch of this many similar calls, so the
 * demo shows realistic spend without writing millions of records.
 */
const BATCH = 10;

const KINDS: {
  slug: string;
  purpose: string;
  dept: string;
  calls: number;
  tokens: [number, number];
}[] = [
  {
    slug: "invoice-reader",
    purpose: "Reads supplier invoices into the ledger",
    dept: "Finance",
    calls: 40,
    tokens: [3000, 400],
  },
  {
    slug: "expense-checker",
    purpose: "Flags out-of-policy expense claims",
    dept: "Finance",
    calls: 25,
    tokens: [1500, 200],
  },
  {
    slug: "ticket-triage",
    purpose: "Sorts and tags incoming support tickets",
    dept: "Customer Support",
    calls: 120,
    tokens: [900, 120],
  },
  {
    slug: "reply-drafter",
    purpose: "Drafts first replies to customers",
    dept: "Customer Support",
    calls: 80,
    tokens: [2500, 600],
  },
  {
    slug: "lead-research",
    purpose: "Researches inbound leads before calls",
    dept: "Sales",
    calls: 30,
    tokens: [6000, 900],
  },
  {
    slug: "proposal-writer",
    purpose: "Drafts proposals from call notes",
    dept: "Sales",
    calls: 8,
    tokens: [12000, 3000],
  },
  {
    slug: "campaign-copy",
    purpose: "Writes ad and email variants",
    dept: "Marketing",
    calls: 20,
    tokens: [2000, 1200],
  },
  {
    slug: "code-review",
    purpose: "Reviews pull requests",
    dept: "Engineering",
    calls: 60,
    tokens: [15000, 1500],
  },
  {
    slug: "test-writer",
    purpose: "Writes unit tests for new code",
    dept: "Engineering",
    calls: 35,
    tokens: [9000, 2500],
  },
  {
    slug: "contract-redliner",
    purpose: "Marks up vendor contracts against the playbook",
    dept: "Legal",
    calls: 6,
    tokens: [30000, 4000],
  },
  {
    slug: "policy-qa",
    purpose: "Answers staff questions about HR policy",
    dept: "HR",
    calls: 45,
    tokens: [4000, 300],
  },
  {
    slug: "shift-planner",
    purpose: "Plans rotas from demand forecasts",
    dept: "Operations",
    calls: 10,
    tokens: [5000, 800],
  },
  {
    slug: "rfp-summarizer",
    purpose: "Summarises supplier RFP responses",
    dept: "Procurement",
    calls: 12,
    tokens: [20000, 1500],
  },
  {
    slug: "sql-helper",
    purpose: "Turns questions into SQL for analysts",
    dept: "Data",
    calls: 50,
    tokens: [2500, 400],
  },
  {
    slug: "doc-embedder",
    purpose: "Indexes internal documents for search",
    dept: "Data",
    calls: 200,
    tokens: [800, 0],
  },
];

/** Connectors and the priced models agents use through them. */
const PROVIDERS: { id: string; weight: number; models: string[] }[] = [
  {
    id: "openai",
    weight: 35,
    models: ["gpt-4o-mini", "gpt-5-mini", "gpt-5.1", "gpt-4.1-mini"],
  },
  {
    id: "anthropic",
    weight: 30,
    models: ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-sonnet-5"],
  },
  {
    id: "openrouter",
    weight: 15,
    models: ["openai/gpt-4o-mini", "anthropic/claude-sonnet-4.5"],
  },
  { id: "azure-openai", weight: 15, models: ["gpt-4o-mini", "gpt-4.1"] },
  { id: "gemini", weight: 5, models: ["gemini-3.8-flash"] },
];

const pick = <T>(r: () => number, items: readonly T[]): T =>
  items[Math.floor(r() * items.length)] as T;

function weighted<T extends { weight: number }>(
  r: () => number,
  items: T[],
): T {
  const total = items.reduce((n, i) => n + i.weight, 0);
  let x = r() * total;
  for (const item of items) {
    x -= item.weight;
    if (x < 0) return item;
  }
  return items[items.length - 1] as T;
}

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Builds a believable fleet: agents across about 40 teams and 300 owners,
 * on several connectors, with usage history, some paused, some at their
 * limit, some past their end date, and keys at every stage of their life.
 * Agents get unusable keys: this is data to look at, not to call with.
 */
export function generateSeed(options: SeedOptions): SeedResult {
  const r = rng(options.seed ?? 20261107);
  const now = options.now.getTime();
  const todayStart = Date.UTC(
    options.now.getUTCFullYear(),
    options.now.getUTCMonth(),
    options.now.getUTCDate(),
  );
  const teams = DEPARTMENTS.flatMap((d) => REGIONS.map((reg) => `${d} ${reg}`));
  const owners: string[] = [];
  for (const f of FIRST) for (const l of LAST) owners.push(`${f} ${l}`);

  const agents: Agent[] = [];
  const usage: UsageRecord[] = [];
  const audit: AuditEvent[] = [];
  const counters = new Map<string, number>();
  let seq = 0;

  for (let i = 0; i < options.agents; i++) {
    const kind = pick(r, KINDS);
    const n = (counters.get(kind.slug) ?? 0) + 1;
    counters.set(kind.slug, n);
    const team = `${kind.dept} ${pick(r, REGIONS)}`;
    const owner = pick(r, owners);
    const provider = weighted(r, PROVIDERS);
    const model = pick(r, provider.models);
    const id = `agt_demo${String(i).padStart(5, "0")}`;
    const created = now - Math.floor((options.days + r() * 120) * DAY);
    const scale = 0.3 + r() * 1.7;
    const dailyCalls = Math.max(1, Math.round((kind.calls / 10) * scale));
    const price = findPrice(
      options.prices,
      provider.id === "openrouter"
        ? model.slice(model.indexOf("/") + 1).replace(/(\d)\.(\d)/g, "$1-$2")
        : model,
      kind.tokens[0],
    );
    const perCall = costUsd(
      {
        ...emptyUsage(),
        inputTokens: kind.tokens[0] * BATCH,
        outputTokens: kind.tokens[1] * BATCH,
      },
      price.rates,
    );
    const typicalDay = perCall * dailyCalls;
    const roll = r();
    // A healthy fleet: a few percent can't run at any moment.
    const atLimit = roll < 0.01;
    const paused = roll >= 0.01 && roll < 0.025;
    const expired = roll >= 0.025 && roll < 0.03;
    const hasPolicy = r() < 0.8;
    // Keys up to 91 days old on a 90-day schedule: about 1% have lapsed.
    const keyAgeDays = Math.floor(r() * 92);
    const keyRotatedAt = now - keyAgeDays * DAY;
    // Most agents rotate every 90 days, so their key's age sets how close it is to expiring.
    const keyExpiresAt = hasPolicy ? keyRotatedAt + 90 * DAY : undefined;

    const agent: Agent = {
      id,
      name: `${kind.slug}-${String(n).padStart(3, "0")}`,
      owner,
      team: teams.includes(team) ? team : pick(r, teams),
      purpose: kind.purpose,
      providers: r() < 0.7 ? [provider.id] : undefined,
      keyHash: hashKey(`demo-unusable-${id}-${options.seed ?? 0}`),
      keyHint: `purser_${id.slice(-2)}...demo`,
      keyRotatedAt: iso(keyRotatedAt),
      keyExpiresAt: keyExpiresAt === undefined ? undefined : iso(keyExpiresAt),
      rotation: hasPolicy ? { everyDays: 90, graceDays: 7 } : undefined,
      status: paused ? "paused" : "active",
      limits: {
        dailyUsd: round2(
          atLimit ? typicalDay * 0.8 : typicalDay * (2 + r() * 3),
        ),
        monthlyUsd: round2(typicalDay * 30 * (1.5 + r())),
      },
      createdAt: iso(created),
      endsAt: expired
        ? iso(now - Math.floor(1 + r() * 20) * DAY)
        : r() < 0.3
          ? iso(now + Math.floor(30 + r() * 300) * DAY)
          : undefined,
      pausedAt: paused
        ? iso(now - Math.floor(r() * 10) * DAY - 3_600_000)
        : undefined,
      pausedBy: paused ? owner : undefined,
    };
    agents.push(agent);
    audit.push({
      at: agent.createdAt,
      type: "agent.created",
      agentId: id,
      detail: { name: agent.name, owner, team: agent.team },
    });

    // Usage: every day of the history, plus today up to now.
    const lastDay = expired && agent.endsAt ? Date.parse(agent.endsAt) : now;
    const stopAt =
      paused && agent.pausedAt ? Date.parse(agent.pausedAt) : lastDay;
    for (let d = options.days - 1; d >= 0; d--) {
      const dayStart = todayStart - d * DAY;
      if (dayStart < created) continue;
      const span = d === 0 ? Math.max(1, now - todayStart) : DAY;
      const weekend = [0, 6].includes(new Date(dayStart).getUTCDay());
      let calls = Math.round(dailyCalls * (weekend ? 0.3 : 1) * (0.5 + r()));
      if (d === 0)
        calls = Math.round(calls * (span / DAY)) + (atLimit ? dailyCalls : 0);
      let spentToday = 0;
      for (let c = 0; c < calls; c++) {
        const at = dayStart + Math.floor(r() * span);
        if (at > stopAt || at > now) continue;
        const tokens = emptyUsage();
        tokens.inputTokens = Math.round(
          kind.tokens[0] * BATCH * (0.4 + r() * 1.2),
        );
        tokens.outputTokens = Math.round(
          kind.tokens[1] * BATCH * (0.4 + r() * 1.2),
        );
        const cost = costUsd(tokens, price.rates);
        if (
          d === 0 &&
          agent.limits.dailyUsd !== undefined &&
          spentToday >= agent.limits.dailyUsd
        )
          break;
        spentToday += cost;
        usage.push({
          id: `use_demo${(seq++).toString(36)}`,
          agentId: id,
          provider: provider.id,
          endpoint:
            kind.slug === "doc-embedder"
              ? "embeddings"
              : provider.id === "anthropic"
                ? "messages"
                : "chat.completions",
          model,
          at: iso(at),
          ...tokens,
          costUsd: cost,
          priced: price.matched === null ? "fallback" : "table",
          status: 200,
          durationMs: Math.round(400 + r() * 6000),
          outcome: "complete",
          key: "current",
        });
      }
    }
    if (paused && agent.pausedAt) {
      audit.push({
        at: agent.pausedAt,
        type: "agent.paused",
        agentId: id,
        detail: { by: owner, abortedRequests: 0, elapsedMs: 0.4 },
      });
    }
    if (keyAgeDays < options.days) {
      audit.push({
        at: iso(keyRotatedAt),
        type: "agent.key_rotated",
        agentId: id,
        detail: { by: owner, graceMinutes: hasPolicy ? 7 * 1440 : 0 },
      });
    }
  }

  usage.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const org = generateOrg(agents, usage, options.now, r);
  audit.push(...org.audit);
  const workflows = generateWorkflows(agents, options.now, r);
  audit.push(...workflows.audit);
  audit.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const calls = demoCalls(agents, usage, options.now, 1500);
  return { agents, usage, audit, calls, org, workflows };
}

const round2 = (n: number) => Math.max(0.01, Math.round(n * 100) / 100);

/**
 * Writes a seed into a data directory. Refuses to touch one that already has
 * agents, unless `force` is set, so real data is never overwritten by accident.
 */
const DEMO_KEY_AGES: Partial<Record<string, number>> = {
  openai: 140,
  anthropic: 96,
  openrouter: 12,
  xai: 3,
};

export function writeSeed(
  dataDir: string,
  seed: SeedResult,
  force: boolean,
): void {
  const agentsFile = join(dataDir, "agents.json");
  if (!force && existsSync(agentsFile)) {
    const existing = JSON.parse(readFileSync(agentsFile, "utf8")) as unknown[];
    if (existing.length > 0) {
      throw new Error(
        `${dataDir} already has ${existing.length} agents. Use a separate directory (PURSER_DATA_DIR=~/.purser-demo) or pass --force to replace them.`,
      );
    }
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeAtomic(agentsFile, JSON.stringify(seed.agents, null, 2));
  const lines = (rows: unknown[]) =>
    rows.length === 0
      ? ""
      : `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
  writeFileSync(join(dataDir, "usage.jsonl"), lines(seed.usage), {
    mode: 0o600,
  });
  writeFileSync(join(dataDir, "audit.jsonl"), lines(seed.audit), {
    mode: 0o600,
  });
  const { audit: _audit, ...org } = seed.org;
  writeAtomic(join(dataDir, "org.json"), JSON.stringify(org, null, 2));
  writeAtomic(
    join(dataDir, "workflows.json"),
    JSON.stringify(seed.workflows.workflows, null, 2),
  );
  writeFileSync(
    join(dataDir, "outcomes.jsonl"),
    lines(seed.workflows.outcomes),
    { mode: 0o600 },
  );
  // The demo turns the call log on, with a day of sample calls in it.
  const logsDir = join(dataDir, "logs");
  rmSync(logsDir, { recursive: true, force: true });
  mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  const byDay = new Map<string, CallEntry[]>();
  for (const call of [...seed.calls].reverse()) {
    const day = call.at.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), call]);
  }
  for (const [day, calls] of byDay) {
    writeFileSync(join(logsDir, `${day}.jsonl`), lines(calls), { mode: 0o600 });
  }
  // Every connector gets the demo key, so the demo works with no provider
  // account. A key already saved here is left alone.
  const vault = new Vault(dataDir);
  const daysAgo = (days: number) =>
    new Date(Date.now() - days * 86_400_000).toISOString();
  for (const connector of BUILTIN_CONNECTORS) {
    if (!connector.needsUpstream && !vault.get(connector.id)?.apiKey) {
      vault.set(connector.id, {
        apiKey: DEMO_PROVIDER_KEY,
        // Keys of different ages, and one replaced key left to delete, so the
        // Security page has something to show.
        updatedAt: daysAgo(DEMO_KEY_AGES[connector.id] ?? 45),
        ...(connector.id === "xai"
          ? { oldKeys: [{ hint: "xai-...7Qm2", replacedAt: daysAgo(3) }] }
          : {}),
      });
    }
  }
  writeAtomic(
    join(dataDir, "settings.json"),
    JSON.stringify(
      { logging: { ...DEFAULT_LOG_SETTINGS, mode: "all" } },
      null,
      2,
    ),
  );
}
