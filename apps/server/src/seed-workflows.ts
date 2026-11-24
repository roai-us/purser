import type { Agent, AuditEvent } from "./types.js";
import type { Attribution, Outcome, Threshold, Workflow } from "./workflows.js";

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

interface Plan {
  name: string;
  unit: string;
  slug: string;
  agents: number;
  owner: string;
  ownerEmail: string;
  team: string;
  minutes: number;
  hourly: number;
  unitsPerMonth?: number;
  source: "measured" | "estimated";
  method: string;
  attribution: Attribution;
  /** Share of results accepted, and of the rest, the share reworked. */
  accepted: number;
  reworked: number;
  /** Review minutes a result. */
  review: number;
  /** Results on a typical day. */
  perDay: number;
  costs: Workflow["costs"];
  stopIf: Threshold;
  scaleIf?: Threshold;
  minUnits: number;
  /** Days ago it was set up. */
  age: number;
  /** Share of results the agents report themselves. */
  byAgents: number;
}

/**
 * Four workflows that tell the story of the ROI report: one to scale up, one
 * to keep going with, one the stop line says to end, and one too new to
 * judge. AI spend comes from the demo agents' own usage.
 */
const PLANS: Plan[] = [
  {
    name: "Support replies",
    unit: "support ticket answered",
    slug: "reply-drafter",
    agents: 4,
    owner: "Priya Patel",
    ownerEmail: "priya.patel@example.com",
    team: "Customer Support",
    minutes: 12,
    hourly: 42,
    unitsPerMonth: 6000,
    source: "measured",
    method:
      "Ticket timestamps for two weeks in September, 1,840 tickets, from first open to reply sent.",
    attribution: "holdout",
    accepted: 0.88,
    reworked: 0.6,
    review: 2.5,
    perDay: 180,
    costs: {
      implementationUsd: 9000,
      monthlyMaintenanceUsd: 400,
      monthlyEvaluationUsd: 250,
      discountRate: 0.1,
    },
    stopIf: { metric: "cost_per_accepted_unit", when: "above", value: 6 },
    scaleIf: { metric: "acceptance_rate", when: "above", value: 0.8 },
    minUnits: 200,
    age: 45,
    byAgents: 0,
  },
  {
    name: "Code review",
    unit: "pull request reviewed",
    slug: "code-review",
    agents: 3,
    owner: "Sam Lee",
    ownerEmail: "sam.lee@example.com",
    team: "Engineering",
    minutes: 25,
    hourly: 95,
    source: "measured",
    method: "Review time from the code host for August, 412 pull requests.",
    attribution: "before_after",
    accepted: 0.68,
    reworked: 0.7,
    review: 6,
    perDay: 25,
    costs: {
      implementationUsd: 15000,
      monthlyMaintenanceUsd: 600,
      monthlyEvaluationUsd: 400,
      discountRate: 0.1,
    },
    stopIf: { metric: "cost_per_accepted_unit", when: "above", value: 30 },
    scaleIf: { metric: "acceptance_rate", when: "above", value: 0.8 },
    minUnits: 100,
    age: 40,
    byAgents: 0.4,
  },
  {
    name: "Invoice matching",
    unit: "invoice matched to a purchase order",
    slug: "invoice-reader",
    agents: 3,
    owner: "Alex Kim",
    ownerEmail: "alex.kim@example.com",
    team: "Finance",
    minutes: 5,
    hourly: 38,
    source: "estimated",
    method: "The accounts payable lead's estimate, not timed.",
    attribution: "modelled",
    accepted: 0.42,
    reworked: 0.5,
    review: 3.5,
    perDay: 120,
    costs: {
      implementationUsd: 6000,
      monthlyMaintenanceUsd: 300,
      monthlyEvaluationUsd: 200,
      discountRate: 0.1,
    },
    stopIf: { metric: "net_monthly_return", when: "below", value: 0 },
    minUnits: 150,
    age: 38,
    byAgents: 0,
  },
  {
    name: "Lead research",
    unit: "lead researched",
    slug: "lead-research",
    agents: 2,
    owner: "Jordan Rivera",
    ownerEmail: "jordan.rivera@example.com",
    team: "Sales",
    minutes: 20,
    hourly: 55,
    source: "measured",
    method: "Three reps timed twenty leads each in October.",
    attribution: "before_after",
    accepted: 0.75,
    reworked: 0.5,
    review: 4,
    perDay: 3,
    costs: {
      implementationUsd: 2500,
      monthlyMaintenanceUsd: 150,
      monthlyEvaluationUsd: 100,
      discountRate: 0.1,
    },
    stopIf: { metric: "cost_per_accepted_unit", when: "above", value: 12 },
    scaleIf: { metric: "acceptance_rate", when: "above", value: 0.85 },
    minUnits: 60,
    age: 4,
    byAgents: 0,
  },
];

export interface SeedWorkflows {
  workflows: Workflow[];
  outcomes: Outcome[];
  audit: AuditEvent[];
}

export function generateWorkflows(
  agents: Agent[],
  now: Date,
  r: () => number,
): SeedWorkflows {
  const workflows: Workflow[] = [];
  const outcomes: Outcome[] = [];
  const audit: AuditEvent[] = [];
  const end = now.getTime();
  let seq = 0;

  for (const [i, plan] of PLANS.entries()) {
    const mine = agents
      .filter(
        (a) => a.name.startsWith(`${plan.slug}-`) && a.status === "active",
      )
      .slice(0, plan.agents);
    if (mine.length === 0) continue;
    const ids = new Set(mine.map((a) => a.id));
    const created = end - plan.age * DAY;
    const workflow: Workflow = {
      id: `wf_demo${i}`,
      name: plan.name,
      unit: plan.unit,
      owner: plan.owner,
      ownerEmail: plan.ownerEmail,
      team: plan.team,
      agents: [...ids],
      baseline: {
        minutesPerUnit: plan.minutes,
        hourlyCostUsd: plan.hourly,
        ...(plan.unitsPerMonth ? { unitsPerMonth: plan.unitsPerMonth } : {}),
        measuredOn: iso(created - 10 * DAY).slice(0, 10),
        method: plan.method,
        source: plan.source,
      },
      attribution: plan.attribution,
      defaultReviewMinutes: plan.review,
      costs: plan.costs,
      stopIf: plan.stopIf,
      scaleIf: plan.scaleIf,
      minUnits: plan.minUnits,
      status: "active",
      createdAt: iso(created),
      createdBy: "morgan.admin@example.com",
    };
    audit.push({
      at: workflow.createdAt,
      type: "workflow.created",
      detail: { workflow: plan.name, by: workflow.createdBy },
    });

    for (let t = created + DAY; t <= end; t += DAY) {
      const day = iso(t).slice(0, 10);
      const total = Math.max(1, Math.round(plan.perDay * (0.8 + r() * 0.4)));
      const jitter = (x: number) =>
        Math.min(1, Math.max(0, x + (r() - 0.5) * 0.08));
      const accepted = Math.round(total * jitter(plan.accepted));
      const rest = total - accepted;
      const reworked = Math.round(rest * jitter(plan.reworked));
      const discarded = rest - reworked;
      const at = iso(Math.min(end, t + 17 * 3_600_000));
      for (const [result, count] of [
        ["accepted", accepted],
        ["reworked", reworked],
        ["discarded", discarded],
      ] as const) {
        if (count <= 0) continue;
        const fromAgent = r() < plan.byAgents;
        const agent = mine[Math.floor(r() * mine.length)] ?? mine[0];
        const minutes = count * plan.review * (0.85 + r() * 0.3);
        outcomes.push({
          id: `out_demo${String(++seq).padStart(6, "0")}`,
          workflowId: workflow.id,
          at,
          recordedAt: at,
          result,
          count,
          reviewMinutes: Math.round(minutes),
          source: fromAgent ? "agent" : "person",
          by: fromAgent && agent ? agent.id : plan.ownerEmail,
          ...(fromAgent && agent ? { agentId: agent.id } : {}),
          note: fromAgent ? undefined : `Daily tally, ${day}`,
        });
        if (workflow.lockedAt === undefined) {
          workflow.lockedAt = at;
          audit.push({
            at,
            type: "workflow.locked",
            detail: { workflow: plan.name },
          });
        }
      }
    }
    workflows.push(workflow);
  }
  return { workflows, outcomes, audit };
}
