import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Agent, AuditEvent, UsageRecord } from "./types.js";

export type SpendWindow = "day" | "month";

/** UTC bucket for a timestamp: "2026-11-07" for a day, "2026-11" for a month. */
export function windowKey(window: SpendWindow, at: Date): string {
  return bucket(window, at.toISOString());
}

/** The same bucket, cut straight from an ISO 8601 UTC timestamp. */
function bucket(window: SpendWindow, iso: string): string {
  return window === "day" ? iso.slice(0, 10) : iso.slice(0, 7);
}

/** Totals across every agent are kept under this id. */
const ALL = "*";

export interface KeyMatch {
  agent: Agent;
  /** "previous" when the key is the old one, kept during a rotation grace period. */
  which: "current" | "previous";
}

/**
 * The phase 0 store: everything in memory, optionally persisted to plain
 * files in a data directory. Phase 1 replaces this with Postgres, behind the
 * same methods.
 *
 * Everything a list or a cap check needs is indexed, so neither scans the
 * usage log: spend and request counts per agent and window, the last time
 * each agent was used, and each agent's own usage records.
 */
export class Store {
  private readonly agents = new Map<string, Agent>();
  private readonly byName = new Map<string, string>();
  private readonly byKeyHash = new Map<
    string,
    { id: string; which: "current" | "previous" }
  >();
  private readonly usage: UsageRecord[] = [];
  private readonly usageByAgent = new Map<string, UsageRecord[]>();
  private readonly events: AuditEvent[] = [];
  /** Running spend per agent and window, so cap checks cost one map lookup. */
  private readonly spendTotals = new Map<string, number>();
  private readonly requestCounts = new Map<string, number>();
  private readonly lastUsed = new Map<string, string>();
  private readonly providersUsed = new Map<string, Set<string>>();
  /** While above zero, agent saves are held and written once at the end. */
  private batchDepth = 0;
  private dirty = false;

  constructor(private readonly dataDir: string | null = null) {
    if (dataDir) this.load(dataDir);
  }

  /** Runs `fn` and writes the agent file once afterwards, however many agents it changed. */
  batch<T>(fn: () => T): T {
    this.batchDepth++;
    try {
      return fn();
    } finally {
      this.batchDepth--;
      if (this.batchDepth === 0 && this.dirty) this.saveAgents();
    }
  }

  createAgent(agent: Agent): void {
    if (this.byName.has(agent.name)) {
      throw new Error(`An agent named "${agent.name}" already exists.`);
    }
    this.agents.set(agent.id, agent);
    this.index(agent);
    this.saveAgents();
  }

  updateAgent(id: string, patch: Partial<Agent>): Agent {
    const current = this.agents.get(id);
    if (!current) throw new Error(`No agent with id ${id}.`);
    const next: Agent = { ...current, ...patch, id: current.id };
    this.unindex(current);
    this.agents.set(id, next);
    this.index(next);
    this.saveAgents();
    return next;
  }

  getAgent(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  findByName(name: string): Agent | undefined {
    const id = this.byName.get(name);
    return id === undefined ? undefined : this.agents.get(id);
  }

  /** An agent by id or by its unique name. */
  resolve(ref: string): Agent | undefined {
    return this.agents.get(ref) ?? this.findByName(ref);
  }

  getAgentByKeyHash(hash: string): Agent | undefined {
    return this.matchKeyHash(hash)?.agent;
  }

  /** The agent a key hash belongs to, and whether it is the current key or the previous one. */
  matchKeyHash(hash: string): KeyMatch | undefined {
    const hit = this.byKeyHash.get(hash);
    const agent = hit === undefined ? undefined : this.agents.get(hit.id);
    return agent && hit ? { agent, which: hit.which } : undefined;
  }

  listAgents(): Agent[] {
    return [...this.agents.values()];
  }

  agentCount(): number {
    return this.agents.size;
  }

  recordUsage(record: UsageRecord): void {
    this.indexUsage(record);
    this.append("usage.jsonl", record);
  }

  spend(agentId: string, window: SpendWindow, at: Date): number {
    return this.spendTotals.get(`${agentId}|${windowKey(window, at)}`) ?? 0;
  }

  /** What an agent spent through one service. */
  serviceSpend(
    agentId: string,
    provider: string,
    window: SpendWindow,
    at: Date,
  ): number {
    return (
      this.spendTotals.get(`${agentId}/${provider}|${windowKey(window, at)}`) ??
      0
    );
  }

  /** Spend across every agent. */
  totalSpend(window: SpendWindow, at: Date): number {
    return this.spend(ALL, window, at);
  }

  /** Metered requests on a UTC day. */
  requests(agentId: string, at: Date): number {
    return this.requestCounts.get(`${agentId}|${windowKey("day", at)}`) ?? 0;
  }

  totalRequests(at: Date): number {
    return this.requests(ALL, at);
  }

  lastUsedAt(agentId: string): string | undefined {
    return this.lastUsed.get(agentId);
  }

  /** Connectors an agent has made metered calls through. */
  providersUsedBy(agentId: string): ReadonlySet<string> | undefined {
    return this.providersUsed.get(agentId);
  }

  listUsage(agentId?: string): UsageRecord[] {
    return agentId === undefined
      ? [...this.usage]
      : [...(this.usageByAgent.get(agentId) ?? [])];
  }

  /** The newest records, newest first, without copying the whole log. */
  recentUsage(limit: number, agentId?: string): UsageRecord[] {
    const source =
      agentId === undefined
        ? this.usage
        : (this.usageByAgent.get(agentId) ?? []);
    const out: UsageRecord[] = [];
    for (let i = source.length - 1; i >= 0 && out.length < limit; i--) {
      const record = source[i];
      if (record) out.push(record);
    }
    return out;
  }

  /** An agent's own records, oldest first. Not a copy: do not change it. */
  usageOf(agentId: string): readonly UsageRecord[] {
    return this.usageByAgent.get(agentId) ?? [];
  }

  audit(event: AuditEvent): void {
    this.events.push(event);
    this.append("audit.jsonl", event);
  }

  listAudit(): AuditEvent[] {
    return [...this.events];
  }

  /** The audit log itself, oldest first. Not a copy: do not change it. */
  auditLog(): readonly AuditEvent[] {
    return this.events;
  }

  private index(agent: Agent): void {
    this.byName.set(agent.name, agent.id);
    this.byKeyHash.set(agent.keyHash, { id: agent.id, which: "current" });
    if (agent.previousKeyHash) {
      this.byKeyHash.set(agent.previousKeyHash, {
        id: agent.id,
        which: "previous",
      });
    }
  }

  private unindex(agent: Agent): void {
    this.byName.delete(agent.name);
    this.byKeyHash.delete(agent.keyHash);
    if (agent.previousKeyHash) this.byKeyHash.delete(agent.previousKeyHash);
  }

  private indexUsage(record: UsageRecord): void {
    this.usage.push(record);
    let mine = this.usageByAgent.get(record.agentId);
    if (!mine) {
      mine = [];
      this.usageByAgent.set(record.agentId, mine);
    }
    mine.push(record);
    const day = bucket("day", record.at);
    const month = bucket("month", record.at);
    for (const id of [record.agentId, ALL]) {
      this.add(this.spendTotals, `${id}|${day}`, record.costUsd);
      this.add(this.spendTotals, `${id}|${month}`, record.costUsd);
      this.add(this.requestCounts, `${id}|${day}`, 1);
    }
    const service = `${record.agentId}/${record.provider}`;
    this.add(this.spendTotals, `${service}|${day}`, record.costUsd);
    this.add(this.spendTotals, `${service}|${month}`, record.costUsd);
    let used = this.providersUsed.get(record.agentId);
    if (!used) {
      used = new Set();
      this.providersUsed.set(record.agentId, used);
    }
    used.add(record.provider);
    const last = this.lastUsed.get(record.agentId);
    if (last === undefined || record.at > last) {
      this.lastUsed.set(record.agentId, record.at);
    }
  }

  private add(map: Map<string, number>, key: string, n: number): void {
    map.set(key, (map.get(key) ?? 0) + n);
  }

  private load(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const agentsFile = join(dir, "agents.json");
    if (existsSync(agentsFile)) {
      const agents = JSON.parse(readFileSync(agentsFile, "utf8")) as Agent[];
      for (const agent of agents) {
        this.agents.set(agent.id, agent);
        this.index(agent);
      }
    }
    for (const record of readJsonLines<UsageRecord>(join(dir, "usage.jsonl"))) {
      this.indexUsage(record);
    }
    this.events.push(...readJsonLines<AuditEvent>(join(dir, "audit.jsonl")));
  }

  private saveAgents(): void {
    if (!this.dataDir) return;
    if (this.batchDepth > 0) {
      this.dirty = true;
      return;
    }
    this.dirty = false;
    writeAtomic(
      join(this.dataDir, "agents.json"),
      JSON.stringify(this.listAgents(), null, 2),
    );
  }

  private append(file: string, value: unknown): void {
    if (!this.dataDir) return;
    appendFileSync(join(this.dataDir, file), `${JSON.stringify(value)}\n`, {
      mode: 0o600,
    });
  }
}

/** Writes a file readable only by its owner, replacing the old one in a single step. */
export function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, file);
}

function readJsonLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A line torn by a crash mid-write: skip it rather than refuse to start.
    }
  }
  return out;
}
