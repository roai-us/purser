import {
  bulk,
  createAgent,
  raiseLimit,
  setService,
  updateAgent,
  type ControlDeps,
} from "./control.js";
import type { NewAgentAsk, Org, Person, Request } from "./org.js";
import type { Registry } from "./registry.js";
import type { Agent, PublicAgent, ServiceLimit } from "./types.js";
import { actorOf, isAdmin, managedDepartments, type Viewer } from "./viewer.js";

export interface SelfServiceDeps extends ControlDeps {
  org: Org;
  registry: Registry;
}

/** A refusal the API turns into a 4xx with this code and message. */
export class Refusal extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** New agents from self-service rotate their key every 90 days, with a week's overlap. */
const SELF_SERVICE_ROTATION = { everyDays: 90, graceDays: 7 };

export type AskResult =
  | { status: "ready"; agent: PublicAgent; key: string; request: Request }
  | { status: "pending"; request: Request };

/**
 * A person asks for an agent. Within their department's auto-approve limit
 * it is ready at once and they get its key; above it, the request waits for
 * a manager or admin. Over the department's maximum, or with a provider the
 * department does not allow, it is refused outright.
 */
export function askForAgent(
  deps: SelfServiceDeps,
  person: Person,
  ask: NewAgentAsk & { reason?: string | undefined },
): AskResult {
  if (!deps.org.settings().selfService) {
    throw new Refusal(
      403,
      "self_service_off",
      "Your admins have turned off asking for agents in Purser. Ask them directly.",
    );
  }
  checkAsk(deps, person.department, ask);
  const { reason, ...agentAsk } = ask;
  const base = {
    kind: "agent" as const,
    by: person.email,
    byName: person.name,
    department: person.department,
    reason,
    agent: agentAsk,
  };
  const policy = deps.org.policyFor(person.department);
  if (ask.dailyUsd <= policy.autoApproveDailyUsd) {
    const { agent, key } = createAgent(deps, {
      name: ask.name,
      owner: person.name,
      ownerEmail: person.email,
      team: person.department,
      purpose: ask.purpose,
      providers: ask.providers,
      limits: {
        dailyUsd: ask.dailyUsd,
        ...(ask.monthlyUsd !== undefined ? { monthlyUsd: ask.monthlyUsd } : {}),
      },
      rotation: SELF_SERVICE_ROTATION,
    });
    const request = deps.org.addRequest(base);
    const done = deps.org.updateRequest(request.id, {
      status: "approved",
      decidedAt: deps.now().toISOString(),
      decidedBy: "auto",
      note: `Within the ${person.department ?? "default"} auto-approve limit.`,
      agentId: agent.id,
    });
    audit(deps, "request.approved", done, "auto", agent.id);
    return { status: "ready", agent, key, request: done };
  }
  const request = deps.org.addRequest(base);
  audit(deps, "request.created", request, person.email);
  return { status: "pending", request };
}

/** A person asks for a one-time raise on an agent they own. */
export function askForRaise(
  deps: SelfServiceDeps,
  person: Pick<Person, "email" | "name">,
  agentId: string,
  ask: {
    window: "day" | "month";
    amountUsd: number;
    reason?: string | undefined;
  },
  askedByAgent?: Request["askedByAgent"],
): Request {
  const agent = deps.store.getAgent(agentId);
  if (!agent) throw new Refusal(404, "not_found", "No such agent.");
  const request = deps.org.addRequest({
    kind: "raise",
    by: person.email,
    byName: person.name,
    department: agent.team,
    reason: ask.reason,
    askedByAgent,
    raise: {
      agentId: agent.id,
      agentName: agent.name,
      window: ask.window,
      amountUsd: ask.amountUsd,
    },
  });
  audit(deps, "request.created", request, person.email, agent.id);
  return request;
}

export interface NewServiceAsk {
  provider: string;
  dailyUsd: number;
  monthlyUsd?: number | undefined;
  models?: string[] | undefined;
  reason?: string | undefined;
}

export type ServiceAskResult =
  | { status: "granted"; agent: PublicAgent; request: Request }
  | { status: "pending"; request: Request };

const serviceLimit = (ask: NewServiceAsk): ServiceLimit => ({
  dailyUsd: ask.dailyUsd,
  ...(ask.monthlyUsd !== undefined ? { monthlyUsd: ask.monthlyUsd } : {}),
  ...(ask.models?.length ? { models: ask.models } : {}),
});

/**
 * Someone asks for an agent to get another service, such as a second model
 * to check its work. Within the department's auto-approve limit it is
 * granted at once; above it, a manager decides. When the agent itself asks,
 * a person always decides: its owner if the amount is within that limit, a
 * manager if not.
 */
export function askForService(
  deps: SelfServiceDeps,
  asker: Pick<Person, "email" | "name">,
  agent: Agent,
  ask: NewServiceAsk,
  askedByAgent?: Request["askedByAgent"],
): ServiceAskResult {
  if (!deps.org.settings().selfService) {
    throw new Refusal(
      403,
      "self_service_off",
      "Your admins have turned off asking in Purser. Ask them directly.",
    );
  }
  const department = agent.team;
  const provider = deps.registry.get(ask.provider);
  if (!provider) {
    throw new Refusal(
      400,
      "unknown_provider",
      `Unknown provider ${ask.provider}.`,
    );
  }
  const policy = deps.org.policyFor(department);
  if (
    policy.allowedProviders &&
    !policy.allowedProviders.includes(ask.provider)
  ) {
    throw new Refusal(
      400,
      "provider_not_allowed",
      `${department ?? "This department"} can't use ${provider.name}.`,
    );
  }
  if (ask.dailyUsd > policy.maxDailyUsd) {
    throw new Refusal(
      400,
      "over_max",
      `The most an agent in ${department ?? "this department"} may spend per day is $${policy.maxDailyUsd}.`,
    );
  }
  const withinAuto = ask.dailyUsd <= policy.autoApproveDailyUsd;
  const base = {
    kind: "service" as const,
    by: asker.email,
    byName: asker.name,
    department,
    reason: ask.reason,
    askedByAgent,
    ownerMayDecide: askedByAgent && withinAuto ? true : undefined,
    service: {
      agentId: agent.id,
      agentName: agent.name,
      provider: provider.id,
      providerName: provider.name,
      dailyUsd: ask.dailyUsd,
      monthlyUsd: ask.monthlyUsd,
      models: ask.models?.length ? ask.models : undefined,
    },
  };
  if (withinAuto && !askedByAgent) {
    const updated = setService(
      deps,
      agent,
      provider.id,
      serviceLimit(ask),
      asker.email,
    );
    const request = deps.org.addRequest(base);
    const done = deps.org.updateRequest(request.id, {
      status: "approved",
      decidedAt: deps.now().toISOString(),
      decidedBy: "auto",
      note: `Within the ${department ?? "default"} auto-approve limit.`,
      agentId: agent.id,
    });
    audit(deps, "request.approved", done, "auto", agent.id);
    return { status: "granted", agent: updated, request: done };
  }
  const request = deps.org.addRequest(base);
  audit(deps, "request.created", request, asker.email, agent.id);
  return { status: "pending", request };
}

/** Throws unless the ask fits the department's rules and the agent name is free. */
function checkAsk(
  deps: SelfServiceDeps,
  department: string | undefined,
  ask: NewAgentAsk,
): void {
  const policy = deps.org.policyFor(department);
  if (ask.dailyUsd > policy.maxDailyUsd) {
    throw new Refusal(
      400,
      "over_max",
      `The most an agent in ${department ?? "your department"} may spend per day is $${policy.maxDailyUsd}.`,
    );
  }
  for (const id of ask.providers ?? []) {
    if (!deps.registry.has(id)) {
      throw new Refusal(400, "unknown_provider", `Unknown provider ${id}.`);
    }
    if (policy.allowedProviders && !policy.allowedProviders.includes(id)) {
      throw new Refusal(
        400,
        "provider_not_allowed",
        `${department ?? "Your department"} can't use ${deps.registry.get(id)?.name ?? id}.`,
      );
    }
  }
  if (deps.store.findByName(ask.name)) {
    throw new Refusal(
      409,
      "name_taken",
      `There is already an agent called ${ask.name}.`,
    );
  }
}

/**
 * Who may decide a request: admins, and managers of its department. Nobody
 * decides their own request, unless they are an admin.
 */
export function canDecide(viewer: Viewer, request: Request): boolean {
  if (isAdmin(viewer)) return true;
  if (viewer.kind === "person" && viewer.person.email === request.by) {
    return request.ownerMayDecide === true;
  }
  const depts = managedDepartments(viewer);
  return (
    depts === "all" ||
    (request.department !== undefined && depts.includes(request.department))
  );
}

/** The requests a viewer may decide, pending first, newest first. */
export function decidable(org: Org, viewer: Viewer): Request[] {
  return org
    .listRequests()
    .filter((r) => canDecide(viewer, r))
    .sort(newestPendingFirst);
}

export function newestPendingFirst(a: Request, b: Request): number {
  if ((a.status === "pending") !== (b.status === "pending")) {
    return a.status === "pending" ? -1 : 1;
  }
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
}

/**
 * Approves a request. A new agent is created for the person who asked, with
 * a key nobody has seen: they collect a fresh one from their agent's page.
 * A raise is applied for the current day or month.
 */
export function approve(
  deps: SelfServiceDeps,
  viewer: Viewer,
  request: Request,
  note?: string,
): Request {
  pendingOrThrow(viewer, request);
  const by = actorOf(viewer);
  let agentId: string | undefined;
  if (request.kind === "agent" && request.agent) {
    if (deps.store.findByName(request.agent.name)) {
      throw new Refusal(
        409,
        "name_taken",
        `An agent called ${request.agent.name} was added since this was asked. Deny it and ask for a new name.`,
      );
    }
    const asker = deps.org.findByEmail(request.by);
    const { agent } = createAgent(deps, {
      name: request.agent.name,
      owner: asker?.name ?? request.byName,
      ownerEmail: request.by,
      team: request.department,
      purpose: request.agent.purpose,
      providers: request.agent.providers,
      limits: {
        dailyUsd: request.agent.dailyUsd,
        ...(request.agent.monthlyUsd !== undefined
          ? { monthlyUsd: request.agent.monthlyUsd }
          : {}),
      },
      rotation: SELF_SERVICE_ROTATION,
      awaitingKey: true,
    });
    agentId = agent.id;
  }
  if (request.kind === "raise" && request.raise) {
    const agent = deps.store.getAgent(request.raise.agentId);
    if (!agent) throw new Refusal(404, "not_found", "That agent is gone.");
    raiseLimit(
      deps,
      agent,
      {
        window: request.raise.window,
        amountUsd: request.raise.amountUsd,
        reason: `Approved request from ${request.byName}${request.reason ? `: ${request.reason}` : ""}`,
      },
      by,
    );
    agentId = agent.id;
  }
  if (request.kind === "service" && request.service) {
    const agent = deps.store.getAgent(request.service.agentId);
    if (!agent) throw new Refusal(404, "not_found", "That agent is gone.");
    const { dailyUsd, monthlyUsd, models, provider } = request.service;
    setService(
      deps,
      agent,
      provider,
      serviceLimit({ provider, dailyUsd, monthlyUsd, models }),
      by,
    );
    agentId = agent.id;
  }
  const done = deps.org.updateRequest(request.id, {
    status: "approved",
    decidedAt: deps.now().toISOString(),
    decidedBy: by,
    decidedByName:
      viewer.kind === "person" ? viewer.person.name : "Purser admin",
    note,
    agentId,
  });
  audit(deps, "request.approved", done, by, agentId);
  return done;
}

export function deny(
  deps: SelfServiceDeps,
  viewer: Viewer,
  request: Request,
  note?: string,
): Request {
  pendingOrThrow(viewer, request);
  const by = actorOf(viewer);
  const done = deps.org.updateRequest(request.id, {
    status: "denied",
    decidedAt: deps.now().toISOString(),
    decidedBy: by,
    decidedByName:
      viewer.kind === "person" ? viewer.person.name : "Purser admin",
    note,
  });
  audit(deps, "request.denied", done, by);
  return done;
}

export function cancel(
  deps: SelfServiceDeps,
  person: Person,
  request: Request,
): Request {
  if (request.by !== person.email) {
    throw new Refusal(
      403,
      "forbidden",
      "You can only cancel your own requests.",
    );
  }
  if (request.status !== "pending") {
    throw new Refusal(
      409,
      "already_decided",
      "This request was already decided.",
    );
  }
  const done = deps.org.updateRequest(request.id, { status: "cancelled" });
  audit(deps, "request.cancelled", done, person.email);
  return done;
}

function pendingOrThrow(viewer: Viewer, request: Request): void {
  if (!canDecide(viewer, request)) {
    throw new Refusal(
      403,
      "forbidden",
      viewer.kind === "person" && viewer.person.email === request.by
        ? "Someone else has to decide your own request."
        : "Only its department's managers or an admin can decide this.",
    );
  }
  if (request.status !== "pending") {
    throw new Refusal(
      409,
      "already_decided",
      "This request was already decided.",
    );
  }
}

function audit(
  deps: SelfServiceDeps,
  type:
    | "request.created"
    | "request.approved"
    | "request.denied"
    | "request.cancelled",
  request: Request,
  by: string,
  agentId?: string,
): void {
  deps.store.audit({
    at: deps.now().toISOString(),
    type,
    agentId:
      agentId ??
      request.agentId ??
      request.raise?.agentId ??
      request.service?.agentId,
    detail: {
      by,
      request: request.id,
      kind: request.kind,
      for: request.by,
      askedByAgent: request.askedByAgent?.name,
      provider: request.service?.provider,
      name:
        request.agent?.name ??
        request.raise?.agentName ??
        request.service?.agentName,
      dailyUsd: request.agent?.dailyUsd ?? request.service?.dailyUsd,
      amountUsd: request.raise?.amountUsd,
      note: request.note,
    },
  });
}

export interface OffboardResult {
  person: Person;
  /** Agents stopped because their owner left. */
  stopped: number;
  /** Agents handed to someone else instead. */
  reassigned: number;
  sessionsEnded: number;
}

/**
 * Turns off a person's access, as when they leave: signs them out everywhere,
 * cancels their pending requests, and either hands their agents to someone
 * else or stops them all at once.
 */
export function offboard(
  deps: SelfServiceDeps & { endSessions: (personId: string) => number },
  viewer: Viewer,
  person: Person,
  reassignTo?: Person,
): OffboardResult {
  const by = actorOf(viewer);
  const now = deps.now().toISOString();
  const updated = deps.org.updatePerson(person.id, {
    status: "disabled",
    disabledAt: now,
    disabledBy: by,
  });
  const sessionsEnded = deps.endSessions(person.id);
  for (const r of deps.org.listRequests()) {
    if (r.by === person.email && r.status === "pending") {
      deps.org.updateRequest(r.id, {
        status: "cancelled",
        note: "The person who asked left.",
      });
    }
  }
  const theirs = deps.store
    .listAgents()
    .filter((a) => a.ownerEmail === person.email);
  let stopped = 0;
  let reassigned = 0;
  if (reassignTo) {
    deps.store.batch(() => {
      for (const agent of theirs) {
        updateAgent(
          deps,
          agent,
          { owner: reassignTo.name, ownerEmail: reassignTo.email },
          by,
        );
        reassigned++;
      }
    });
  } else {
    const active = theirs.filter((a) => a.status === "active");
    if (active.length > 0) {
      bulk(
        deps,
        "kill",
        active.map((a) => a.id),
        `${by} (${person.email} left)`,
      );
    }
    stopped = active.length;
  }
  deps.store.audit({
    at: now,
    type: "person.disabled",
    detail: {
      by,
      person: person.email,
      stopped,
      reassigned,
      reassignedTo: reassignTo?.email,
      sessionsEnded,
    },
  });
  return { person: updated, stopped, reassigned, sessionsEnded };
}
