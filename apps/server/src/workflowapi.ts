import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { apiError } from "./admin.js";
import type { Alerts } from "./alerts.js";
import { agentState, findAgentByKey, noteKeyExpired } from "./control.js";
import type { ControlDeps } from "./control.js";
import { buildReport, defaultPeriod, periodDays, type Period } from "./roi.js";
import type { Agent } from "./types.js";
import type { Viewer } from "./viewer.js";
import {
  LOCKED_FIELDS,
  type Outcome,
  type Workflow,
  type WorkflowCosts,
  type Workflows,
} from "./workflows.js";

export interface WorkflowDeps extends ControlDeps {
  workflows: Workflows;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The longest period one report covers. */
const MAX_PERIOD_DAYS = 366;
/** The most units one agent report may carry. People entering tallies may send more. */
export const MAX_AGENT_COUNT = 1_000;
const MAX_PERSON_COUNT = 100_000;

const money = z.number().finite().min(0).max(1_000_000_000);
const day = z
  .string()
  .regex(DAY, "Use a day like 2026-10-01.")
  .refine(
    (d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)),
    "Not a real day.",
  );

const thresholdSchema = z
  .object({
    metric: z.enum([
      "cost_per_accepted_unit",
      "acceptance_rate",
      "net_monthly_return",
    ]),
    when: z.enum(["above", "below"]),
    value: z.number().finite().min(-1_000_000_000).max(1_000_000_000),
  })
  .strict()
  .refine(
    (t) => t.metric !== "acceptance_rate" || (t.value >= 0 && t.value <= 1),
    { message: "An acceptance rate is a fraction from 0 to 1." },
  );

const baselineSchema = z
  .object({
    minutesPerUnit: z.number().finite().min(0.1).max(100_000),
    hourlyCostUsd: z.number().finite().min(0).max(100_000),
    unitsPerMonth: z.number().finite().min(0).max(1_000_000_000).optional(),
    measuredOn: day,
    method: z.string().trim().min(1).max(500),
    source: z.enum(["measured", "estimated"]),
  })
  .strict();

const costsSchema = z
  .object({
    implementationUsd: money.optional(),
    monthlyMaintenanceUsd: money.optional(),
    monthlyEvaluationUsd: money.optional(),
    discountRate: z.number().finite().min(0).max(1).optional(),
  })
  .strict();

const name = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(
    /^[\w.-]+( [\w.-]+)*$/,
    "Use letters, numbers, single spaces, dots, dashes and underscores.",
  );
const agentRefs = z.array(z.string().min(1).max(200)).max(200);

const newWorkflowSchema = z
  .object({
    name,
    unit: z.string().trim().min(1).max(200),
    owner: z.string().trim().min(1).max(200),
    ownerEmail: z.email().max(200).optional(),
    team: z.string().trim().min(1).max(100).optional(),
    agents: agentRefs.optional(),
    baseline: baselineSchema,
    attribution: z.enum(["holdout", "before_after", "modelled"]),
    defaultReviewMinutes: z.number().finite().min(0).max(10_000).optional(),
    costs: costsSchema.optional(),
    stopIf: thresholdSchema,
    scaleIf: thresholdSchema.optional(),
    minUnits: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict();

const patchWorkflowSchema = z
  .object({
    name: name.optional(),
    unit: z.string().trim().min(1).max(200).optional(),
    owner: z.string().trim().min(1).max(200).optional(),
    ownerEmail: z.email().max(200).nullable().optional(),
    team: z.string().trim().min(1).max(100).nullable().optional(),
    agents: agentRefs.optional(),
    baseline: baselineSchema.optional(),
    attribution: z.enum(["holdout", "before_after", "modelled"]).optional(),
    defaultReviewMinutes: z.number().finite().min(0).max(10_000).optional(),
    costs: costsSchema.optional(),
    stopIf: thresholdSchema.optional(),
    scaleIf: thresholdSchema.nullable().optional(),
    minUnits: z.number().int().min(1).max(1_000_000).optional(),
    status: z.enum(["active", "archived"]).optional(),
  })
  .strict();

/** Fields that change the numbers. Changing one after the lock shows on every report. */
const NUMBER_FIELDS = new Set(["agents", "defaultReviewMinutes", "costs"]);

const outcomeFields = {
  result: z.enum(["accepted", "reworked", "discarded"]),
  reviewMinutes: z.number().finite().min(0).max(10_000_000).optional(),
  ref: z.string().trim().min(1).max(200).optional(),
  note: z.string().trim().max(500).optional(),
};

const personOutcomeSchema = z
  .object({
    ...outcomeFields,
    count: z.number().int().min(1).max(MAX_PERSON_COUNT).optional(),
    /** When the results happened, for a tally entered later. */
    at: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const agentOutcomeSchema = z
  .object({
    ...outcomeFields,
    /** The workflow's id or name. Optional when the agent is in only one. */
    workflow: z.string().min(1).max(200).optional(),
    count: z.number().int().min(1).max(MAX_AGENT_COUNT).optional(),
  })
  .strict();

export type AgentOutcomeInput = z.infer<typeof agentOutcomeSchema>;

const DEFAULT_COSTS: WorkflowCosts = {
  implementationUsd: 0,
  monthlyMaintenanceUsd: 0,
  monthlyEvaluationUsd: 0,
  discountRate: 0.1,
};

/** Costs with the given fields replaced; fields left out keep their value. */
function mergeCosts(
  base: WorkflowCosts,
  input: z.infer<typeof costsSchema>,
): WorkflowCosts {
  const out = { ...base };
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key as keyof WorkflowCosts] = value;
  }
  return out;
}

/** A refusal with an HTTP status, shared by the agent API and the MCP tool. */
export class OutcomeRefusal extends Error {
  constructor(
    public readonly status: 400 | 404 | 409,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type RecordedOutcome =
  | { duplicate: false; outcome: Outcome; workflow: Workflow; locked: boolean }
  | { duplicate: true; outcome: Outcome; workflow: Workflow };

/**
 * Records a result an agent reported with its own key. The agent must be
 * linked to the workflow; a retry with the same `ref` returns the first one.
 */
export function reportAgentOutcome(
  deps: WorkflowDeps,
  agent: Agent,
  input: AgentOutcomeInput,
): RecordedOutcome {
  let workflow: Workflow | undefined;
  if (input.workflow === undefined) {
    const mine = deps.workflows
      .list()
      .filter((w) => w.status === "active" && w.agents.includes(agent.id));
    if (mine.length === 0) {
      throw new OutcomeRefusal(
        404,
        "no_workflow",
        "This agent isn't part of any workflow. Ask its owner to add it to one.",
      );
    }
    if (mine.length > 1) {
      throw new OutcomeRefusal(
        400,
        "which_workflow",
        `This agent is in more than one workflow. Say which: ${mine.map((w) => w.name).join(", ")}.`,
      );
    }
    workflow = mine[0];
  } else {
    workflow = deps.workflows.resolve(input.workflow);
    if (!workflow?.agents.includes(agent.id)) {
      throw new OutcomeRefusal(
        404,
        "no_workflow",
        "No workflow by that name includes this agent.",
      );
    }
  }
  if (!workflow) throw new Error("unreachable");
  if (workflow.status !== "active") {
    throw new OutcomeRefusal(
      409,
      "archived",
      `The workflow "${workflow.name}" is archived and takes no more results.`,
    );
  }
  return record(deps, workflow, {
    result: input.result,
    count: input.count ?? 1,
    reviewMinutes: input.reviewMinutes,
    ref: input.ref,
    note: input.note,
    at: deps.now().toISOString(),
    source: "agent",
    by: agent.id,
    agentId: agent.id,
  });
}

function record(
  deps: WorkflowDeps,
  workflow: Workflow,
  input: Omit<Outcome, "id" | "workflowId" | "recordedAt">,
): RecordedOutcome {
  if (input.ref !== undefined) {
    const seen = deps.workflows.byRef(workflow.id, input.ref);
    if (seen) return { duplicate: true, outcome: seen, workflow };
  }
  const { outcome, locked } = deps.workflows.record({
    ...input,
    workflowId: workflow.id,
    recordedAt: deps.now().toISOString(),
  });
  if (locked) {
    deps.store.audit({
      at: outcome.recordedAt,
      type: "workflow.locked",
      detail: { workflow: workflow.name, fields: [...LOCKED_FIELDS] },
    });
  }
  return {
    duplicate: false,
    outcome,
    workflow: deps.workflows.get(workflow.id) ?? workflow,
    locked,
  };
}

/** The usage records of a workflow's agents. */
function usageOf(deps: WorkflowDeps, workflow: Workflow) {
  return workflow.agents.flatMap((id) => deps.store.usageOf(id));
}

export function reportFor(
  deps: WorkflowDeps,
  workflow: Workflow,
  period: Period,
) {
  return buildReport(
    workflow,
    deps.workflows.outcomesOf(workflow.id),
    usageOf(deps, workflow),
    period,
  );
}

/**
 * Admin routes for workflows, their results and their ROI reports. Added to
 * the admin app, behind its admin check.
 */
export function workflowRoutes(
  app: Hono<{ Variables: { actor: string; viewer: Viewer } }>,
  deps: WorkflowDeps,
): void {
  const now = () => deps.now();

  const json = async (c: Context): Promise<unknown> => {
    const text = await c.req.text();
    if (text.trim() === "") return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  };
  const invalid = (c: Context, what: string, issues: unknown) =>
    apiError(c, 400, "invalid_request", `Invalid ${what}.`, issues);

  const find = (c: Context): Workflow | Response =>
    deps.workflows.resolve(c.req.param("ref") ?? "") ??
    apiError(c, 404, "not_found", "No such workflow.");

  /** Agent refs to ids, or a response naming what's wrong. */
  const agentIds = (
    c: Context,
    refs: string[],
    self: Workflow | undefined,
  ): string[] | Response => {
    const ids: string[] = [];
    for (const ref of refs) {
      const agent = deps.store.resolve(ref);
      if (!agent) {
        return apiError(c, 400, "unknown_agent", `No agent "${ref}".`);
      }
      const other = deps.workflows.forAgent(agent.id);
      if (other && other.id !== self?.id) {
        return apiError(
          c,
          409,
          "agent_in_workflow",
          `"${agent.name}" already counts toward "${other.name}". An agent's spend counts toward one workflow at a time.`,
        );
      }
      if (!ids.includes(agent.id)) ids.push(agent.id);
    }
    return ids;
  };

  const period = (c: Context): Period | Response => {
    const from = c.req.query("from");
    const to = c.req.query("to");
    for (const d of [from, to]) {
      if (d !== undefined && !day.safeParse(d).success) {
        return apiError(
          c,
          400,
          "invalid_request",
          "from and to must be days, like 2026-11-01.",
        );
      }
    }
    const fallback = defaultPeriod(now());
    const end = to ?? fallback.to;
    const start =
      from ??
      new Date(Date.parse(`${end}T00:00:00Z`) - 29 * 86_400_000)
        .toISOString()
        .slice(0, 10);
    if (start > end) {
      return apiError(c, 400, "invalid_request", "from must not be after to.");
    }
    const p = { from: start, to: end };
    if (periodDays(p) > MAX_PERIOD_DAYS) {
      return apiError(
        c,
        400,
        "invalid_request",
        `A report covers at most ${MAX_PERIOD_DAYS} days.`,
      );
    }
    return p;
  };

  const agentsOf = (workflow: Workflow) => {
    const at = now();
    return workflow.agents.map((id) => {
      const agent = deps.store.getAgent(id);
      return agent
        ? { id, name: agent.name, state: agentState(agent, deps.store, at) }
        : { id, name: null, state: null };
    });
  };

  const summary = (workflow: Workflow) => {
    const r = reportFor(deps, workflow, defaultPeriod(now()));
    return {
      ...workflow,
      summary: {
        period: r.period,
        verdict: r.verdict,
        results: r.results.total,
        acceptanceRate: r.results.acceptanceRate,
        costPerAcceptedUnit: r.perUnit.costPerAcceptedUnit,
        baselineCostPerUnit: r.perUnit.baseline,
        netMonthlyReturn: r.netMonthlyReturn,
      },
    };
  };

  app.get("/workflows", (c) => {
    const status = c.req.query("status") ?? "active";
    const list = deps.workflows
      .list()
      .filter((w) => status === "all" || w.status === status)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(summary);
    return c.json({ workflows: list });
  });

  app.post("/workflows", async (c) => {
    const parsed = newWorkflowSchema.safeParse(await json(c));
    if (!parsed.success) return invalid(c, "workflow", parsed.error.issues);
    const input = parsed.data;
    if (deps.workflows.resolve(input.name)) {
      return apiError(
        c,
        409,
        "name_taken",
        `A workflow named "${input.name}" already exists.`,
      );
    }
    const ids = agentIds(c, input.agents ?? [], undefined);
    if (ids instanceof Response) return ids;
    const at = now().toISOString();
    const workflow = deps.workflows.create(
      {
        name: input.name,
        unit: input.unit,
        owner: input.owner,
        ownerEmail: input.ownerEmail,
        team: input.team,
        agents: ids,
        baseline: input.baseline,
        attribution: input.attribution,
        defaultReviewMinutes: input.defaultReviewMinutes ?? 0,
        costs: mergeCosts(DEFAULT_COSTS, input.costs ?? {}),
        stopIf: input.stopIf,
        scaleIf: input.scaleIf,
        minUnits: input.minUnits ?? 30,
        createdBy: c.get("actor"),
      },
      at,
    );
    deps.store.audit({
      at,
      type: "workflow.created",
      detail: { workflow: workflow.name, by: c.get("actor") },
    });
    return c.json({ workflow, agents: agentsOf(workflow) }, 201);
  });

  app.get("/workflows/:ref", (c) => {
    const workflow = find(c);
    if (workflow instanceof Response) return workflow;
    return c.json({
      workflow,
      agents: agentsOf(workflow),
      report: reportFor(deps, workflow, defaultPeriod(now())),
    });
  });

  app.patch("/workflows/:ref", async (c) => {
    const workflow = find(c);
    if (workflow instanceof Response) return workflow;
    const parsed = patchWorkflowSchema.safeParse(await json(c));
    if (!parsed.success) return invalid(c, "change", parsed.error.issues);
    const input = parsed.data;
    if (workflow.lockedAt !== undefined) {
      // Sending a locked field back unchanged is fine; changing it is not.
      const locked = LOCKED_FIELDS.filter(
        (f) =>
          input[f] !== undefined &&
          JSON.stringify(input[f] ?? undefined) !== JSON.stringify(workflow[f]),
      );
      if (locked.length > 0) {
        return apiError(
          c,
          409,
          "locked",
          `${locked.join(", ")} locked on ${workflow.lockedAt.slice(0, 10)}, when the first result arrived. To judge by new rules, start a new workflow.`,
        );
      }
    }
    if (
      input.name !== undefined &&
      input.name !== workflow.name &&
      deps.workflows.resolve(input.name)
    ) {
      return apiError(
        c,
        409,
        "name_taken",
        `A workflow named "${input.name}" already exists.`,
      );
    }
    const patch: Partial<Workflow> = {};
    if (input.agents !== undefined) {
      const ids = agentIds(c, input.agents, workflow);
      if (ids instanceof Response) return ids;
      patch.agents = ids;
    }
    if (input.status === "active" && workflow.status === "archived") {
      const taken = workflow.agents
        .map((id) => deps.workflows.forAgent(id))
        .find((w) => w !== undefined);
      if (taken) {
        return apiError(
          c,
          409,
          "agent_in_workflow",
          `An agent of this workflow now counts toward "${taken.name}".`,
        );
      }
    }
    for (const key of [
      "name",
      "unit",
      "owner",
      "baseline",
      "attribution",
      "defaultReviewMinutes",
      "stopIf",
      "minUnits",
      "status",
    ] as const) {
      if (input[key] !== undefined) Object.assign(patch, { [key]: input[key] });
    }
    for (const key of ["ownerEmail", "team", "scaleIf"] as const) {
      if (input[key] !== undefined) {
        Object.assign(patch, { [key]: input[key] ?? undefined });
      }
    }
    if (input.costs !== undefined) {
      patch.costs = mergeCosts(workflow.costs, input.costs);
    }
    const changed = Object.keys(patch).filter(
      (k) =>
        JSON.stringify(patch[k as keyof Workflow]) !==
        JSON.stringify(workflow[k as keyof Workflow]),
    );
    if (changed.length === 0) {
      return c.json({ workflow, agents: agentsOf(workflow) });
    }
    const at = now().toISOString();
    const numbers = changed.filter((k) => NUMBER_FIELDS.has(k));
    if (workflow.lockedAt !== undefined && numbers.length > 0) {
      patch.changedAfterLock = [
        ...(workflow.changedAfterLock ?? []),
        { at, by: c.get("actor"), fields: numbers },
      ];
    }
    const next = deps.workflows.update(workflow.id, patch);
    deps.store.audit({
      at,
      type: "workflow.updated",
      detail: { workflow: next.name, by: c.get("actor"), fields: changed },
    });
    return c.json({ workflow: next, agents: agentsOf(next) });
  });

  app.get("/workflows/:ref/report", (c) => {
    const workflow = find(c);
    if (workflow instanceof Response) return workflow;
    const p = period(c);
    if (p instanceof Response) return p;
    return c.json({
      workflow,
      agents: agentsOf(workflow),
      report: reportFor(deps, workflow, p),
    });
  });

  app.get("/workflows/:ref/outcomes", (c) => {
    const workflow = find(c);
    if (workflow instanceof Response) return workflow;
    const limit = Math.min(
      Math.max(Number(c.req.query("limit") ?? 100) || 100, 1),
      1000,
    );
    const all = deps.workflows.outcomesOf(workflow.id);
    return c.json({
      outcomes: all.slice(-limit).reverse(),
      total: all.length,
    });
  });

  app.post("/workflows/:ref/outcomes", async (c) => {
    const workflow = find(c);
    if (workflow instanceof Response) return workflow;
    const parsed = personOutcomeSchema.safeParse(await json(c));
    if (!parsed.success) return invalid(c, "result", parsed.error.issues);
    const input = parsed.data;
    if (workflow.status !== "active") {
      return apiError(
        c,
        409,
        "archived",
        `The workflow "${workflow.name}" is archived and takes no more results.`,
      );
    }
    const at = input.at ?? now().toISOString();
    if (Date.parse(at) > now().getTime()) {
      return apiError(
        c,
        400,
        "invalid_request",
        "at must not be in the future.",
      );
    }
    if (Date.parse(at) < Date.parse(workflow.createdAt)) {
      return apiError(
        c,
        400,
        "invalid_request",
        "Results can't be dated before the workflow was set up, when its rules were written down.",
      );
    }
    const done = record(deps, workflow, {
      result: input.result,
      count: input.count ?? 1,
      reviewMinutes: input.reviewMinutes,
      ref: input.ref,
      note: input.note,
      at: new Date(Date.parse(at)).toISOString(),
      source: "person",
      by: c.get("actor"),
    });
    if (done.duplicate) {
      return c.json({ outcome: done.outcome, duplicate: true });
    }
    deps.store.audit({
      at: now().toISOString(),
      type: "outcome.recorded",
      detail: {
        workflow: workflow.name,
        by: c.get("actor"),
        result: done.outcome.result,
        count: done.outcome.count,
      },
    });
    return c.json(
      { outcome: done.outcome, duplicate: false, locked: done.locked },
      201,
    );
  });

  app.post("/workflows/:ref/outcomes/:id/void", (c) => {
    const workflow = find(c);
    if (workflow instanceof Response) return workflow;
    const outcome = deps.workflows.getOutcome(c.req.param("id"));
    if (outcome?.workflowId !== workflow.id) {
      return apiError(c, 404, "not_found", "No such result in this workflow.");
    }
    const at = now().toISOString();
    const already = outcome.voidedAt !== undefined;
    const voided = deps.workflows.void(outcome.id, at, c.get("actor"));
    if (!already) {
      deps.store.audit({
        at,
        type: "outcome.voided",
        detail: {
          workflow: workflow.name,
          by: c.get("actor"),
          outcome: outcome.id,
          result: outcome.result,
          count: outcome.count,
        },
      });
    }
    return c.json({ outcome: voided });
  });
}

/** The bearer token or x-api-key an agent sends. */
function agentKey(c: Context): string | undefined {
  const header = c.req.header("authorization");
  const match = header ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  return match?.[1]?.trim() ?? c.req.header("x-api-key")?.trim();
}

/**
 * The agent-facing results API: `POST /v1/outcomes` with the agent's own
 * Purser key. It records results only; it can't read reports or change a
 * workflow, and every result it records is marked as reported by the agent.
 */
export function outcomesApp(deps: WorkflowDeps): Hono {
  const app = new Hono();
  const fail = (
    c: Context,
    status: 400 | 401 | 403 | 404 | 409 | 413,
    code: string,
    message: string,
    issues?: unknown,
  ) =>
    c.json(
      { error: { code, message, ...(issues === undefined ? {} : { issues }) } },
      status,
    );

  app.post(
    "/outcomes",
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) => fail(c, 413, "too_large", "Send one result at a time."),
    }),
    async (c) => {
      const key = agentKey(c);
      const at = deps.now();
      const match = key ? findAgentByKey(deps.store, key, at) : null;
      if (!match) {
        return fail(
          c,
          401,
          "unauthorized",
          "Send this agent's Purser key as a bearer token.",
        );
      }
      const { agent, which } = match;
      if (
        which === "current" &&
        agent.keyExpiresAt !== undefined &&
        Date.parse(agent.keyExpiresAt) <= at.getTime()
      ) {
        noteKeyExpired(deps, agent);
        return fail(
          c,
          403,
          "key_expired",
          `This agent's key expired on ${agent.keyExpiresAt.slice(0, 10)}.`,
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(await c.req.text()) as unknown;
      } catch {
        return fail(c, 400, "invalid_json", "The request body must be JSON.");
      }
      const parsed = agentOutcomeSchema.safeParse(body);
      if (!parsed.success) {
        return fail(
          c,
          400,
          "invalid_request",
          "Invalid result.",
          parsed.error.issues,
        );
      }
      try {
        const done = reportAgentOutcome(deps, agent, parsed.data);
        const workflow = { id: done.workflow.id, name: done.workflow.name };
        return done.duplicate
          ? c.json({ outcome: done.outcome, workflow, duplicate: true })
          : c.json({ outcome: done.outcome, workflow, duplicate: false }, 201);
      } catch (err) {
        if (err instanceof OutcomeRefusal) {
          return fail(c, err.status, err.code, err.message);
        }
        throw err;
      }
    },
  );

  app.notFound((c) => fail(c, 404, "not_found", "Not found."));
  return app;
}

const METRIC_WORDS = {
  cost_per_accepted_unit: "cost per accepted unit",
  acceptance_rate: "acceptance rate",
  net_monthly_return: "net return a month",
} as const;

/** "Stop if cost per accepted unit is above $25.00". */
export function stopRuleText(t: Workflow["stopIf"]): string {
  const value =
    t.metric === "acceptance_rate"
      ? `${Math.round(t.value * 1000) / 10}%`
      : new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
        }).format(t.value);
  return `Stop if ${METRIC_WORDS[t.metric]} is ${t.when} ${value}`;
}

/** Runs the alert sweep with each active workflow's verdict for the last 30 days. */
export function sweepAlerts(deps: WorkflowDeps & { alerts: Alerts }): void {
  const period = defaultPeriod(deps.now());
  deps.alerts.sweep(
    deps.workflows
      .list()
      .filter((w) => w.status === "active")
      .map((w) => ({
        id: w.id,
        name: w.name,
        verdict: reportFor(deps, w, period).verdict,
        stopRule: stopRuleText(w.stopIf),
      })),
  );
}
