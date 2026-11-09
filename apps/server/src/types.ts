/** A connector id, such as "openai", "openrouter" or a custom connector's id. */
export type ProviderId = string;

export interface AgentLimits {
  /** Spending cap per UTC day, in US dollars. */
  dailyUsd?: number | undefined;
  /** Spending cap per UTC calendar month, in US dollars. */
  monthlyUsd?: number | undefined;
  /** Allowed model IDs. A model is allowed if it equals an entry or starts with `entry-`. */
  models?: string[] | undefined;
}

export interface Agent {
  id: string;
  name: string;
  owner: string;
  /** The owner's company email, which ties the agent to a person who can sign in. */
  ownerEmail?: string | undefined;
  /** Approved but its owner has not collected a key yet. */
  awaitingKey?: boolean | undefined;
  /** The team or department the agent belongs to. */
  team?: string | undefined;
  purpose?: string | undefined;
  /** Connector ids this agent may use. Absent or empty: any configured connector. */
  providers?: string[] | undefined;
  /** SHA-256 of the agent key. The key itself is never stored. */
  keyHash: string;
  /** First and last characters of the key, for recognising it. */
  keyHint: string;
  keyRotatedAt?: string | undefined;
  /** After a rotation with a grace period, the old key's hash, valid until `previousKeyValidUntil`. */
  previousKeyHash?: string | undefined;
  previousKeyValidUntil?: string | undefined;
  /** When the current key stops working. Absent: it never expires. */
  keyExpiresAt?: string | undefined;
  /** The rotation policy: how long each new key lives, and the default grace for the old one. */
  rotation?: RotationPolicy | undefined;
  /** The key hash a `key.expired` audit event was last written for, so it is written once per key. */
  expiryAuditedFor?: string | undefined;
  status: "active" | "paused";
  limits: AgentLimits;
  createdAt: string;
  /** After this time the agent's key stops working. */
  endsAt?: string | undefined;
  pausedAt?: string | undefined;
  pausedBy?: string | undefined;
  /** One-time raises on top of the caps, each good only for the day or month it was given in. */
  raises?: LimitRaise[] | undefined;
  /** Keep the bodies of this agent's calls, when logging is set to chosen agents. */
  logCalls?: boolean | undefined;
  /** Limits per service, by connector id. */
  serviceLimits?: Record<string, ServiceLimit> | undefined;
}

/**
 * What an agent may do with one service (a connector), on top of its overall
 * limits. The agent's overall caps still apply; these only narrow them.
 */
export interface ServiceLimit {
  /** Spending cap for this service per UTC day, in US dollars. */
  dailyUsd?: number | undefined;
  /** Spending cap for this service per UTC calendar month, in US dollars. */
  monthlyUsd?: number | undefined;
  /** Allowed models on this service. When set, used instead of the agent's own list. */
  models?: string[] | undefined;
}

/**
 * Extra spending for one window only: "$5 more today". It lapses when the
 * UTC day or month it was given in ends, and the normal cap applies again.
 */
export interface LimitRaise {
  window: "day" | "month";
  /** The window it applies to: "2026-11-08" for a day, "2026-11" for a month. */
  period: string;
  amountUsd: number;
  at: string;
  by: string;
  reason?: string | undefined;
}

export interface RotationPolicy {
  /** Each new key works for this many days. 1 to 730. */
  everyDays: number;
  /** After a rotation, the old key keeps working this many days unless the rotation says otherwise. 0 to 30. */
  graceDays: number;
}

/** "expiring" when the current key expires within 14 days. */
export type KeyState = "ok" | "expiring" | "expired";

/**
 * What an agent is doing right now, derived from its status, end date, key and
 * spend. Only "running" can make calls; every other state is a reason it can't.
 */
export type AgentState =
  "running" | "paused" | "at_limit" | "expired" | "key_expired";

/** An agent as the admin API returns it: never includes a key hash. */
export type PublicAgent = Omit<
  Agent,
  "keyHash" | "previousKeyHash" | "expiryAuditedFor" | "raises"
> & {
  state: AgentState;
  /** One-time raises in force right now, on top of `limits`. */
  raised: { dailyUsd?: number | undefined; monthlyUsd?: number | undefined };
  keyState: KeyState;
  spend: { today: number; month: number };
  /** Spend per service, for the services it may use or has used. */
  serviceSpend: Record<string, { today: number; month: number }>;
  requests: { today: number };
  lastUsedAt?: string | undefined;
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

export interface UsageRecord extends TokenUsage {
  id: string;
  agentId: string;
  provider: ProviderId;
  endpoint: string;
  model: string;
  at: string;
  costUsd: number;
  /**
   * "provider" when the provider reported the charge itself, "table" when the
   * model was in the price table, "fallback" when it was not (priced at the
   * table's highest rate), "estimate" when the provider reported no token
   * counts and Purser estimated them from the bytes sent and received.
   */
  priced: "provider" | "table" | "fallback" | "estimate";
  /** Which of the agent's keys made the call: the current one, or the previous one during a rotation grace period. */
  key?: "current" | "previous" | undefined;
  status: number;
  durationMs: number;
  outcome: "complete" | "aborted" | "error";
  /** The request and response bodies were kept in the call log, under this record's id. */
  logged?: boolean | undefined;
}

export interface AuditEvent {
  at: string;
  type:
    | "agent.created"
    | "agent.paused"
    | "agent.resumed"
    | "agent.limits_changed"
    | "agent.key_rotated"
    | "agent.updated"
    | "agent.limit_raised"
    | "agent.service_changed"
    | "keys.rotated_all"
    | "key.expired"
    | "log.viewed"
    | "settings.changed"
    | "person.added"
    | "person.updated"
    | "person.disabled"
    | "person.enabled"
    | "person.signed_in"
    | "signin.refused"
    | "request.created"
    | "request.approved"
    | "request.denied"
    | "request.cancelled"
    | "department.changed"
    | "provider.key_set"
    | "provider.key_rotated"
    | "provider.key_rejected"
    | "provider.old_keys_deleted"
    | "provider.key_removed"
    | "request.denied";
  agentId?: string | undefined;
  detail?: Record<string, unknown> | undefined;
}

export const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
});
