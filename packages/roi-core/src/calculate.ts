/**
 * Pure ROI math. No imports beyond types, no React, no formatting.
 * Shared by the roai.us ROI calculator and ROAI Purser. "Wrong math is
 * unrecoverable": every branch here has a corresponding test in
 * calculate.test.ts, including a hand-verified fixture.
 */
export const ROI_CALCULATOR_VERSION = "1.0.0";

export interface RoiCalculatorInputs {
  /** Step 1: the workflow. */
  headcount: number;
  tasksPerPersonPerMonth: number;
  minutesPerTask: number;
  loadedHourlyCost: number;
  /** Step 2: the AI intervention. Fractions (0 to 1), not percents. */
  automationRate: number;
  reviewMinutesPerTask: number;
  reworkRate: number;
  /** Step 3: AI cost. */
  costMode: "simple" | "token";
  simpleCostPerTask: number;
  inputTokensPerTask: number;
  outputTokensPerTask: number;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  /** Step 4: investment. `discountRate` is a fraction (0.10 = 10%). */
  implementationCost: number;
  monthlyMaintenance: number;
  discountRate: number;
}

export interface RoiCalculatorResults {
  tasksPerYear: number;
  currentAnnualHours: number;
  currentAnnualCost: number;
  automatedTasks: number;
  manualTasks: number;
  reworkTasks: number;
  postAiHours: number;
  postAiLaborCost: number;
  costPerTask: number;
  annualInferenceCost: number;
  annualMaintenance: number;
  grossAnnualSavings: number;
  netAnnualSavings: number;
  /** `null` when net annual savings isn't positive, never divide by a non-positive number. */
  paybackMonths: number | null;
  year1NetBenefit: number;
  /** `null` when there was no implementation cost to compare against. */
  year1RoiPercent: number | null;
  threeYearNpv: number;
  hoursReturnedPerYear: number;
  costPerInstanceToday: number;
  costPerInstanceWithAi: number;
}

function costPerTaskFor(inputs: RoiCalculatorInputs): number {
  if (inputs.costMode === "simple") return inputs.simpleCostPerTask;
  return (
    (inputs.inputTokensPerTask / 1_000_000) * inputs.inputPricePerMillion +
    (inputs.outputTokensPerTask / 1_000_000) * inputs.outputPricePerMillion
  );
}

export function calculateRoi(
  inputs: RoiCalculatorInputs,
): RoiCalculatorResults {
  const tasksPerYear = inputs.headcount * inputs.tasksPerPersonPerMonth * 12;
  const currentAnnualHours = (tasksPerYear * inputs.minutesPerTask) / 60;
  const currentAnnualCost = currentAnnualHours * inputs.loadedHourlyCost;

  const automatedTasks = tasksPerYear * inputs.automationRate;
  const manualTasks = tasksPerYear - automatedTasks;
  const reworkTasks = automatedTasks * inputs.reworkRate;

  const postAiMinutes =
    manualTasks * inputs.minutesPerTask +
    automatedTasks * inputs.reviewMinutesPerTask +
    reworkTasks * inputs.minutesPerTask;
  const postAiHours = postAiMinutes / 60;
  const postAiLaborCost = postAiHours * inputs.loadedHourlyCost;

  const costPerTask = costPerTaskFor(inputs);
  const annualInferenceCost = automatedTasks * costPerTask;
  const annualMaintenance = inputs.monthlyMaintenance * 12;

  const grossAnnualSavings = currentAnnualCost - postAiLaborCost;
  const netAnnualSavings =
    grossAnnualSavings - annualInferenceCost - annualMaintenance;

  const paybackMonths =
    netAnnualSavings > 0
      ? inputs.implementationCost / (netAnnualSavings / 12)
      : null;
  const year1NetBenefit = netAnnualSavings - inputs.implementationCost;
  const year1RoiPercent =
    inputs.implementationCost > 0
      ? (year1NetBenefit / inputs.implementationCost) * 100
      : null;

  let threeYearNpv = -inputs.implementationCost;
  for (let year = 1; year <= 3; year++) {
    threeYearNpv += netAnnualSavings / (1 + inputs.discountRate) ** year;
  }

  const hoursReturnedPerYear = currentAnnualHours - postAiHours;
  const costPerInstanceToday =
    tasksPerYear > 0 ? currentAnnualCost / tasksPerYear : 0;
  const costPerInstanceWithAi =
    tasksPerYear > 0
      ? (postAiLaborCost + annualInferenceCost + annualMaintenance) /
        tasksPerYear
      : 0;

  return {
    tasksPerYear,
    currentAnnualHours,
    currentAnnualCost,
    automatedTasks,
    manualTasks,
    reworkTasks,
    postAiHours,
    postAiLaborCost,
    costPerTask,
    annualInferenceCost,
    annualMaintenance,
    grossAnnualSavings,
    netAnnualSavings,
    paybackMonths,
    year1NetBenefit,
    year1RoiPercent,
    threeYearNpv,
    hoursReturnedPerYear,
    costPerInstanceToday,
    costPerInstanceWithAi,
  };
}

export type SensitivityInputKey =
  "automationRate" | "loadedHourlyCost" | "reworkRate" | "costPerTask";

export interface SensitivityResult {
  input: SensitivityInputKey;
  /** The perturbed value used for the comparison, in the same unit as the original input. */
  perturbedValue: number;
  /** Net annual savings if that one input had been `perturbedValue` instead. */
  resultingNetAnnualSavings: number;
  /** Absolute change in net annual savings caused by the perturbation, the ranking key. */
  delta: number;
}

/**
 * Perturbs each candidate input by 30% (automationRate and reworkRate are
 * fractions, so a 30%-of-current-value nudge stays inside 0 to 1 for any
 * starting value below ~0.77) and reports which single change moves net
 * annual savings the most ("identify which single input most affects
 * the result").
 */
export function findMostSensitiveInput(
  inputs: RoiCalculatorInputs,
): SensitivityResult {
  const baseline = calculateRoi(inputs).netAnnualSavings;

  const candidates: SensitivityInputKey[] = [
    "automationRate",
    "loadedHourlyCost",
    "reworkRate",
    "costPerTask",
  ];

  const results = candidates.map((key): SensitivityResult => {
    let perturbedInputs: RoiCalculatorInputs;
    let perturbedValue: number;

    if (key === "costPerTask") {
      // costPerTask isn't a direct input in token mode, so perturb via
      // simpleCostPerTask regardless of mode, a proxy for "the AI cost
      // per instance," which is what the sensitivity note is about.
      perturbedValue = inputs.simpleCostPerTask * 0.7;
      perturbedInputs = {
        ...inputs,
        costMode: "simple",
        simpleCostPerTask: perturbedValue,
      };
    } else {
      perturbedValue = inputs[key] * 0.7;
      perturbedInputs = { ...inputs, [key]: perturbedValue };
    }

    const resultingNetAnnualSavings =
      calculateRoi(perturbedInputs).netAnnualSavings;
    return {
      input: key,
      perturbedValue,
      resultingNetAnnualSavings,
      delta: Math.abs(resultingNetAnnualSavings - baseline),
    };
  });

  return results.reduce((most, candidate) =>
    candidate.delta > most.delta ? candidate : most,
  );
}
