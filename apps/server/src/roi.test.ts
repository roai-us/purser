import { calculateRoi } from "@roai-us/roi-core";
import { describe, expect, it } from "vitest";
import {
  buildReport,
  DAYS_PER_MONTH,
  defaultPeriod,
  periodDays,
  weakest,
} from "./roi.js";
import type { UsageRecord } from "./types.js";
import type { Outcome, Workflow } from "./workflows.js";

const workflow = (over: Partial<Workflow> = {}): Workflow => ({
  id: "wf_1",
  name: "support replies",
  unit: "support ticket answered",
  owner: "Dana Ortiz",
  agents: ["ag_1"],
  baseline: {
    minutesPerUnit: 30,
    hourlyCostUsd: 60,
    measuredOn: "2026-10-01",
    method: "Two weeks of ticket timestamps",
    source: "measured",
  },
  attribution: "before_after",
  defaultReviewMinutes: 5,
  costs: {
    implementationUsd: 6000,
    monthlyMaintenanceUsd: 300,
    monthlyEvaluationUsd: 100,
    discountRate: 0.1,
  },
  stopIf: { metric: "cost_per_accepted_unit", when: "above", value: 25 },
  scaleIf: { metric: "acceptance_rate", when: "above", value: 0.75 },
  minUnits: 30,
  status: "active",
  createdAt: "2026-10-25T00:00:00.000Z",
  createdBy: "admin",
  ...over,
});

let n = 0;
const outcome = (over: Partial<Outcome>): Outcome => ({
  id: `out_${++n}`,
  workflowId: "wf_1",
  at: "2026-11-10T12:00:00.000Z",
  recordedAt: "2026-11-10T12:00:00.000Z",
  result: "accepted",
  count: 1,
  source: "person",
  by: "admin",
  ...over,
});

const call = (
  costUsd: number,
  over: Partial<UsageRecord> = {},
): UsageRecord => ({
  id: `u_${++n}`,
  agentId: "ag_1",
  provider: "openai",
  endpoint: "/chat/completions",
  model: "gpt-4o-mini",
  at: "2026-11-10T12:00:00.000Z",
  costUsd,
  priced: "table",
  status: 200,
  durationMs: 100,
  outcome: "complete",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  ...over,
});

const NOVEMBER = { from: "2026-11-01", to: "2026-11-30" };

/**
 * The hand-checked case. Baseline: 30 minutes at $60 an hour, $30 a unit.
 * 100 results: 80 accepted (400 review minutes reported), 10 reworked (no
 * minutes, so 5 each by default: 50), 10 discarded (100 minutes). Review is
 * 550 minutes at $1 a minute: $550. Inference $45. Upkeep $400 a month for
 * 30 of 30.4375 days: $394.2505. Total $989.2505, so $12.3656 an accepted
 * unit. Value 80 × $30 = $2,400. Net $1,410.7495.
 */
const handChecked = () =>
  buildReport(
    workflow(),
    [
      outcome({ result: "accepted", count: 80, reviewMinutes: 400 }),
      outcome({ result: "reworked", count: 10 }),
      outcome({ result: "discarded", count: 10, reviewMinutes: 100 }),
    ],
    [call(20), call(25)],
    NOVEMBER,
  );

describe("buildReport", () => {
  it("matches the hand-checked case", () => {
    const r = handChecked();
    expect(r.period).toEqual({ ...NOVEMBER, days: 30 });
    expect(r.results).toEqual({
      accepted: 80,
      reworked: 10,
      discarded: 10,
      total: 100,
      acceptanceRate: 0.8,
      byAgents: 0,
      voided: 0,
    });
    expect(r.cost.inference.value).toBe(45);
    expect(r.cost.review.value).toBe(550);
    expect(r.cost.review.minutes).toBe(550);
    expect(r.cost.review.minutesDefaulted).toBe(50);
    expect(r.cost.upkeep.value).toBeCloseTo(394.2505, 4);
    expect(r.cost.total.value).toBeCloseTo(989.2505, 4);
    expect(r.perUnit.baseline.value).toBe(30);
    expect(r.perUnit.costPerAcceptedUnit.value).toBeCloseTo(12.3656, 4);
    expect(r.value.value).toBe(2400);
    expect(r.netReturn.value).toBeCloseTo(1410.7495, 4);
    expect(r.netMonthlyReturn.value).toBeCloseTo(
      1410.7495 * (DAYS_PER_MONTH / 30),
      4,
    );
  });

  it("agrees with the roai.us calculator's own math", () => {
    const r = handChecked();
    const perMonth = DAYS_PER_MONTH / 30;
    const annual = calculateRoi({
      headcount: 1,
      tasksPerPersonPerMonth: 100 * perMonth,
      minutesPerTask: 30,
      loadedHourlyCost: 60,
      automationRate: 1,
      reviewMinutesPerTask: 5.5,
      reworkRate: 0.2,
      costMode: "simple",
      simpleCostPerTask: 0.45,
      inputTokensPerTask: 0,
      outputTokensPerTask: 0,
      inputPricePerMillion: 0,
      outputPricePerMillion: 0,
      implementationCost: 6000,
      monthlyMaintenance: 400,
      discountRate: 0.1,
    });
    expect(r.netMonthlyReturn.value).toBeCloseTo(
      annual.netAnnualSavings / 12,
      6,
    );
    expect(r.projection.paybackMonths.value).toBeCloseTo(
      annual.paybackMonths ?? NaN,
      6,
    );
    expect(r.projection.threeYearNpv.value).toBeCloseTo(annual.threeYearNpv, 6);
    expect(r.projection.year1RoiPercent.value).toBeCloseTo(
      annual.year1RoiPercent ?? NaN,
      6,
    );
    expect(r.projection.calculatorVersion).toBe("1.0.0");
  });

  it("labels each number by its weakest part, never stronger", () => {
    const r = handChecked();
    expect(r.cost.inference.label).toBe("measured");
    // 50 review minutes were the default, not reported.
    expect(r.cost.review.label).toBe("modelled");
    expect(r.cost.total.label).toBe("modelled");
    expect(r.perUnit.baseline.label).toBe("measured");
    expect(r.value.label).toBe("attributed");
    expect(r.netReturn.label).toBe("modelled");
    expect(r.projection.paybackMonths.label).toBe("modelled");

    const reported = buildReport(
      workflow(),
      [outcome({ count: 40, reviewMinutes: 100 })],
      [call(4)],
      NOVEMBER,
    );
    expect(reported.cost.total.label).toBe("measured");
    expect(reported.value.label).toBe("attributed");
    expect(reported.netReturn.label).toBe("attributed");

    const estimated = buildReport(
      workflow({
        baseline: { ...workflow().baseline, source: "estimated" },
        attribution: "holdout",
      }),
      [outcome({ count: 40, reviewMinutes: 100 })],
      [],
      NOVEMBER,
    );
    expect(estimated.perUnit.baseline.label).toBe("modelled");
    expect(estimated.value.label).toBe("modelled");

    const modelled = buildReport(
      workflow({ attribution: "modelled" }),
      [outcome({ count: 40, reviewMinutes: 100 })],
      [],
      NOVEMBER,
    );
    expect(modelled.value.label).toBe("modelled");
  });

  it("gives a verdict only once there are enough results", () => {
    expect(handChecked().verdict).toBe("scale");

    const few = buildReport(
      workflow(),
      [outcome({ count: 29, reviewMinutes: 0 })],
      [],
      NOVEMBER,
    );
    expect(few.verdict).toBe("too_early");
    expect(few.caveats[0]).toBe(
      "Only 29 of the 30 results needed for a verdict.",
    );

    // Accepted 30 of 60: neither line is crossed.
    const middling = buildReport(
      workflow(),
      [
        outcome({ count: 30, reviewMinutes: 60 }),
        outcome({ result: "discarded", count: 30, reviewMinutes: 60 }),
      ],
      [],
      NOVEMBER,
    );
    expect(middling.verdict).toBe("continue");
    expect(middling.thresholds.stop.met).toBe(false);
    expect(middling.thresholds.scale?.met).toBe(false);
  });

  it("puts stop ahead of scale when both are met", () => {
    const r = buildReport(
      workflow({
        stopIf: { metric: "net_monthly_return", when: "below", value: 1e9 },
      }),
      [outcome({ count: 50, reviewMinutes: 50 })],
      [],
      NOVEMBER,
    );
    expect(r.thresholds.scale?.met).toBe(true);
    expect(r.verdict).toBe("stop");
  });

  it("treats nothing accepted as above any cost line, and shows the loss", () => {
    const r = buildReport(
      workflow(),
      [outcome({ result: "discarded", count: 40, reviewMinutes: 200 })],
      [call(10)],
      NOVEMBER,
    );
    expect(r.perUnit.costPerAcceptedUnit.value).toBeNull();
    expect(r.results.acceptanceRate).toBe(0);
    expect(r.thresholds.stop.met).toBe(true);
    expect(r.verdict).toBe("stop");
    expect(r.netReturn.value).toBeLessThan(0);
    expect(r.projection.paybackMonths.value).toBeNull();
  });

  it("never assumes acceptance with no results, and keeps the spend in the projection", () => {
    const r = buildReport(
      workflow({ scaleIf: undefined }),
      [],
      [call(30)],
      NOVEMBER,
    );
    expect(r.results.acceptanceRate).toBeNull();
    expect(r.thresholds.scale).toBeNull();
    expect(r.projection.mostSensitive).toBeNull();
    const perMonth = DAYS_PER_MONTH / 30;
    const lossPerMonth = (30 + 394.2505) * perMonth;
    expect(r.netMonthlyReturn.value).toBeCloseTo(-lossPerMonth, 3);
    // Implementation plus a year of the monthly loss.
    expect(r.projection.year1RoiPercent.value).toBeCloseTo(
      ((-lossPerMonth * 12 - 6000) / 6000) * 100,
      3,
    );

    const rate = buildReport(
      workflow({
        stopIf: { metric: "acceptance_rate", when: "below", value: 0.5 },
      }),
      [],
      [],
      NOVEMBER,
    );
    expect(rate.thresholds.stop.met).toBe(false);
  });

  it("counts only results and calls inside the period, and leaves voided results out", () => {
    const r = buildReport(
      workflow(),
      [
        outcome({ count: 40, reviewMinutes: 40 }),
        outcome({ count: 5, at: "2026-10-31T23:59:59.000Z" }),
        outcome({ count: 5, at: "2026-12-01T00:00:00.000Z" }),
        outcome({ count: 7, voidedAt: "2026-11-11T00:00:00.000Z" }),
      ],
      [call(1), call(100, { at: "2026-12-01T00:00:00.000Z" })],
      NOVEMBER,
    );
    expect(r.results.accepted).toBe(40);
    expect(r.results.voided).toBe(7);
    expect(r.cost.inference.value).toBe(1);
    expect(r.cost.calls).toBe(1);
  });

  it("uses the baseline volume when more work exists than went through the AI", () => {
    const r = buildReport(
      workflow({ baseline: { ...workflow().baseline, unitsPerMonth: 1000 } }),
      [outcome({ count: 50, reviewMinutes: 100 })],
      [call(5)],
      NOVEMBER,
    );
    // The net return is the same however much other work there is.
    const without = buildReport(
      workflow(),
      [outcome({ count: 50, reviewMinutes: 100 })],
      [call(5)],
      NOVEMBER,
    );
    expect(r.netMonthlyReturn.value).toBeCloseTo(
      without.netMonthlyReturn.value ?? NaN,
      6,
    );
    expect(r.projection.mostSensitive?.words).toMatch(/^(how|the) /);
  });

  it("names what weakens the numbers", () => {
    const r = buildReport(
      workflow({
        baseline: { ...workflow().baseline, source: "estimated" },
        attribution: "modelled",
        agents: [],
        changedAfterLock: [
          { at: "2026-11-05T10:00:00.000Z", by: "admin", fields: ["costs"] },
        ],
      }),
      [
        outcome({ count: 3, source: "agent", by: "ag_1" }),
        outcome({ count: 1, reviewMinutes: 15 }),
      ],
      [],
      { from: "2026-11-08", to: "2026-11-12" },
    );
    expect(r.caveats).toEqual([
      "Only 4 of the 30 results needed for a verdict.",
      "This period is shorter than a week; monthly figures are scaled up from it.",
      "No AI spend was metered for this workflow's agents in this period. If they call providers directly, that cost is missing here.",
      "No agents are linked, so no AI spend is counted.",
      "50% of review time is the default of 5 minutes a result, not reported time.",
      "75% of results were reported by the agents themselves, not by a person.",
      "The baseline is an estimate, so value and net return are modelled.",
      "No holdout or before-and-after comparison: the AI's share of the change is modelled.",
      "Changed after results arrived, on 2026-11-05 by admin: costs.",
    ]);

    const priced = buildReport(
      workflow(),
      [outcome({ count: 40, reviewMinutes: 0 })],
      [
        call(1, { priced: "estimate" }),
        call(1, { priced: "fallback" }),
        call(1),
      ],
      NOVEMBER,
    );
    expect(priced.cost.estimatedCalls).toBe(2);
    expect(priced.caveats).toContain(
      "2 of 3 calls were priced by estimate, not from the provider's own figures.",
    );
  });
});

describe("helpers", () => {
  it("picks the weakest label", () => {
    expect(weakest()).toBe("measured");
    expect(weakest("measured", "attributed")).toBe("attributed");
    expect(weakest("modelled", "attributed", "measured")).toBe("modelled");
  });

  it("counts days with both ends included, and defaults to the last 30", () => {
    expect(periodDays({ from: "2026-11-01", to: "2026-11-01" })).toBe(1);
    expect(periodDays(NOVEMBER)).toBe(30);
    const p = defaultPeriod(new Date("2026-11-24T08:00:00Z"));
    expect(p).toEqual({ from: "2026-10-26", to: "2026-11-24" });
    expect(periodDays(p)).toBe(30);
  });
});
