import { describe, expect, it } from "vitest";
import {
  calculateRoi,
  findMostSensitiveInput,
  type RoiCalculatorInputs,
} from "./calculate.js";

const defaultInputs: RoiCalculatorInputs = {
  headcount: 25,
  tasksPerPersonPerMonth: 40,
  minutesPerTask: 45,
  loadedHourlyCost: 85,
  automationRate: 0.7,
  reviewMinutesPerTask: 8,
  reworkRate: 0.1,
  costMode: "simple",
  simpleCostPerTask: 0.12,
  inputTokensPerTask: 0,
  outputTokensPerTask: 0,
  inputPricePerMillion: 0,
  outputPricePerMillion: 0,
  implementationCost: 150_000,
  monthlyMaintenance: 4_000,
  discountRate: 0.1,
};

describe("calculateRoi", () => {
  // Fixture 1: the roai.us calculator's default inputs. Hand-traced by evaluating each formula line by line.
  it("fixture 1: default inputs", () => {
    const result = calculateRoi(defaultInputs);
    expect(result.tasksPerYear).toBe(12_000);
    expect(result.currentAnnualHours).toBe(9_000);
    expect(result.currentAnnualCost).toBe(765_000);
    expect(result.automatedTasks).toBe(8_400);
    expect(result.manualTasks).toBe(3_600);
    expect(result.reworkTasks).toBe(840);
    expect(result.postAiHours).toBe(4_450);
    expect(result.postAiLaborCost).toBe(378_250);
    expect(result.costPerTask).toBe(0.12);
    expect(result.annualInferenceCost).toBe(1_008);
    expect(result.annualMaintenance).toBe(48_000);
    expect(result.grossAnnualSavings).toBe(386_750);
    expect(result.netAnnualSavings).toBe(337_742);
    expect(result.paybackMonths).toBeCloseTo(5.3295, 3);
    expect(result.year1NetBenefit).toBe(187_742);
    expect(result.year1RoiPercent).toBeCloseTo(125.1613, 3);
    expect(result.threeYearNpv).toBeCloseTo(689_914.365, 2);
    expect(result.hoursReturnedPerYear).toBe(4_550);
    expect(result.costPerInstanceToday).toBeCloseTo(63.75, 5);
    expect(result.costPerInstanceWithAi).toBeCloseTo(35.6048, 3);
  });

  // Fixture 2: low automation rate + expensive per-task inference cost:
  // the workflow doesn't justify automation on these assumptions.
  it("fixture 2: negative ROI, shown plainly", () => {
    const result = calculateRoi({
      ...defaultInputs,
      headcount: 5,
      tasksPerPersonPerMonth: 20,
      minutesPerTask: 30,
      loadedHourlyCost: 40,
      automationRate: 0.2,
      reviewMinutesPerTask: 25,
      reworkRate: 0.3,
      simpleCostPerTask: 5,
      implementationCost: 200_000,
      monthlyMaintenance: 8_000,
    });
    expect(result.netAnnualSavings).toBeCloseTo(-97_840, 2);
    expect(result.grossAnnualSavings).toBeCloseTo(-640, 2);
    // Never divide by a non-positive net savings, payback is null, not
    // a nonsensical negative duration.
    expect(result.paybackMonths).toBeNull();
    expect(result.year1NetBenefit).toBeCloseTo(-297_840, 2);
    expect(result.year1RoiPercent).toBeCloseTo(-148.92, 2);
    expect(result.threeYearNpv).toBeCloseTo(-443_313.599, 2);
    expect(result.hoursReturnedPerYear).toBeCloseTo(-16, 5);
  });

  // Fixture 3: zero implementation cost, year1RoiPercent has no
  // denominator to divide by, so it must be null, not Infinity or NaN.
  it("fixture 3: zero implementation cost", () => {
    const result = calculateRoi({
      ...defaultInputs,
      headcount: 10,
      tasksPerPersonPerMonth: 50,
      minutesPerTask: 20,
      loadedHourlyCost: 60,
      automationRate: 0.8,
      reviewMinutesPerTask: 3,
      reworkRate: 0.05,
      simpleCostPerTask: 0.05,
      implementationCost: 0,
      monthlyMaintenance: 500,
      discountRate: 0.08,
    });
    expect(result.year1RoiPercent).toBeNull();
    // Positive net savings with zero cost to pay back: payback is
    // immediate (0 months), not null or Infinity.
    expect(result.paybackMonths).toBe(0);
    expect(result.netAnnualSavings).toBeCloseTo(70_560, 2);
    expect(result.threeYearNpv).toBeCloseTo(181_839.963, 2);
  });

  // Fixture 4: token-based cost mode exercises the second branch of
  // costPerTaskFor().
  it("fixture 4: token-based cost mode", () => {
    const result = calculateRoi({
      ...defaultInputs,
      headcount: 15,
      tasksPerPersonPerMonth: 60,
      minutesPerTask: 10,
      loadedHourlyCost: 70,
      automationRate: 0.9,
      reviewMinutesPerTask: 2,
      reworkRate: 0.02,
      costMode: "token",
      inputTokensPerTask: 2_000,
      outputTokensPerTask: 500,
      inputPricePerMillion: 3,
      outputPricePerMillion: 15,
      implementationCost: 80_000,
      monthlyMaintenance: 2_000,
    });
    expect(result.costPerTask).toBeCloseTo(0.0135, 6);
    expect(result.annualInferenceCost).toBeCloseTo(131.22, 2);
    expect(result.netAnnualSavings).toBeCloseTo(64_320.78, 2);
    expect(result.year1RoiPercent).toBeCloseTo(-19.599, 3);
  });

  // Fixture 5: zero headcount collapses every task-derived quantity to
  // zero. The two guarded division paths (costPerInstance*) must return
  // 0, not NaN, and maintenance/implementation costs still apply.
  it("fixture 5: zero headcount (division-by-zero guards)", () => {
    const result = calculateRoi({ ...defaultInputs, headcount: 0 });
    expect(result.tasksPerYear).toBe(0);
    expect(result.costPerInstanceToday).toBe(0);
    expect(result.costPerInstanceWithAi).toBe(0);
    expect(result.netAnnualSavings).toBe(-48_000);
    expect(result.paybackMonths).toBeNull();
    expect(result.year1RoiPercent).toBeCloseTo(-132, 5);
  });

  it("never returns NaN or Infinity for any numeric field across all fixtures", () => {
    const fixtures = [
      defaultInputs,
      { ...defaultInputs, headcount: 0, implementationCost: 0 },
      { ...defaultInputs, discountRate: 0 },
      { ...defaultInputs, costMode: "token" as const },
    ];
    for (const inputs of fixtures) {
      const result = calculateRoi(inputs);
      for (const [key, value] of Object.entries(result)) {
        if (value === null) continue;
        expect(Number.isFinite(value), `${key} should be finite`).toBe(true);
      }
    }
  });

  // Property test: net
  // savings must decrease monotonically as inference cost rises, holding
  // everything else fixed.
  it("net annual savings decreases monotonically as per-task inference cost rises", () => {
    const costs = [0, 0.05, 0.1, 0.2, 0.5, 1, 2, 5];
    const savings = costs.map(
      (cost) =>
        calculateRoi({ ...defaultInputs, simpleCostPerTask: cost })
          .netAnnualSavings,
    );
    for (let i = 1; i < savings.length; i++) {
      expect(savings[i]).toBeLessThan(savings[i - 1] as number);
    }
  });
});

describe("findMostSensitiveInput", () => {
  it("identifies loadedHourlyCost as most sensitive for the default inputs", () => {
    // Hand-verified by perturbing each candidate 30% off the default
    // inputs: loadedHourlyCost moves net savings by ~$116,025 vs
    // automationRate's ~$115,723, a close second, but loadedHourlyCost
    // wins because it scales both the pre- and post-AI labor cost, while
    // automationRate's effect is partly offset by review-time overhead.
    const result = findMostSensitiveInput(defaultInputs);
    expect(result.input).toBe("loadedHourlyCost");
    expect(result.delta).toBeCloseTo(116_025, 0);
  });

  it("reports a lower resulting net savings when the most sensitive input drops", () => {
    const result = findMostSensitiveInput(defaultInputs);
    const baseline = calculateRoi(defaultInputs).netAnnualSavings;
    expect(result.resultingNetAnnualSavings).toBeLessThan(baseline);
  });

  it("still favors loadedHourlyCost when automation is already near-total and cheap", () => {
    const inputs: RoiCalculatorInputs = {
      ...defaultInputs,
      automationRate: 0.95,
      reworkRate: 0.01,
      simpleCostPerTask: 0.01,
      loadedHourlyCost: 200,
    };
    const result = findMostSensitiveInput(inputs);
    expect(result.input).toBe("loadedHourlyCost");
  });
});
