import {
  calculateRoi,
  findMostSensitiveInput,
  ROI_CALCULATOR_VERSION,
  type RoiCalculatorInputs,
  type SensitivityInputKey,
} from "@roai-us/roi-core";
import type { UsageRecord } from "./types.js";
import type {
  Outcome,
  Threshold,
  ThresholdMetric,
  Workflow,
} from "./workflows.js";

/** Days in an average month, so a 30-day window and a calendar month agree. */
export const DAYS_PER_MONTH = 365.25 / 12;
const DAY_MS = 86_400_000;

/**
 * How far a number can be trusted. "measured": counted by Purser or reported
 * per result. "attributed": measured, then put down to the AI by a holdout or
 * a before-and-after comparison. "modelled": rests on an estimate or a
 * projection. A number takes the weakest label of the parts it is made from;
 * labels are never blended into something stronger.
 */
export type Confidence = "measured" | "attributed" | "modelled";

const RANK: Record<Confidence, number> = {
  measured: 0,
  attributed: 1,
  modelled: 2,
};

export const weakest = (...labels: Confidence[]): Confidence =>
  labels.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "measured");

export interface Labelled {
  value: number | null;
  label: Confidence;
}

export type Verdict = "too_early" | "stop" | "scale" | "continue";

/** The UTC days a report covers, both ends included. */
export interface Period {
  from: string;
  to: string;
}

export interface RoiReport {
  workflowId: string;
  period: Period & { days: number };
  results: {
    accepted: number;
    reworked: number;
    discarded: number;
    total: number;
    /** Accepted ÷ total. Null with no results: never assumed to be 1. */
    acceptanceRate: number | null;
    /** Results reported by the agents themselves rather than a person. */
    byAgents: number;
    voided: number;
  };
  /** Everything the AI way of working cost in the period, in US dollars. */
  cost: {
    inference: Labelled;
    review: Labelled & { minutes: number; minutesDefaulted: number };
    /** Maintenance and evaluation for the period. */
    upkeep: Labelled;
    total: Labelled;
    /** Calls priced by estimate or at the price table's fallback rate. */
    estimatedCalls: number;
    calls: number;
  };
  perUnit: {
    /** What one unit cost before the AI. */
    baseline: Labelled;
    /** Total cost ÷ accepted units. Null with nothing accepted. */
    costPerAcceptedUnit: Labelled;
  };
  /** Accepted units × the baseline cost of a unit. */
  value: Labelled;
  /** Value minus total cost. Negative is shown as negative. */
  netReturn: Labelled;
  netMonthlyReturn: Labelled;
  /** Projections from roi-core: the same math as the roai.us calculator. */
  projection: {
    paybackMonths: Labelled;
    year1RoiPercent: Labelled;
    threeYearNpv: Labelled;
    /** Which single input moves the net return most. */
    mostSensitive: {
      input: SensitivityInputKey;
      /** The input in plain words. */
      words: string;
      netAnnualIfChanged: number;
      delta: number;
    } | null;
    calculatorVersion: string;
  };
  verdict: Verdict;
  /** The thresholds, each with whether it is met right now. */
  thresholds: {
    stop: Threshold & { met: boolean };
    scale: (Threshold & { met: boolean }) | null;
  };
  /** Plain sentences about what weakens these numbers. Never empty-handed silence. */
  caveats: string[];
}

/** The day a timestamp falls on, in UTC. */
const dayOf = (iso: string) => iso.slice(0, 10);

export function periodDays(period: Period): number {
  return (
    Math.round(
      (Date.parse(`${period.to}T00:00:00Z`) -
        Date.parse(`${period.from}T00:00:00Z`)) /
        DAY_MS,
    ) + 1
  );
}

/** The 30 days ending today, today included. */
export function defaultPeriod(now: Date): Period {
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - 29 * DAY_MS).toISOString().slice(0, 10);
  return { from, to };
}

const inPeriod = (iso: string, period: Period) => {
  const day = dayOf(iso);
  return day >= period.from && day <= period.to;
};

/** The value a threshold watches, or null when it can't be known yet. */
function metricValue(
  metric: ThresholdMetric,
  report: Pick<RoiReport, "results" | "perUnit" | "netMonthlyReturn">,
): number | null {
  switch (metric) {
    case "acceptance_rate":
      return report.results.acceptanceRate;
    case "cost_per_accepted_unit":
      // Nothing accepted yet costs everything spent: above any line.
      return report.perUnit.costPerAcceptedUnit.value ?? Infinity;
    case "net_monthly_return":
      return report.netMonthlyReturn.value;
  }
}

function isMet(
  threshold: Threshold,
  report: Pick<RoiReport, "results" | "perUnit" | "netMonthlyReturn">,
): boolean {
  const value = metricValue(threshold.metric, report);
  if (value === null) return false;
  return threshold.when === "above"
    ? value > threshold.value
    : value < threshold.value;
}

const SENSITIVITY_WORDS: Record<SensitivityInputKey, string> = {
  automationRate: "how much of the work goes through the AI",
  loadedHourlyCost: "the hourly cost of the people",
  reworkRate: "how often results are reworked or discarded",
  costPerTask: "the AI cost per result",
};

/**
 * The ROI report for one workflow over one period.
 *
 *   cost per accepted unit = (inference + review + upkeep) ÷ accepted units
 *   net return            = accepted units × baseline cost of a unit − that cost
 *
 * Reworked and discarded units deliver nothing: a person does them as they
 * did before, at the baseline cost, which cancels out. Only the inference and
 * review time they took count against the AI. This is the same accounting as
 * roi-core, which counts rework as a full redo, and the projections come from
 * roi-core itself.
 */
export function buildReport(
  workflow: Workflow,
  outcomes: readonly Outcome[],
  usage: readonly UsageRecord[],
  period: Period,
): RoiReport {
  const days = periodDays(period);
  const live = outcomes.filter((o) => inPeriod(o.at, period));
  const counted = live.filter((o) => o.voidedAt === undefined);
  const sum = (list: readonly Outcome[]) =>
    list.reduce((n, o) => n + o.count, 0);
  const accepted = sum(counted.filter((o) => o.result === "accepted"));
  const reworked = sum(counted.filter((o) => o.result === "reworked"));
  const discarded = sum(counted.filter((o) => o.result === "discarded"));
  const total = accepted + reworked + discarded;
  const byAgents = sum(counted.filter((o) => o.source === "agent"));

  let reviewReported = 0;
  let minutesDefaulted = 0;
  for (const o of counted) {
    if (o.reviewMinutes === undefined) {
      minutesDefaulted += o.count * workflow.defaultReviewMinutes;
    } else {
      reviewReported += o.reviewMinutes;
    }
  }
  const reviewMinutes = reviewReported + minutesDefaulted;

  const calls = usage.filter((u) => inPeriod(u.at, period));
  const inference = calls.reduce((n, u) => n + u.costUsd, 0);
  const estimatedCalls = calls.filter(
    (u) => u.priced === "estimate" || u.priced === "fallback",
  ).length;

  const hourly = workflow.baseline.hourlyCostUsd;
  const reviewCost = (reviewMinutes / 60) * hourly;
  const monthsInPeriod = days / DAYS_PER_MONTH;
  const upkeep =
    (workflow.costs.monthlyMaintenanceUsd +
      workflow.costs.monthlyEvaluationUsd) *
    monthsInPeriod;
  const totalCost = inference + reviewCost + upkeep;
  const baselineUnit = (workflow.baseline.minutesPerUnit / 60) * hourly;
  const value = accepted * baselineUnit;
  const net = value - totalCost;

  const reviewLabel: Confidence =
    minutesDefaulted > 0 ? "modelled" : "measured";
  const baselineLabel: Confidence =
    workflow.baseline.source === "estimated" ? "modelled" : "measured";
  const valueLabel = weakest(
    baselineLabel,
    workflow.attribution === "modelled" ? "modelled" : "attributed",
  );
  const costLabel = weakest("measured", reviewLabel);
  const netLabel = weakest(valueLabel, costLabel);

  // The same period, scaled to a month, through the calculator's own math.
  const perMonth = DAYS_PER_MONTH / days;
  const resultsPerMonth = total * perMonth;
  const volume = Math.max(
    workflow.baseline.unitsPerMonth ?? 0,
    resultsPerMonth,
  );
  const inputs: RoiCalculatorInputs = {
    headcount: 1,
    tasksPerPersonPerMonth: volume,
    minutesPerTask: workflow.baseline.minutesPerUnit,
    loadedHourlyCost: hourly,
    automationRate: volume > 0 ? resultsPerMonth / volume : 0,
    reviewMinutesPerTask:
      total > 0 ? reviewMinutes / total : workflow.defaultReviewMinutes,
    reworkRate: total > 0 ? (reworked + discarded) / total : 0,
    costMode: "simple",
    simpleCostPerTask: total > 0 ? inference / total : 0,
    inputTokensPerTask: 0,
    outputTokensPerTask: 0,
    inputPricePerMillion: 0,
    outputPricePerMillion: 0,
    implementationCost: workflow.costs.implementationUsd,
    // With no results there is no cost per result to carry the AI spend,
    // so it rides with upkeep instead of vanishing from the projection.
    monthlyMaintenance:
      workflow.costs.monthlyMaintenanceUsd +
      workflow.costs.monthlyEvaluationUsd +
      (total > 0 ? 0 : inference * perMonth),
    discountRate: workflow.costs.discountRate,
  };
  const roi = calculateRoi(inputs);
  const sensitive = total > 0 ? findMostSensitiveInput(inputs) : null;
  const projected = weakest("modelled", netLabel);

  const base = {
    results: {
      accepted,
      reworked,
      discarded,
      total,
      acceptanceRate: total > 0 ? accepted / total : null,
      byAgents,
      voided: sum(live.filter((o) => o.voidedAt !== undefined)),
    },
    perUnit: {
      baseline: { value: baselineUnit, label: baselineLabel },
      costPerAcceptedUnit: {
        value: accepted > 0 ? totalCost / accepted : null,
        label: costLabel,
      },
    },
    netMonthlyReturn: { value: net * perMonth, label: netLabel },
  } satisfies Pick<RoiReport, "results" | "perUnit" | "netMonthlyReturn">;

  const stop = { ...workflow.stopIf, met: isMet(workflow.stopIf, base) };
  const scale = workflow.scaleIf
    ? { ...workflow.scaleIf, met: isMet(workflow.scaleIf, base) }
    : null;
  const verdict: Verdict =
    total < workflow.minUnits
      ? "too_early"
      : stop.met
        ? "stop"
        : scale?.met
          ? "scale"
          : "continue";

  return {
    workflowId: workflow.id,
    period: { ...period, days },
    ...base,
    cost: {
      inference: { value: inference, label: "measured" },
      review: {
        value: reviewCost,
        label: reviewLabel,
        minutes: reviewMinutes,
        minutesDefaulted,
      },
      upkeep: { value: upkeep, label: "measured" },
      total: { value: totalCost, label: costLabel },
      estimatedCalls,
      calls: calls.length,
    },
    value: { value, label: valueLabel },
    netReturn: { value: net, label: netLabel },
    projection: {
      paybackMonths: { value: roi.paybackMonths, label: projected },
      year1RoiPercent: { value: roi.year1RoiPercent, label: projected },
      threeYearNpv: { value: roi.threeYearNpv, label: projected },
      mostSensitive: sensitive && {
        input: sensitive.input,
        words: SENSITIVITY_WORDS[sensitive.input],
        netAnnualIfChanged: sensitive.resultingNetAnnualSavings,
        delta: sensitive.delta,
      },
      calculatorVersion: ROI_CALCULATOR_VERSION,
    },
    verdict,
    thresholds: { stop, scale },
    caveats: caveats(workflow, {
      total,
      byAgents,
      minutesDefaulted,
      reviewMinutes,
      calls: calls.length,
      estimatedCalls,
      days,
    }),
  };
}

function caveats(
  workflow: Workflow,
  n: {
    total: number;
    byAgents: number;
    minutesDefaulted: number;
    reviewMinutes: number;
    calls: number;
    estimatedCalls: number;
    days: number;
  },
): string[] {
  const out: string[] = [];
  if (n.total < workflow.minUnits) {
    out.push(
      `Only ${n.total} of the ${workflow.minUnits} results needed for a verdict.`,
    );
  }
  if (n.days < 7) {
    out.push(
      "This period is shorter than a week; monthly figures are scaled up from it.",
    );
  }
  if (n.total > 0 && n.calls === 0) {
    out.push(
      "No AI spend was metered for this workflow's agents in this period. If they call providers directly, that cost is missing here.",
    );
  }
  if (workflow.agents.length === 0) {
    out.push("No agents are linked, so no AI spend is counted.");
  }
  if (n.estimatedCalls > 0) {
    out.push(
      `${n.estimatedCalls} of ${n.calls} calls were priced by estimate, not from the provider's own figures.`,
    );
  }
  if (n.minutesDefaulted > 0 && n.reviewMinutes > 0) {
    const share = Math.round((n.minutesDefaulted / n.reviewMinutes) * 100);
    out.push(
      `${share}% of review time is the default of ${workflow.defaultReviewMinutes} minutes a result, not reported time.`,
    );
  }
  if (n.byAgents > 0) {
    const share = Math.round((n.byAgents / n.total) * 100);
    out.push(
      `${share}% of results were reported by the agents themselves, not by a person.`,
    );
  }
  if (workflow.baseline.source === "estimated") {
    out.push(
      "The baseline is an estimate, so value and net return are modelled.",
    );
  }
  if (workflow.attribution === "modelled") {
    out.push(
      "No holdout or before-and-after comparison: the AI's share of the change is modelled.",
    );
  }
  for (const change of workflow.changedAfterLock ?? []) {
    out.push(
      `Changed after results arrived, on ${change.at.slice(0, 10)} by ${change.by}: ${change.fields.join(", ")}.`,
    );
  }
  return out;
}
