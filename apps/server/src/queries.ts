import { agentState, keyState, toPublic } from "./control.js";
import type { Store } from "./store.js";
import type {
  Agent,
  AgentState,
  AuditEvent,
  KeyState,
  PublicAgent,
  UsageRecord,
} from "./types.js";

export type AgentSort =
  | "name"
  | "spend_today"
  | "spend_month"
  | "created"
  | "last_used"
  | "key_expires";

/** Which fields the search text is matched against. */
export type SearchField = "all" | "name" | "owner" | "team" | "provider";

/** A state, or every state but "running". */
export type StateFilter = AgentState | "not_running";

/**
 * The light the web UI shows. Green can make calls. Yellow hit a spending
 * limit, which a one-time raise can clear. Red was stopped, ended or has a
 * lapsed key.
 */
export type Light = "green" | "yellow" | "red";

export function lightOf(state: AgentState): Light {
  if (state === "running") return "green";
  return state === "at_limit" ? "yellow" : "red";
}

export interface AgentQuery {
  q?: string | undefined;
  /** Narrows the search text to one field. Default: all of them. */
  in?: SearchField | undefined;
  state?: StateFilter | undefined;
  light?: Light | undefined;
  keyState?: KeyState | undefined;
  /** Only agents whose owner still has to collect a new key. */
  awaitingKey?: boolean | undefined;
  provider?: string | undefined;
  owner?: string | undefined;
  team?: string | undefined;
  sort?: AgentSort | undefined;
  dir?: "asc" | "desc" | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

export interface AgentPage {
  items: PublicAgent[];
  total: number;
  page: number;
  pageSize: number;
  facets: { owners: string[]; teams: string[]; providers: string[] };
}

export const MAX_PAGE_SIZE = 200;

interface Row {
  agent: Agent;
  key: string | number;
}

/**
 * One page of agents, filtered and sorted. Spend, request counts and last use
 * come from the store's running indexes, so a page costs a pass over the
 * agents, never over the usage log: fast with tens of thousands of agents.
 */
export function listAgents(
  store: Store,
  now: Date,
  query: AgentQuery,
  providerNames: ReadonlyMap<string, string> = new Map(),
  /** Only these agents exist for this caller: facets and totals included. */
  visible: (agent: Agent) => boolean = () => true,
): AgentPage {
  const terms = (query.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const field = query.in ?? "all";
  const sort = query.sort ?? "name";
  const dir = query.dir ?? (sort === "name" ? "asc" : "desc");
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(query.pageSize ?? 50)),
  );
  const page = Math.max(1, Math.floor(query.page ?? 1));

  const owners = new Set<string>();
  const teams = new Set<string>();
  const providers = new Set<string>();
  const rows: Row[] = [];

  for (const agent of store.listAgents()) {
    if (!visible(agent)) continue;
    owners.add(agent.owner);
    if (agent.team) teams.add(agent.team);
    const used = store.providersUsedBy(agent.id);
    for (const p of agent.providers ?? []) providers.add(p);
    if (used) for (const p of used) providers.add(p);

    if (query.owner !== undefined && agent.owner !== query.owner) continue;
    if (query.team !== undefined && agent.team !== query.team) continue;
    if (
      query.provider !== undefined &&
      !(agent.providers?.includes(query.provider) ?? false) &&
      !(used?.has(query.provider) ?? false)
    ) {
      continue;
    }
    if (
      terms.length > 0 &&
      !matches(agent, used, providerNames, terms, field)
    ) {
      continue;
    }
    if (query.state !== undefined || query.light !== undefined) {
      const state = agentState(agent, store, now);
      if (
        query.state !== undefined &&
        (query.state === "not_running"
          ? state === "running"
          : state !== query.state)
      ) {
        continue;
      }
      if (query.light !== undefined && lightOf(state) !== query.light) {
        continue;
      }
    }
    if (
      query.keyState !== undefined &&
      keyState(agent, now) !== query.keyState
    ) {
      continue;
    }
    if (query.awaitingKey && !agent.awaitingKey) continue;
    rows.push({ agent, key: sortKey(store, now, agent, sort) });
  }

  const sign = dir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    if (a.key !== b.key) return a.key < b.key ? -sign : sign;
    return a.agent.name < b.agent.name
      ? -1
      : a.agent.name > b.agent.name
        ? 1
        : 0;
  });

  const start = (page - 1) * pageSize;
  return {
    items: rows
      .slice(start, start + pageSize)
      .map((row) => toPublic(row.agent, store, now)),
    total: rows.length,
    page,
    pageSize,
    facets: {
      owners: [...owners].sort(),
      teams: [...teams].sort(),
      providers: [...providers].sort(),
    },
  };
}

/**
 * Every search word must appear somewhere in the chosen fields, so
 * "finance openrouter" finds Finance agents that use OpenRouter. Providers
 * match by id or by name ("open" finds OpenAI and OpenRouter).
 */
function matches(
  agent: Agent,
  used: ReadonlySet<string> | undefined,
  providerNames: ReadonlyMap<string, string>,
  terms: string[],
  field: SearchField,
): boolean {
  const haystack: string[] = [];
  if (field === "all" || field === "name") {
    haystack.push(agent.name);
    if (field === "all") haystack.push(agent.id, agent.purpose ?? "");
  }
  if (field === "all" || field === "owner") haystack.push(agent.owner);
  if (field === "all" || field === "team") haystack.push(agent.team ?? "");
  if (field === "all" || field === "provider") {
    const ids = new Set([...(agent.providers ?? []), ...(used ?? [])]);
    for (const id of ids) haystack.push(id, providerNames.get(id) ?? "");
  }
  const text = haystack.join("\n").toLowerCase();
  return terms.every((term) => text.includes(term));
}

function sortKey(
  store: Store,
  now: Date,
  agent: Agent,
  sort: AgentSort,
): string | number {
  switch (sort) {
    case "spend_today":
      return store.spend(agent.id, "day", now);
    case "spend_month":
      return store.spend(agent.id, "month", now);
    case "created":
      return agent.createdAt;
    case "last_used":
      return store.lastUsedAt(agent.id) ?? "";
    case "key_expires":
      // Keys that never expire sort after every dated one.
      return agent.keyExpiresAt ?? "~";
    default:
      return agent.name.toLowerCase();
  }
}

export interface Overview {
  spend: { today: number; month: number };
  requests: { today: number };
  agents: {
    total: number;
    running: number;
    paused: number;
    atLimit: number;
    expired: number;
    keyExpired: number;
  };
  providers: { configured: number; total: number };
  /** Keys that expired, or expire within 14 days. */
  keys: { expiring: number; expired: number };
  topToday: PublicAgent[];
  recentEvents: AuditEvent[];
}

export function overview(
  store: Store,
  now: Date,
  providers: { configured: number; total: number },
): Overview {
  const counts = {
    total: 0,
    running: 0,
    paused: 0,
    atLimit: 0,
    expired: 0,
    keyExpired: 0,
  };
  const keys = { expiring: 0, expired: 0 };
  const top: { agent: Agent; spend: number }[] = [];
  for (const agent of store.listAgents()) {
    counts.total++;
    const state = agentState(agent, store, now);
    if (state === "running") counts.running++;
    else if (state === "paused") counts.paused++;
    else if (state === "at_limit") counts.atLimit++;
    else if (state === "key_expired") counts.keyExpired++;
    else counts.expired++;
    const ks = keyState(agent, now);
    if (ks === "expiring") keys.expiring++;
    else if (ks === "expired") keys.expired++;
    const spend = store.spend(agent.id, "day", now);
    if (spend > 0) {
      top.push({ agent, spend });
      if (top.length > 50) {
        top.sort((a, b) => b.spend - a.spend);
        top.length = 5;
      }
    }
  }
  top.sort((a, b) => b.spend - a.spend);
  const log = store.auditLog();
  return {
    spend: {
      today: store.totalSpend("day", now),
      month: store.totalSpend("month", now),
    },
    requests: { today: store.totalRequests(now) },
    agents: counts,
    providers,
    keys,
    topToday: top.slice(0, 5).map((t) => toPublic(t.agent, store, now)),
    recentEvents: log.slice(-10).reverse(),
  };
}

/** One agent that can't make calls right now, and since when. */
export interface StoppedAgent {
  id: string;
  name: string;
  owner: string;
  team?: string | undefined;
  state: Exclude<AgentState, "running">;
  /** When it stopped being able to run, when known. */
  since?: string | undefined;
  /** Who stopped it, for agents someone paused. */
  by?: string | undefined;
}

/** The fleet at a glance: how many agents can run, and which can't. */
export interface StatusBoard {
  total: number;
  running: number;
  /** Every agent that can't run, yellow and red. */
  notRunning: number;
  /** Of those, the ones at a spending limit: yellow. */
  atLimit: number;
  /** The agents that can't run, most recently stopped first, up to the limit. */
  stopped: StoppedAgent[];
}

/**
 * Every agent that can't make calls, newest first. One pass over the agents,
 * so it is cheap enough to poll.
 */
export function statusBoard(
  store: Store,
  now: Date,
  limit: number,
  visible: (agent: Agent) => boolean = () => true,
): StatusBoard {
  let total = 0;
  const stopped: StoppedAgent[] = [];
  for (const agent of store.listAgents()) {
    if (!visible(agent)) continue;
    total++;
    const state = agentState(agent, store, now);
    if (state === "running") continue;
    stopped.push({
      id: agent.id,
      name: agent.name,
      owner: agent.owner,
      team: agent.team,
      state,
      since:
        state === "paused"
          ? agent.pausedAt
          : state === "expired"
            ? agent.endsAt
            : state === "key_expired"
              ? agent.keyExpiresAt
              : store.lastUsedAt(agent.id),
      by: state === "paused" ? agent.pausedBy : undefined,
    });
  }
  stopped.sort((a, b) =>
    (b.since ?? "") < (a.since ?? "")
      ? -1
      : (b.since ?? "") > (a.since ?? "")
        ? 1
        : a.name < b.name
          ? -1
          : 1,
  );
  const cap = Math.max(0, Math.min(1000, Math.floor(limit)));
  return {
    total,
    running: total - stopped.length,
    notRunning: stopped.length,
    atLimit: stopped.filter((s) => s.state === "at_limit").length,
    stopped: stopped.slice(0, cap),
  };
}

export interface DailyUsage {
  date: string;
  costUsd: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

/** An agent's spend per UTC day for the last `days` days, today last, plus its newest records. */
export function agentUsage(
  store: Store,
  agentId: string,
  now: Date,
  days: number,
): { daily: DailyUsage[]; recent: UsageRecord[] } {
  const span = Math.max(1, Math.min(366, Math.floor(days)));
  const daily: DailyUsage[] = [];
  const byDate = new Map<string, DailyUsage>();
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  for (let i = span - 1; i >= 0; i--) {
    const date = new Date(today - i * 86_400_000).toISOString().slice(0, 10);
    const row = {
      date,
      costUsd: 0,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    daily.push(row);
    byDate.set(date, row);
  }
  const first = daily[0]?.date ?? "";
  const records = store.usageOf(agentId);
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (!record) continue;
    const date = record.at.slice(0, 10);
    if (date < first) break;
    const row = byDate.get(date);
    if (!row) continue;
    row.costUsd += record.costUsd;
    row.requests += 1;
    row.inputTokens += record.inputTokens + record.cacheReadTokens;
    row.outputTokens += record.outputTokens;
  }
  return { daily, recent: store.recentUsage(50, agentId) };
}

export interface AuditPage {
  items: AuditEvent[];
  /** Pass back as `before` for the next, older page. */
  next?: string | undefined;
}

/**
 * The audit log newest first. `before` is either a cursor returned as `next`
 * or an ISO timestamp; either way only older events are returned.
 */
export function auditPage(
  store: Store,
  options: { limit?: number; before?: string; agentId?: string },
): AuditPage {
  const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 100)));
  const log = store.auditLog();
  let end = log.length;
  let beforeAt: string | undefined;
  if (options.before !== undefined) {
    if (/^\d+$/.test(options.before)) {
      end = Math.min(end, Number(options.before));
    } else {
      beforeAt = options.before;
    }
  }
  const items: AuditEvent[] = [];
  let i = end - 1;
  for (; i >= 0 && items.length < limit; i--) {
    const event = log[i];
    if (!event) continue;
    if (beforeAt !== undefined && !(event.at < beforeAt)) continue;
    if (options.agentId !== undefined && event.agentId !== options.agentId) {
      continue;
    }
    items.push(event);
  }
  // `i` is the next index to look at; there is more only if something older matches.
  let more = false;
  for (let j = i; j >= 0; j--) {
    const event = log[j];
    if (!event) continue;
    if (beforeAt !== undefined && !(event.at < beforeAt)) continue;
    if (options.agentId !== undefined && event.agentId !== options.agentId) {
      continue;
    }
    more = true;
    break;
  }
  return { items, next: more ? String(i + 1) : undefined };
}
