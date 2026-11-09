# @roai-us/roi-core

The ROI math behind the [roai.us ROI calculator](https://roai.us) and ROAI Purser.
It is made of pure functions with no dependencies, and every branch is tested.

```ts
import { calculateRoi, findMostSensitiveInput } from "@roai-us/roi-core";

const result = calculateRoi({
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
});

result.netAnnualSavings; // labour saved, minus inference and maintenance
result.paybackMonths; // null when the workflow never pays back
findMostSensitiveInput(inputs).input; // which input moves the result most
```

## What it counts

- **Labour before and after,** including human review time for work the AI handles.
  Rework is counted as a full redo.
- **Inference cost.** It is either a cost per task, or tokens times price.
- **Maintenance and implementation.**
- **Payback.** It is `null` when the workflow never pays back.
- **Year-one ROI.**
- **Three-year NPV.**
- **Which single input moves the result most.**

**Rates are fractions, not percents.** 0.7 means 70%.

## Versioning

`ROI_CALCULATOR_VERSION` follows the model, not the package. Store it with every saved
result. Then old results stay interpretable when the model changes.

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE). The rest of ROAI Purser is under a
different license: see [LICENSING.md](../../LICENSING.md).
