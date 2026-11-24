import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { newId } from "./keys.js";
import { writeAtomic } from "./store.js";

/** What a threshold watches. */
export type ThresholdMetric =
  "cost_per_accepted_unit" | "acceptance_rate" | "net_monthly_return";

/**
 * A line written down before any result: "stop if cost per accepted unit is
 * above $4". Money is in US dollars a unit or a month; a rate is a fraction.
 */
export interface Threshold {
  metric: ThresholdMetric;
  when: "above" | "below";
  value: number;
}

/** How the work was done before the AI, on the same unit of work. */
export interface Baseline {
  /** Minutes a person spent on one unit. */
  minutesPerUnit: number;
  /** What an hour of that person's time costs, fully loaded, in US dollars. */
  hourlyCostUsd: number;
  /** Units a month, all of them, with or without the AI. Optional. */
  unitsPerMonth?: number | undefined;
  /** The day the baseline was measured or estimated: "2026-10-01". */
  measuredOn: string;
  /** How it was measured, in a sentence. */
  method: string;
  /** "measured" from real work, or "estimated" by someone who knows the work. */
  source: "measured" | "estimated";
}

/**
 * How the change in the work is put down to the AI. A holdout group is the
 * strongest, then before and after; a model is the weakest.
 */
export type Attribution = "holdout" | "before_after" | "modelled";

export interface WorkflowCosts {
  /** One-off cost to build and roll it out. */
  implementationUsd: number;
  /** Upkeep a month: hosting, licences, an engineer's time. */
  monthlyMaintenanceUsd: number;
  /** Checking the AI's quality a month: test sets, graders, spot checks. */
  monthlyEvaluationUsd: number;
  /** For the three-year present value. A fraction: 0.1 is 10%. */
  discountRate: number;
}

/** The fields that lock when the first result arrives. */
export const LOCKED_FIELDS = [
  "unit",
  "baseline",
  "attribution",
  "stopIf",
  "scaleIf",
  "minUnits",
] as const;

/**
 * A unit of work the AI helps with, and the rules for judging it. The
 * baseline, the attribution method and the thresholds are locked and
 * timestamped when the first result arrives, so nobody moves the goalposts
 * after seeing the numbers.
 */
export interface Workflow {
  id: string;
  name: string;
  /** One unit of work, in words: "support ticket answered". */
  unit: string;
  owner: string;
  ownerEmail?: string | undefined;
  team?: string | undefined;
  /** Agents whose metered AI spend counts toward this workflow. */
  agents: string[];
  baseline: Baseline;
  attribution: Attribution;
  /** Review minutes counted for a result that doesn't report its own. */
  defaultReviewMinutes: number;
  costs: WorkflowCosts;
  /** The number that would stop this program. */
  stopIf: Threshold;
  /** The number that would make it worth expanding. */
  scaleIf?: Threshold | undefined;
  /** Results needed before Purser gives a verdict. */
  minUnits: number;
  status: "active" | "archived";
  createdAt: string;
  createdBy: string;
  /** When the first result arrived and the rules above were locked. */
  lockedAt?: string | undefined;
  /** Changes made after the lock, shown on every report. */
  changedAfterLock?: { at: string; by: string; fields: string[] }[] | undefined;
}

export type OutcomeResult = "accepted" | "reworked" | "discarded";

/**
 * Results for one or more units of work. "accepted": used, perhaps after
 * small fixes. "reworked": a person had to redo most of it. "discarded":
 * thrown away.
 */
export interface Outcome {
  id: string;
  workflowId: string;
  /** When the work happened. A tally entered later can be dated back. */
  at: string;
  /** When Purser was told. */
  recordedAt: string;
  result: OutcomeResult;
  /** Units with this result: 1 for a single result, more for a tally. */
  count: number;
  /** Review minutes for all `count` units together, when known. */
  reviewMinutes?: number | undefined;
  /** The caller's own id for this result, so a retry isn't counted twice. */
  ref?: string | undefined;
  note?: string | undefined;
  /** "agent" when an agent reported it with its own key, "person" otherwise. */
  source: "agent" | "person";
  /** The agent's id, or the person or token that entered it. */
  by: string;
  agentId?: string | undefined;
  voidedAt?: string | undefined;
  voidedBy?: string | undefined;
}

/** A line in outcomes.jsonl: a result, or a later note that one was voided. */
type OutcomeLine = Outcome | { void: string; at: string; by: string };

/**
 * Workflows and their results. Workflows live in workflows.json; results are
 * appended to outcomes.jsonl and never rewritten, so a voided result stays
 * on file with who voided it.
 */
export class Workflows {
  private readonly workflows = new Map<string, Workflow>();
  private readonly byName = new Map<string, string>();
  private readonly outcomes = new Map<string, Outcome[]>();
  private readonly outcomeById = new Map<string, Outcome>();
  private readonly refs = new Map<string, Outcome>();

  constructor(private readonly dataDir: string | null = null) {
    if (dataDir) this.load(dataDir);
  }

  list(): Workflow[] {
    return [...this.workflows.values()];
  }

  get(id: string): Workflow | undefined {
    return this.workflows.get(id);
  }

  /** A workflow by id or by its unique name. */
  resolve(ref: string): Workflow | undefined {
    const id = this.workflows.has(ref) ? ref : this.byName.get(ref);
    return id === undefined ? undefined : this.workflows.get(id);
  }

  /** The active workflow an agent's spend counts toward, if any. */
  forAgent(agentId: string): Workflow | undefined {
    return this.list().find(
      (w) => w.status === "active" && w.agents.includes(agentId),
    );
  }

  create(
    input: Omit<Workflow, "id" | "status" | "createdAt" | "lockedAt">,
    at: string,
  ): Workflow {
    if (this.byName.has(input.name)) {
      throw new Error(`A workflow named "${input.name}" already exists.`);
    }
    const workflow: Workflow = {
      ...input,
      id: newId("wf"),
      status: "active",
      createdAt: at,
    };
    this.workflows.set(workflow.id, workflow);
    this.byName.set(workflow.name, workflow.id);
    this.save();
    return workflow;
  }

  update(id: string, patch: Partial<Workflow>): Workflow {
    const current = this.workflows.get(id);
    if (!current) throw new Error(`No workflow with id ${id}.`);
    const next: Workflow = { ...current, ...patch, id: current.id };
    this.byName.delete(current.name);
    this.byName.set(next.name, next.id);
    this.workflows.set(id, next);
    this.save();
    return next;
  }

  /** All results for a workflow, oldest first, voided ones included. Not a copy. */
  outcomesOf(workflowId: string): readonly Outcome[] {
    return this.outcomes.get(workflowId) ?? [];
  }

  getOutcome(id: string): Outcome | undefined {
    return this.outcomeById.get(id);
  }

  /** A result already recorded under this caller ref, so a retry returns it. */
  byRef(workflowId: string, ref: string): Outcome | undefined {
    return this.refs.get(`${workflowId}|${ref}`);
  }

  /**
   * Records a result. The first result for a workflow locks its rules, and
   * the returned `locked` is true when this call did that.
   */
  record(input: Omit<Outcome, "id">): { outcome: Outcome; locked: boolean } {
    const workflow = this.workflows.get(input.workflowId);
    if (!workflow) throw new Error(`No workflow with id ${input.workflowId}.`);
    const outcome: Outcome = { ...input, id: newId("out") };
    this.index(outcome);
    this.append(outcome);
    const locked = workflow.lockedAt === undefined;
    if (locked) this.update(workflow.id, { lockedAt: outcome.recordedAt });
    return { outcome, locked };
  }

  /** Marks a result as entered by mistake. It stays on file, out of every count. */
  void(id: string, at: string, by: string): Outcome {
    const outcome = this.outcomeById.get(id);
    if (!outcome) throw new Error(`No result with id ${id}.`);
    if (outcome.voidedAt === undefined) {
      outcome.voidedAt = at;
      outcome.voidedBy = by;
      this.append({ void: id, at, by });
    }
    return outcome;
  }

  private index(outcome: Outcome): void {
    let list = this.outcomes.get(outcome.workflowId);
    if (!list) {
      list = [];
      this.outcomes.set(outcome.workflowId, list);
    }
    list.push(outcome);
    this.outcomeById.set(outcome.id, outcome);
    if (outcome.ref !== undefined) {
      this.refs.set(`${outcome.workflowId}|${outcome.ref}`, outcome);
    }
  }

  private load(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "workflows.json");
    if (existsSync(file)) {
      for (const w of JSON.parse(readFileSync(file, "utf8")) as Workflow[]) {
        this.workflows.set(w.id, w);
        this.byName.set(w.name, w.id);
      }
    }
    const lines = join(dir, "outcomes.jsonl");
    if (!existsSync(lines)) return;
    for (const raw of readFileSync(lines, "utf8").split("\n")) {
      if (raw.trim() === "") continue;
      let line: OutcomeLine;
      try {
        line = JSON.parse(raw) as OutcomeLine;
      } catch {
        continue; // A line torn by a crash mid-write.
      }
      if ("void" in line) {
        const outcome = this.outcomeById.get(line.void);
        if (outcome) {
          outcome.voidedAt = line.at;
          outcome.voidedBy = line.by;
        }
      } else {
        this.index(line);
      }
    }
  }

  private save(): void {
    if (!this.dataDir) return;
    writeAtomic(
      join(this.dataDir, "workflows.json"),
      JSON.stringify(this.list(), null, 2),
    );
  }

  private append(line: OutcomeLine): void {
    if (!this.dataDir) return;
    appendFileSync(
      join(this.dataDir, "outcomes.jsonl"),
      `${JSON.stringify(line)}\n`,
      { mode: 0o600 },
    );
  }
}
