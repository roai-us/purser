import { formatUsd as usd } from "./money.js";
import { modelMatches } from "./pricing.js";
import type { Provider } from "./providers.js";
import { windowKey, type Store, type SpendWindow } from "./store.js";
import type { Agent } from "./types.js";

export interface Denial {
  /**
   * Always 403 for policy denials. 429 and 5xx make most SDKs retry, and an
   * agent that hit its cap should stop, not retry in a loop.
   */
  status: 403;
  code:
    | "agent_paused"
    | "agent_expired"
    | "budget_exceeded"
    | "model_not_allowed"
    | "provider_not_allowed";
  message: string;
}

/** Checks that run before Purser reads the request body. */
export function checkAgent(
  agent: Agent,
  store: Store,
  now: Date,
): Denial | null {
  if (agent.status === "paused") {
    return {
      status: 403,
      code: "agent_paused",
      message: `Agent "${agent.name}" is paused. Its owner, ${agent.owner}, can resume it in Purser.`,
    };
  }
  if (agent.endsAt !== undefined && Date.parse(agent.endsAt) <= now.getTime()) {
    return {
      status: 403,
      code: "agent_expired",
      message: `Agent "${agent.name}" reached its end date (${agent.endsAt}). Its owner, ${agent.owner}, can renew it in Purser.`,
    };
  }
  const dailyUsd = capFor(agent, "day", now);
  if (dailyUsd !== undefined) {
    const spent = store.spend(agent.id, "day", now);
    if (spent >= dailyUsd) {
      return {
        status: 403,
        code: "budget_exceeded",
        message: `Agent "${agent.name}" reached its daily cap of ${usd(dailyUsd)} (${usd(spent)} spent today, UTC). Its owner, ${agent.owner}, can raise it once in Purser.`,
      };
    }
  }
  const monthlyUsd = capFor(agent, "month", now);
  if (monthlyUsd !== undefined) {
    const spent = store.spend(agent.id, "month", now);
    if (spent >= monthlyUsd) {
      return {
        status: 403,
        code: "budget_exceeded",
        message: `Agent "${agent.name}" reached its monthly cap of ${usd(monthlyUsd)} (${usd(spent)} spent this month, UTC). Its owner, ${agent.owner}, can raise it once in Purser.`,
      };
    }
  }
  return null;
}

/** The one-time raises in force for this window right now. */
export function raisedFor(
  agent: Agent,
  window: SpendWindow,
  now: Date,
): number {
  const period = windowKey(window, now);
  let total = 0;
  for (const raise of agent.raises ?? []) {
    if (raise.window === window && raise.period === period) {
      total += raise.amountUsd;
    }
  }
  return total;
}

/** The cap that applies right now: the limit plus any raise for this window. */
export function capFor(
  agent: Agent,
  window: SpendWindow,
  now: Date,
): number | undefined {
  const base =
    window === "day" ? agent.limits.dailyUsd : agent.limits.monthlyUsd;
  return base === undefined ? undefined : base + raisedFor(agent, window, now);
}

/**
 * Checks the requested model against the service's allowlist if it has one,
 * else the agent's own.
 */
export function checkModel(
  agent: Agent,
  model: string | null,
  providerId?: string,
): Denial | null {
  const own =
    providerId === undefined
      ? undefined
      : agent.serviceLimits?.[providerId]?.models;
  const allowed = own ?? agent.limits.models;
  if (allowed === undefined || allowed.length === 0) return null;
  if (model !== null && allowed.some((family) => modelMatches(model, family))) {
    return null;
  }
  return {
    status: 403,
    code: "model_not_allowed",
    message: `Agent "${agent.name}" may not use model "${model ?? "(none)"}". Allowed: ${allowed.join(", ")}.`,
  };
}

/** Checks the connector against the agent's provider allowlist, if it has one. */
export function checkProvider(agent: Agent, provider: Provider): Denial | null {
  const allowed = agent.providers;
  if (allowed === undefined || allowed.length === 0) return null;
  if (allowed.includes(provider.id)) return null;
  return {
    status: 403,
    code: "provider_not_allowed",
    message: `Agent "${agent.name}" may not use ${provider.name}. Allowed: ${allowed.join(", ")}.`,
  };
}

/** Checks what the agent spent through this service against its limits there. */
export function checkService(
  agent: Agent,
  provider: Provider,
  store: Store,
  now: Date,
): Denial | null {
  const limit = agent.serviceLimits?.[provider.id];
  if (!limit) return null;
  const windows = [
    ["day", limit.dailyUsd, "daily", "today"],
    ["month", limit.monthlyUsd, "monthly", "this month"],
  ] as const;
  for (const [window, cap, label, when] of windows) {
    if (cap === undefined) continue;
    const spent = store.serviceSpend(agent.id, provider.id, window, now);
    if (spent >= cap) {
      return {
        status: 403,
        code: "budget_exceeded",
        message: `Agent "${agent.name}" reached its ${label} limit of ${usd(cap)} on ${provider.name} (${usd(spent)} spent ${when}, UTC). Its owner, ${agent.owner}, can change that limit in Purser.`,
      };
    }
  }
  return null;
}

/** True when the agent has spent its whole cap for the window. */
export function atCap(
  agent: Agent,
  store: Store,
  now: Date,
  window: SpendWindow,
): boolean {
  const cap = capFor(agent, window, now);
  return cap !== undefined && store.spend(agent.id, window, now) >= cap;
}
