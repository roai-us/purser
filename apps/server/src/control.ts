import { performance } from "node:perf_hooks";
import { generateAgentKey, hashKey, keyHint, newId } from "./keys.js";
import type { InFlight } from "./inflight.js";
import { atCap, raisedFor } from "./policy.js";
import { windowKey } from "./store.js";
import type { KeyMatch, Store } from "./store.js";
import type {
  Agent,
  AgentLimits,
  AgentState,
  KeyState,
  PublicAgent,
  RotationPolicy,
  ServiceLimit,
} from "./types.js";

export interface ControlDeps {
  store: Store;
  inflight: InFlight;
  now: () => Date;
}

export interface NewAgent {
  name: string;
  owner: string;
  ownerEmail?: string | undefined;
  awaitingKey?: boolean | undefined;
  team?: string | undefined;
  purpose?: string | undefined;
  providers?: string[] | undefined;
  limits?: AgentLimits | undefined;
  endsAt?: string | undefined;
  keyExpiresAt?: string | undefined;
  rotation?: RotationPolicy | undefined;
  logCalls?: boolean | undefined;
}

/** The longest grace a rotation request may ask for: one week. */
export const MAX_GRACE_MINUTES = 10_080;
/** The longest grace a rotation policy may set: 30 days. */
export const MAX_POLICY_GRACE_DAYS = 30;
/** A key is "expiring" this long before it expires. */
export const EXPIRING_WITHIN_MS = 14 * 86_400_000;
const DAY_MS = 86_400_000;

/** Whether the current key is fine, close to expiring, or expired. */
export function keyState(agent: Agent, now: Date): KeyState {
  if (agent.keyExpiresAt === undefined) return "ok";
  const at = Date.parse(agent.keyExpiresAt);
  if (at <= now.getTime()) return "expired";
  return at - now.getTime() <= EXPIRING_WITHIN_MS ? "expiring" : "ok";
}

/** What an agent is doing right now. */
export function agentState(agent: Agent, store: Store, now: Date): AgentState {
  if (agent.status === "paused") return "paused";
  if (agent.endsAt !== undefined && Date.parse(agent.endsAt) <= now.getTime()) {
    return "expired";
  }
  if (keyState(agent, now) === "expired") return "key_expired";
  if (atCap(agent, store, now, "day") || atCap(agent, store, now, "month")) {
    return "at_limit";
  }
  return "running";
}

/**
 * The agent a key belongs to right now: its current key, or its previous one
 * while a rotation's overlap lasts. Says nothing about whether it may call.
 */
export function findAgentByKey(
  store: Store,
  key: string,
  now: Date,
): KeyMatch | null {
  const match = store.matchKeyHash(hashKey(key));
  if (!match) return null;
  if (
    match.which === "previous" &&
    (match.agent.previousKeyValidUntil === undefined ||
      Date.parse(match.agent.previousKeyValidUntil) <= now.getTime())
  ) {
    return null;
  }
  return match;
}

/** An agent as the admin API shows it: live state and spend, never a key hash. */
export function toPublic(agent: Agent, store: Store, now: Date): PublicAgent {
  const {
    keyHash: _keyHash,
    previousKeyHash: _previousKeyHash,
    expiryAuditedFor: _expiryAuditedFor,
    raises: _raises,
    ...rest
  } = agent;
  const raisedDay = raisedFor(agent, "day", now);
  const raisedMonth = raisedFor(agent, "month", now);
  const previousLive =
    agent.previousKeyValidUntil !== undefined &&
    agent.previousKeyHash !== undefined &&
    Date.parse(agent.previousKeyValidUntil) > now.getTime();
  const services = new Set([
    ...(agent.providers ?? []),
    ...Object.keys(agent.serviceLimits ?? {}),
    ...(store.providersUsedBy(agent.id) ?? []),
  ]);
  const serviceSpend: PublicAgent["serviceSpend"] = {};
  for (const id of services) {
    serviceSpend[id] = {
      today: store.serviceSpend(agent.id, id, "day", now),
      month: store.serviceSpend(agent.id, id, "month", now),
    };
  }
  return {
    ...rest,
    serviceSpend,
    previousKeyValidUntil: previousLive
      ? agent.previousKeyValidUntil
      : undefined,
    state: agentState(agent, store, now),
    keyState: keyState(agent, now),
    raised: {
      dailyUsd: raisedDay > 0 ? raisedDay : undefined,
      monthlyUsd: raisedMonth > 0 ? raisedMonth : undefined,
    },
    spend: {
      today: store.spend(agent.id, "day", now),
      month: store.spend(agent.id, "month", now),
    },
    requests: { today: store.requests(agent.id, now) },
    lastUsedAt: store.lastUsedAt(agent.id),
  };
}

const present = (deps: ControlDeps, agent: Agent) =>
  toPublic(agent, deps.store, deps.now());

/** Registers an agent and returns its key. The key is not stored and cannot be shown again. */
export function createAgent(
  deps: ControlDeps,
  input: NewAgent,
): { agent: PublicAgent; key: string } {
  const key = generateAgentKey();
  const now = deps.now();
  const agent: Agent = {
    id: newId("agt"),
    name: input.name,
    owner: input.owner,
    ownerEmail: input.ownerEmail?.toLowerCase(),
    awaitingKey: input.awaitingKey || undefined,
    team: input.team,
    purpose: input.purpose,
    providers:
      input.providers && input.providers.length > 0
        ? input.providers
        : undefined,
    keyHash: hashKey(key),
    keyHint: keyHint(key),
    status: "active",
    limits: input.limits ?? {},
    createdAt: now.toISOString(),
    endsAt: input.endsAt,
    rotation: input.rotation,
    logCalls: input.logCalls || undefined,
    keyExpiresAt:
      input.keyExpiresAt ??
      (input.rotation
        ? new Date(
            now.getTime() + input.rotation.everyDays * DAY_MS,
          ).toISOString()
        : undefined),
  };
  deps.store.createAgent(agent);
  deps.store.audit({
    at: agent.createdAt,
    type: "agent.created",
    agentId: agent.id,
    detail: {
      name: agent.name,
      owner: agent.owner,
      team: agent.team,
      limits: agent.limits,
    },
  });
  return { agent: present(deps, agent), key };
}

export interface AgentPatch {
  owner?: string | undefined;
  /** null: no longer tied to a person who signs in. */
  ownerEmail?: string | null | undefined;
  team?: string | null | undefined;
  purpose?: string | null | undefined;
  providers?: string[] | null | undefined;
  limits?: AgentLimits | undefined;
  /** null clears the end date. */
  endsAt?: string | null | undefined;
  /** null: the current key never expires. */
  keyExpiresAt?: string | null | undefined;
  /** null clears the rotation policy. */
  rotation?: RotationPolicy | null | undefined;
  /** Keep this agent's call bodies when logging is set to chosen agents. */
  logCalls?: boolean | undefined;
}

/**
 * Changes an agent's details. `limits` replaces the agent's limits as a whole, so a
 * limit left out is removed. `setLimits` merges instead.
 */
export function updateAgent(
  deps: ControlDeps,
  agent: Agent,
  patch: AgentPatch,
  by: string,
): PublicAgent {
  const next: Partial<Agent> = {};
  if (patch.owner !== undefined) next.owner = patch.owner;
  if (patch.ownerEmail !== undefined) {
    next.ownerEmail = patch.ownerEmail?.toLowerCase() ?? undefined;
  }
  if (patch.team !== undefined) next.team = patch.team ?? undefined;
  if (patch.purpose !== undefined) next.purpose = patch.purpose ?? undefined;
  if (patch.providers !== undefined) {
    next.providers =
      patch.providers && patch.providers.length > 0
        ? patch.providers
        : undefined;
  }
  if (patch.limits !== undefined) {
    next.limits = patch.limits;
  }
  if (patch.endsAt !== undefined) next.endsAt = patch.endsAt ?? undefined;
  if (patch.keyExpiresAt !== undefined) {
    next.keyExpiresAt = patch.keyExpiresAt ?? undefined;
  }
  if (patch.rotation !== undefined) next.rotation = patch.rotation ?? undefined;
  if (patch.logCalls !== undefined) next.logCalls = patch.logCalls || undefined;
  const updated = deps.store.updateAgent(agent.id, next);
  deps.store.audit({
    at: deps.now().toISOString(),
    type:
      patch.limits !== undefined && Object.keys(patch).length === 1
        ? "agent.limits_changed"
        : "agent.updated",
    agentId: agent.id,
    detail: {
      by,
      changed: Object.keys(patch),
      from: pick(agent, patch),
      to: pick(updated, patch),
    },
  });
  return present(deps, updated);
}

function pick(agent: Agent, patch: AgentPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    out[key] = agent[key as keyof Agent];
  }
  return out;
}

export interface KillResult {
  agent: PublicAgent;
  /** Requests that were running and were cut off. */
  abortedRequests: number;
  /** Time from the call to every request being refused or cut, in milliseconds. */
  elapsedMs: number;
}

/**
 * Pauses an agent. From the moment this returns, every new request with its
 * key is refused, and every request it had open has been aborted. A previous
 * key kept by a rotation grace period is revoked too.
 */
export function killAgent(
  deps: ControlDeps,
  agent: Agent,
  by: string,
): KillResult {
  const t0 = performance.now();
  const updated = deps.store.updateAgent(agent.id, {
    status: "paused",
    pausedAt: deps.now().toISOString(),
    pausedBy: by,
    previousKeyHash: undefined,
    previousKeyValidUntil: undefined,
  });
  const abortedRequests = deps.inflight.abortAll(agent.id, `paused by ${by}`);
  const elapsedMs = performance.now() - t0;
  deps.store.audit({
    at: deps.now().toISOString(),
    type: "agent.paused",
    agentId: agent.id,
    detail: { by, abortedRequests, elapsedMs },
  });
  return { agent: present(deps, updated), abortedRequests, elapsedMs };
}

export function resumeAgent(
  deps: ControlDeps,
  agent: Agent,
  by: string,
): PublicAgent {
  const updated = deps.store.updateAgent(agent.id, {
    status: "active",
    pausedAt: undefined,
    pausedBy: undefined,
  });
  deps.store.audit({
    at: deps.now().toISOString(),
    type: "agent.resumed",
    agentId: agent.id,
    detail: { by },
  });
  return present(deps, updated);
}

export function setLimits(
  deps: ControlDeps,
  agent: Agent,
  limits: AgentLimits,
  by: string,
): PublicAgent {
  return updateAgent(
    deps,
    agent,
    { limits: { ...agent.limits, ...limits } },
    by,
  );
}

/**
 * Lets an agent that hit its cap spend a set amount more, for the current UTC
 * day or month only. The normal cap is back when that window ends. Raises from
 * windows that have ended are dropped.
 */
export function raiseLimit(
  deps: ControlDeps,
  agent: Agent,
  raise: { window: "day" | "month"; amountUsd: number; reason?: string },
  by: string,
): PublicAgent {
  const now = deps.now();
  const period = windowKey(raise.window, now);
  const live = (agent.raises ?? []).filter(
    (r) => r.period === windowKey(r.window, now),
  );
  const entry = {
    window: raise.window,
    period,
    amountUsd: raise.amountUsd,
    at: now.toISOString(),
    by,
    reason: raise.reason,
  };
  const updated = deps.store.updateAgent(agent.id, {
    raises: [...live, entry],
  });
  deps.store.audit({
    at: entry.at,
    type: "agent.limit_raised",
    agentId: agent.id,
    detail: {
      by,
      window: raise.window,
      period,
      amountUsd: raise.amountUsd,
      reason: raise.reason,
    },
  });
  return present(deps, updated);
}

/**
 * Lets an agent use a service, or changes its limits there. An agent limited
 * to a list of providers gets this one added; one allowed any provider keeps
 * that, and the limit applies on this service alone.
 */
export function setService(
  deps: ControlDeps,
  agent: Agent,
  provider: string,
  limit: ServiceLimit,
  by: string,
): PublicAgent {
  const providers =
    agent.providers && !agent.providers.includes(provider)
      ? [...agent.providers, provider]
      : agent.providers;
  const updated = deps.store.updateAgent(agent.id, {
    providers,
    serviceLimits: { ...agent.serviceLimits, [provider]: limit },
  });
  deps.store.audit({
    at: deps.now().toISOString(),
    type: "agent.service_changed",
    agentId: agent.id,
    detail: { by, provider, ...limit },
  });
  return present(deps, updated);
}

/**
 * Takes a service away, with its limits. The last service on a list can't go,
 * because an empty list means any provider. An agent allowed any provider just
 * loses the limit on this one.
 */
export function removeService(
  deps: ControlDeps,
  agent: Agent,
  provider: string,
  by: string,
): PublicAgent {
  const { [provider]: _gone, ...limits } = agent.serviceLimits ?? {};
  const updated = deps.store.updateAgent(agent.id, {
    providers: agent.providers?.filter((p) => p !== provider),
    serviceLimits: Object.keys(limits).length > 0 ? limits : undefined,
  });
  deps.store.audit({
    at: deps.now().toISOString(),
    type: "agent.service_changed",
    agentId: agent.id,
    detail: { by, provider, removed: true },
  });
  return present(deps, updated);
}

export interface RotateResult {
  agent: PublicAgent;
  key: string;
  /** Until when the old key keeps working, when there is a grace period. */
  previousKeyValidUntil?: string | undefined;
}

export interface RotateOptions {
  /** How long the old key keeps working. Default: the policy's grace, else none. */
  graceMinutes?: number | undefined;
  /** When the new key expires. Default: now plus the policy's period, else never. */
  keyExpiresAt?: string | undefined;
  /** End any overlap already running, so no older key works after this. */
  cutOldKeys?: boolean | undefined;
}

/**
 * Issues a new key. With no grace period the old key stops working at once.
 * With one, the old key keeps working until the period ends (but never past
 * its own expiry), so the tool using it can be updated without downtime. A
 * key older than that, from an earlier rotation, is always revoked.
 */
export function rotateKey(
  deps: ControlDeps,
  agent: Agent,
  by: string,
  options: RotateOptions = {},
): RotateResult {
  const key = generateAgentKey();
  const now = deps.now();
  const policyGrace = agent.rotation
    ? Math.min(MAX_POLICY_GRACE_DAYS, agent.rotation.graceDays) * 1440
    : 0;
  const grace = Math.max(
    0,
    Math.floor(
      options.graceMinutes === undefined
        ? policyGrace
        : Math.min(MAX_GRACE_MINUTES, options.graceMinutes),
    ),
  );
  let graceEnds = now.getTime() + grace * 60_000;
  // An old key never outlives its own expiry.
  if (agent.keyExpiresAt !== undefined) {
    graceEnds = Math.min(graceEnds, Date.parse(agent.keyExpiresAt));
  }
  const keepPrevious = grace > 0 && graceEnds > now.getTime();
  const previousKeyValidUntil = keepPrevious
    ? new Date(graceEnds).toISOString()
    : undefined;
  const keyExpiresAt =
    options.keyExpiresAt ??
    (agent.rotation
      ? new Date(
          now.getTime() + agent.rotation.everyDays * DAY_MS,
        ).toISOString()
      : undefined);
  // Collecting a key nobody has seen: that key was never in use, so there is
  // nothing new to overlap. An overlap already running keeps its own end.
  const overlapRunning =
    !options.cutOldKeys &&
    agent.previousKeyValidUntil !== undefined &&
    Date.parse(agent.previousKeyValidUntil) > now.getTime();
  const updated = deps.store.updateAgent(agent.id, {
    keyHash: hashKey(key),
    keyHint: keyHint(key),
    keyRotatedAt: now.toISOString(),
    keyExpiresAt,
    ...(agent.awaitingKey
      ? {
          previousKeyHash: overlapRunning ? agent.previousKeyHash : undefined,
          previousKeyValidUntil: overlapRunning
            ? agent.previousKeyValidUntil
            : undefined,
        }
      : {
          previousKeyHash: keepPrevious ? agent.keyHash : undefined,
          previousKeyValidUntil,
        }),
    awaitingKey: undefined,
  });
  deps.store.audit({
    at: now.toISOString(),
    type: "agent.key_rotated",
    agentId: agent.id,
    detail: { by, graceMinutes: grace, previousKeyValidUntil, keyExpiresAt },
  });
  return {
    agent: present(deps, updated),
    key,
    previousKeyValidUntil: updated.previousKeyValidUntil,
  };
}

/**
 * Notes, once per key, that an agent tried to use an expired key. The agent
 * is not paused: rotating issues a working key.
 */
export function noteKeyExpired(deps: ControlDeps, agent: Agent): void {
  if (agent.expiryAuditedFor === agent.keyHash) return;
  deps.store.updateAgent(agent.id, { expiryAuditedFor: agent.keyHash });
  deps.store.audit({
    at: deps.now().toISOString(),
    type: "key.expired",
    agentId: agent.id,
    detail: { keyHint: agent.keyHint, keyExpiresAt: agent.keyExpiresAt },
  });
}

export type BulkAction = "kill" | "resume" | "rotate-key";

export interface BulkResult {
  results: {
    id: string;
    name?: string | undefined;
    ok: boolean;
    error?: string | undefined;
    key?: string | undefined;
  }[];
  abortedRequests?: number | undefined;
  elapsedMs: number;
}

/** Applies one action to many agents, writing the agent file once. */
export function bulk(
  deps: ControlDeps,
  action: BulkAction,
  ids: string[],
  by: string,
  rotate: RotateOptions = {},
): BulkResult {
  const t0 = performance.now();
  let aborted = 0;
  const results = deps.store.batch(() =>
    [...new Set(ids)].map((ref) => {
      const agent = deps.store.resolve(ref);
      if (!agent) return { id: ref, ok: false, error: "No such agent." };
      if (action === "kill") {
        aborted += killAgent(deps, agent, by).abortedRequests;
        return { id: agent.id, name: agent.name, ok: true };
      }
      if (action === "resume") {
        resumeAgent(deps, agent, by);
        return { id: agent.id, name: agent.name, ok: true };
      }
      const rotated = rotateKey(deps, agent, by, rotate);
      return { id: agent.id, name: agent.name, ok: true, key: rotated.key };
    }),
  );
  return {
    results,
    abortedRequests: action === "kill" ? aborted : undefined,
    elapsedMs: performance.now() - t0,
  };
}
