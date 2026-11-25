import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { secretHint } from "./keys.js";
import { capFor } from "./policy.js";
import { writeAtomic, type Store } from "./store.js";
import type { Agent, AuditEvent } from "./types.js";
import type { Vault } from "./vault.js";

/**
 * Per-agent OpenRouter keys. With a management key saved and this turned on,
 * each agent that uses OpenRouter gets its own OpenRouter key, made through
 * OpenRouter's key API. The gateway uses it for that agent's calls instead of
 * the shared key, so OpenRouter itself enforces the agent's cap and end date,
 * and stopping the agent disables its key at OpenRouter: a second layer of
 * stop that holds even if something gets past Purser.
 */

/** The vault entry holding the OpenRouter management key. */
export const MANAGEMENT_SECRET = "__openrouter_mgmt";
/** The vault entry holding one agent's own OpenRouter key. */
export const agentKeySecret = (agentId: string) => `__or_agent_${agentId}`;

const PROVIDER = "openrouter";
const TIMEOUT_MS = 10_000;
/** How many key calls run at once, so a pause-all doesn't trip OpenRouter's burst limit. */
const CONCURRENCY = 4;

export type LimitReset = "daily" | "monthly";

/** What an agent's OpenRouter key should look like, from its limits in Purser. */
export interface DesiredKey {
  /** Dollars per `limitReset` window, or null for no limit at OpenRouter. */
  limit: number | null;
  limitReset: LimitReset | null;
  disabled: boolean;
  /** The agent's end date, or null. */
  expiresAt: string | null;
}

/** One agent's key, as Purser last set it. The key itself is in the vault. */
export interface AgentKeyRecord extends DesiredKey {
  agentId: string;
  /** OpenRouter's id for the key. */
  hash: string;
  /** OpenRouter's masked form, such as "sk-or-v1-0e6...1c96". */
  label: string;
  createdAt: string;
  syncedAt: string;
  /** What OpenRouter reported the key spent, at the last check. */
  usage?: { today: number; month: number; at: string } | undefined;
  /** Something wrong with the key that a person should look at. */
  problem?: string | undefined;
  /**
   * The key can't be used: it was deleted or disabled at OpenRouter by
   * someone other than Purser. The agent's OpenRouter calls are refused until
   * an admin replaces it.
   */
  broken?: boolean | undefined;
}

export interface OpenRouterKeysView {
  /** A management key is saved. Only a hint of it is ever shown. */
  managementKey: { set: boolean; hint?: string | undefined };
  enabled: boolean;
  /** OpenRouter itself is connected, with a key and an address. */
  connected: boolean;
  keys: number;
  problems: { agentId: string; agentName: string; problem: string }[];
}

export interface OpenRouterKeysDeps {
  store: Store;
  vault: Vault;
  fetch: typeof fetch;
  now: () => Date;
  /** Waits before retrying a call OpenRouter rate limited. Tests pass zeros. */
  retryDelaysMs?: number[] | undefined;
  /** After a failed change, try that agent again this much later. */
  retryLaterMs?: number | undefined;
}

interface FileShape {
  enabled: boolean;
  keys: AgentKeyRecord[];
}

/** A key API call that failed, in words an admin can act on. */
export class KeyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "KeyApiError";
  }
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** The smaller of the limits that are set. */
const tighter = (...caps: (number | undefined)[]) => {
  const set = caps.filter((c): c is number => c !== undefined);
  return set.length === 0 ? undefined : Math.min(...set);
};

/**
 * OpenRouter takes one limit per key, reset daily, weekly or monthly. It gets
 * the agent's tighter daily cap if it has one, else its monthly cap: whichever
 * of the agent's own cap (with any raise in force) and its OpenRouter service
 * cap is lower. Purser still enforces every cap itself; this is the backstop.
 */
export function desiredFor(agent: Agent, now: Date): DesiredKey {
  const service = agent.serviceLimits?.[PROVIDER];
  const day = tighter(capFor(agent, "day", now), service?.dailyUsd);
  const month = tighter(capFor(agent, "month", now), service?.monthlyUsd);
  const [limit, limitReset]: [number | null, LimitReset | null] =
    day !== undefined
      ? [cents(day), "daily"]
      : month !== undefined
        ? [cents(month), "monthly"]
        : [null, null];
  return {
    limit,
    limitReset,
    disabled: agent.status === "paused",
    // OpenRouter wants whole seconds.
    expiresAt: agent.endsAt
      ? `${new Date(agent.endsAt).toISOString().slice(0, 19)}Z`
      : null,
  };
}

/** May this agent use OpenRouter at all? */
export function mayUseOpenRouter(agent: Agent): boolean {
  const list = agent.providers;
  return list === undefined || list.length === 0 || list.includes(PROVIDER);
}

/** Audit events about one agent that can change what its key should be. */
const SYNC_ON = new Set<AuditEvent["type"]>([
  "agent.created",
  "agent.paused",
  "agent.resumed",
  "agent.limits_changed",
  "agent.updated",
  "agent.limit_raised",
  "agent.service_changed",
]);

interface OpenRouterKeyJson {
  hash?: string;
  label?: string;
  disabled?: boolean;
  usage_daily?: number;
  usage_monthly?: number;
}

export class OpenRouterKeys {
  private enabledValue = false;
  private readonly records = new Map<string, AgentKeyRecord>();
  /** Agents whose key couldn't be made, with why, until it works. */
  private readonly failures = new Map<string, string>();
  private readonly dirty = new Set<string>();
  private draining: Promise<void> | null = null;
  private upstream: () => string | undefined = () => undefined;
  private connected: () => boolean = () => false;

  constructor(
    private readonly deps: OpenRouterKeysDeps,
    private readonly dataDir: string | null = null,
  ) {
    if (dataDir) this.load(dataDir);
    deps.store.subscribe({
      usage: (record) => {
        if (record.provider !== PROVIDER || !this.enabledValue) return;
        if (!this.records.has(record.agentId)) this.touch(record.agentId);
      },
      audit: (event) => {
        if (event.agentId !== undefined && SYNC_ON.has(event.type)) {
          if (this.enabledValue || this.records.has(event.agentId)) {
            this.touch(event.agentId);
          }
        }
      },
    });
  }

  /** Tells it where OpenRouter is and whether it is connected. */
  useOpenRouter(where: {
    upstream: () => string | undefined;
    connected: () => boolean;
  }): void {
    this.upstream = where.upstream;
    this.connected = where.connected;
  }

  // What the admin sees

  view(): OpenRouterKeysView {
    const key = this.managementKey();
    const problems: OpenRouterKeysView["problems"] = [];
    const name = (id: string) => this.deps.store.getAgent(id)?.name ?? id;
    for (const r of this.records.values()) {
      if (r.problem) {
        problems.push({
          agentId: r.agentId,
          agentName: name(r.agentId),
          problem: r.problem,
        });
      }
    }
    for (const [agentId, problem] of this.failures) {
      problems.push({ agentId, agentName: name(agentId), problem });
    }
    return {
      managementKey: { set: key !== undefined, hint: key && secretHint(key) },
      enabled: this.enabledValue,
      connected: this.connected(),
      keys: this.records.size,
      problems,
    };
  }

  /** One agent's key, without the key itself. */
  forAgent(agentId: string): AgentKeyRecord | undefined {
    const r = this.records.get(agentId);
    return r ? { ...r } : undefined;
  }

  /** Why this agent has no key yet, if making one failed. */
  failureFor(agentId: string): string | undefined {
    return this.failures.get(agentId);
  }

  enabled(): boolean {
    return this.enabledValue;
  }

  // Settings

  /** Checks the key with OpenRouter, then saves it. Throws KeyApiError if it won't do. */
  async setManagementKey(key: string): Promise<void> {
    try {
      await this.call("GET", "?offset=0", undefined, key);
    } catch (err) {
      if (err instanceof KeyApiError && err.status === 403) {
        throw new KeyApiError(
          "That is an ordinary OpenRouter API key. Make a management key under Settings, Management keys.",
          400,
        );
      }
      if (err instanceof KeyApiError && err.status === 401) {
        throw new KeyApiError("OpenRouter did not accept that key.", 400);
      }
      throw err;
    }
    this.deps.vault.set(MANAGEMENT_SECRET, {
      apiKey: key,
      updatedAt: this.deps.now().toISOString(),
    });
  }

  /** Forgets the management key. Refused while per-agent keys are on. */
  removeManagementKey(): void {
    if (this.enabledValue || this.records.size > 0) {
      throw new KeyApiError(
        "Turn off per-agent keys first, so Purser can delete the keys it made.",
        409,
      );
    }
    this.deps.vault.removeKey(MANAGEMENT_SECRET);
  }

  /**
   * Turns per-agent keys on or off. On: agents that list OpenRouter or have
   * used it get keys now, others when they first call it. Off: every key
   * Purser made is deleted at OpenRouter and the shared key is used again.
   */
  setEnabled(on: boolean): void {
    if (on && !this.managementKey()) {
      throw new KeyApiError("Save an OpenRouter management key first.", 409);
    }
    if (on && !this.connected()) {
      throw new KeyApiError("Connect OpenRouter first.", 409);
    }
    this.enabledValue = on;
    this.save();
    if (on) {
      for (const agent of this.deps.store.listAgents()) {
        if (this.wanted(agent)) this.touch(agent.id);
      }
    } else {
      this.failures.clear();
      for (const id of this.records.keys()) this.touch(id);
    }
  }

  /** Replaces an agent's key with a new one, such as after it was deleted at OpenRouter. */
  async replace(agentId: string): Promise<AgentKeyRecord> {
    const agent = this.deps.store.getAgent(agentId);
    if (!agent || !this.enabledValue || !this.eligible(agent)) {
      throw new KeyApiError("This agent can't have an OpenRouter key.", 409);
    }
    await this.settle();
    const old = this.records.get(agentId);
    const made = await this.create(agent);
    if (old) await this.destroy(old, "replaced", false);
    return { ...made };
  }

  // The gateway

  /**
   * Which key the gateway uses for this agent's OpenRouter call: its own,
   * null for the shared one, or a reason to refuse. An agent whose own key is
   * broken is refused rather than given the shared key, so a key someone
   * disabled at OpenRouter can't be got round through Purser.
   */
  gatewayKey(agentId: string): { key: string } | { refuse: string } | null {
    if (!this.enabledValue) return null;
    const record = this.records.get(agentId);
    if (!record) return null;
    const key = this.deps.vault.get(agentKeySecret(agentId))?.apiKey;
    if (!key || record.broken) {
      return {
        refuse:
          "This agent's own OpenRouter key isn't working. An admin can replace it on the agent's page in Purser.",
      };
    }
    return { key };
  }

  // Keeping keys in step

  /**
   * Checks every key against OpenRouter: what each spent, and whether someone
   * disabled or deleted one there. Then brings every agent's key in step. Run
   * on start and every hour.
   */
  async sweep(): Promise<void> {
    if (this.managementKey() && this.records.size > 0) {
      try {
        const seen = await this.listAll();
        const at = this.deps.now().toISOString();
        for (const record of this.records.values()) {
          const found = seen.get(record.hash);
          if (!found) {
            this.markGone(record);
            continue;
          }
          record.usage = {
            today: found.usage_daily ?? 0,
            month: found.usage_monthly ?? 0,
            at,
          };
          if (found.disabled === true && !record.disabled) {
            record.problem =
              "Someone disabled this key at OpenRouter. Purser leaves it disabled; replace it to start again.";
            record.broken = true;
          }
        }
        this.save();
      } catch {
        // OpenRouter unreachable: try again at the next sweep.
      }
    }
    for (const agent of this.deps.store.listAgents()) {
      if (this.records.has(agent.id) || this.wanted(agent)) {
        this.touch(agent.id);
      }
    }
    await this.settle();
  }

  /** Waits until every queued change has been sent. */
  async settle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private touch(agentId: string): void {
    this.dirty.add(agentId);
    if (!this.draining) {
      this.draining = this.drain().finally(() => {
        this.draining = null;
      });
    }
  }

  private async drain(): Promise<void> {
    // Let the change that queued this finish first.
    await Promise.resolve();
    while (this.dirty.size > 0) {
      const batch = [...this.dirty].slice(0, CONCURRENCY);
      for (const id of batch) this.dirty.delete(id);
      await Promise.all(batch.map((id) => this.syncAgent(id)));
    }
  }

  private eligible(agent: Agent): boolean {
    const ended =
      agent.endsAt !== undefined &&
      Date.parse(agent.endsAt) <= this.deps.now().getTime();
    return (
      Boolean(this.managementKey()) &&
      this.connected() &&
      mayUseOpenRouter(agent) &&
      !ended
    );
  }

  /** Should this agent have a key: on, eligible, and it uses or lists OpenRouter. */
  private wanted(agent: Agent): boolean {
    if (!this.enabledValue || !this.eligible(agent)) return false;
    return (
      this.records.has(agent.id) ||
      Boolean(agent.providers?.includes(PROVIDER)) ||
      Boolean(this.deps.store.providersUsedBy(agent.id)?.has(PROVIDER))
    );
  }

  private async syncAgent(agentId: string): Promise<void> {
    const agent = this.deps.store.getAgent(agentId);
    const record = this.records.get(agentId);
    try {
      if (!agent || !this.wanted(agent)) {
        this.failures.delete(agentId);
        if (record) {
          await this.destroy(
            record,
            this.enabledValue ? "no longer needed" : "turned off",
          );
        }
        return;
      }
      const desired = desiredFor(agent, this.deps.now());
      if (!record) {
        await this.create(agent);
        return;
      }
      // OpenRouter can't change an expiry, so a new end date needs a new key.
      if (record.expiresAt !== desired.expiresAt) {
        await this.create(agent);
        await this.destroy(record, "new end date", false);
        return;
      }
      if (record.broken) return;
      if (
        record.limit !== desired.limit ||
        record.limitReset !== desired.limitReset ||
        record.disabled !== desired.disabled
      ) {
        await this.call("PATCH", `/${record.hash}`, {
          limit: desired.limit,
          limit_reset: desired.limitReset,
          disabled: desired.disabled,
        });
        const changed = record.disabled !== desired.disabled;
        Object.assign(record, desired, {
          syncedAt: this.deps.now().toISOString(),
        });
        record.problem = undefined;
        this.save();
        if (changed) {
          this.audit(agentId, desired.disabled ? "disabled" : "enabled");
        }
      }
    } catch (err) {
      const message =
        err instanceof KeyApiError
          ? err.message
          : "Could not reach OpenRouter.";
      if (record && err instanceof KeyApiError && err.status === 404) {
        this.markGone(record);
      } else {
        if (record) record.problem = message;
        else this.failures.set(agentId, message);
        // A stop that didn't reach OpenRouter is worth retrying soon, but a
        // refusal would only use up OpenRouter's daily quota of key changes.
        const passing =
          !(err instanceof KeyApiError) ||
          err.status >= 500 ||
          err.status === 429;
        if (passing) {
          setTimeout(
            () => this.touch(agentId),
            this.deps.retryLaterMs ?? 60_000,
          ).unref?.();
        }
      }
      this.save();
      this.audit(agentId, "failed", { error: message });
    }
  }

  private markGone(record: AgentKeyRecord): void {
    record.problem =
      "This key is gone from OpenRouter. Replace it to make a new one.";
    record.broken = true;
  }

  private async create(agent: Agent): Promise<AgentKeyRecord> {
    const desired = desiredFor(agent, this.deps.now());
    const res = (await this.call("POST", "", {
      name: `Purser: ${agent.name}`.slice(0, 256),
      limit: desired.limit,
      limit_reset: desired.limitReset,
      ...(desired.expiresAt ? { expires_at: desired.expiresAt } : {}),
    })) as { key?: string; data?: OpenRouterKeyJson };
    const hash = res.data?.hash;
    if (!res.key || !hash) {
      throw new KeyApiError("OpenRouter's answer had no key in it.", 502);
    }
    const now = this.deps.now().toISOString();
    this.deps.vault.set(agentKeySecret(agent.id), {
      apiKey: res.key,
      updatedAt: now,
    });
    const record: AgentKeyRecord = {
      agentId: agent.id,
      hash,
      label: res.data?.label ?? secretHint(res.key),
      ...desired,
      // A new key starts enabled; a paused agent's is disabled straight after.
      disabled: false,
      createdAt: now,
      syncedAt: now,
    };
    this.records.set(agent.id, record);
    this.failures.delete(agent.id);
    this.save();
    this.audit(agent.id, "created", {
      limit: desired.limit,
      limitReset: desired.limitReset,
    });
    if (desired.disabled) {
      await this.call("PATCH", `/${hash}`, { disabled: true });
      record.disabled = true;
      this.save();
      this.audit(agent.id, "disabled");
    }
    return record;
  }

  /** Deletes a key at OpenRouter and forgets it. */
  private async destroy(
    record: AgentKeyRecord,
    reason: string,
    forgetVault = true,
  ): Promise<void> {
    try {
      await this.call("DELETE", `/${record.hash}`);
    } catch (err) {
      // Already gone is what we wanted.
      if (!(err instanceof KeyApiError && err.status === 404)) throw err;
    }
    if (this.records.get(record.agentId)?.hash === record.hash) {
      this.records.delete(record.agentId);
      if (forgetVault)
        this.deps.vault.removeKey(agentKeySecret(record.agentId));
    }
    this.save();
    this.audit(record.agentId, "deleted", { reason });
  }

  private async listAll(): Promise<Map<string, OpenRouterKeyJson>> {
    const seen = new Map<string, OpenRouterKeyJson>();
    for (let offset = 0; offset < 100_000; offset += 100) {
      const page = (await this.call(
        "GET",
        `?offset=${offset}&include_disabled=true`,
      )) as { data?: OpenRouterKeyJson[] };
      const keys = page.data ?? [];
      for (const k of keys) if (k.hash) seen.set(k.hash, k);
      if (keys.length < 100) break;
    }
    return seen;
  }

  private managementKey(): string | undefined {
    return this.deps.vault.get(MANAGEMENT_SECRET)?.apiKey;
  }

  /** One call to OpenRouter's key API, retried when rate limited. */
  private async call(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    key = this.managementKey(),
  ): Promise<unknown> {
    const base = this.upstream();
    if (!key || !base) {
      throw new KeyApiError("OpenRouter isn't set up for per-agent keys.", 409);
    }
    const delays = this.deps.retryDelaysMs ?? [1_000, 5_000];
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.deps.fetch(`${base}/keys${path}`, {
          method,
          headers: {
            authorization: `Bearer ${key}`,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        throw new KeyApiError("Could not reach OpenRouter.", 502);
      }
      if (res.status === 429 && attempt < delays.length) {
        await res.body?.cancel().catch(() => undefined);
        const wait = delays[attempt] ?? 0;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      const json = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      if (res.ok) return json;
      const said = json.error?.message;
      throw new KeyApiError(
        res.status === 429
          ? "OpenRouter is rate limiting key changes. Purser will try again."
          : `OpenRouter answered ${res.status}${said ? `: ${said}` : "."}`,
        res.status,
      );
    }
  }

  private audit(
    agentId: string,
    action: string,
    extra: Record<string, unknown> = {},
  ): void {
    this.deps.store.audit({
      at: this.deps.now().toISOString(),
      type: "openrouter.key",
      agentId,
      detail: { action, ...extra },
    });
  }

  private load(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "openrouter-keys.json");
    if (!existsSync(file)) return;
    const data = JSON.parse(readFileSync(file, "utf8")) as Partial<FileShape>;
    this.enabledValue = data.enabled === true;
    for (const r of data.keys ?? []) this.records.set(r.agentId, r);
  }

  private save(): void {
    if (!this.dataDir) return;
    writeAtomic(
      join(this.dataDir, "openrouter-keys.json"),
      JSON.stringify(
        { enabled: this.enabledValue, keys: [...this.records.values()] },
        null,
        2,
      ),
    );
  }
}
