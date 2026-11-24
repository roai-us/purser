# Workflows, outcomes and ROI

ROAI Purser ties AI spend to the work it paid for. The unit is a **workflow**: one kind
of work the AI helps with, such as "support ticket answered" or "pull request
reviewed". Results come in as accepted, reworked or discarded, and Purser reports what
each accepted unit cost against what it cost before.

This follows the ROAI framework in
[Measuring AI ROI: a practical framework](https://roai.us/research/measuring-ai-roi-a-practical-framework).

## A workflow

| Field                  | What it holds                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit`                 | One unit of work, in words                                                                                                                                       |
| `agents`               | The agents whose metered spend counts toward it. An agent counts toward one active workflow at a time, so no dollar is counted twice                             |
| `baseline`             | Minutes a person spent on a unit, their loaded hourly cost, units a month (optional), the day it was measured, how, and whether it was `measured` or `estimated` |
| `attribution`          | How the change is put down to the AI: `holdout` (strongest), `before_after`, or `modelled`                                                                       |
| `defaultReviewMinutes` | Review time counted for a result that doesn't report its own                                                                                                     |
| `costs`                | One-off implementation cost, monthly maintenance, monthly evaluation, and the discount rate for the three-year value                                             |
| `stopIf`               | The number that would stop the program. Required                                                                                                                 |
| `scaleIf`              | The number that would make it worth expanding. Optional                                                                                                          |
| `minUnits`             | Results needed before Purser gives a verdict. Default 30                                                                                                         |

A threshold watches one of `cost_per_accepted_unit` (dollars), `acceptance_rate` (a
fraction from 0 to 1) or `net_monthly_return` (dollars), and fires when the value is
`above` or `below` a line.

### The lock

The unit, baseline, attribution method, thresholds and `minUnits` **lock when the first
result arrives**, and the time is written to `lockedAt` and the audit log. After that,
changing them is refused with `409 locked`. To judge the work by new rules, start a new
workflow. The rules are written down before anyone sees a number, so nobody moves the
goalposts after the fact.

Costs, the linked agents and the default review time can still be corrected after the
lock, because invoices arrive late. Each such change is listed on every report from then
on.

## Results

A result is one of:

- **accepted:** used, perhaps after small fixes. Count the fixing time as review minutes.
- **reworked:** a person had to redo most of it.
- **discarded:** thrown away.

Each result can carry a `count` (a tally), the review minutes for all of them, a `ref`
(your own id, so a retry isn't counted twice) and a note. Results come in three ways:

1. **From the agent,** with its own Purser key:

   ```sh
   curl -X POST "$PURSER_URL/v1/outcomes" \
     -H "Authorization: Bearer $PURSER_AGENT_KEY" \
     -H "content-type: application/json" \
     -d '{"result":"accepted","reviewMinutes":4,"ref":"TICKET-1234"}'
   ```

   Add `"workflow"` only if the agent is in more than one. An agent can report up to
   1,000 units at once. It can't read reports or change a workflow.

2. **Over MCP,** with the `report_outcome` tool ([agent-access.md](agent-access.md)).

3. **By a person,** under Workflows in the web UI, or through the admin API, for teams
   that will never wire up an agent to report. A tally can be dated in the past, but not before the workflow was set up.

Every result records who reported it. Results reported by agents are counted, and the
report says what share came from the agents themselves rather than a person.

A result entered by mistake can be **voided**. It stays on file with who voided it, and
drops out of every count.

## The math

For a period, by default the last 30 days:

```
total cost             = inference + review time + upkeep
cost per accepted unit = total cost ÷ accepted units
value                  = accepted units × baseline cost of a unit
net return             = value − total cost
```

- **Inference** is the metered spend of the workflow's agents in the period.
- **Review time** is the reported review minutes, plus the default for results that
  reported none, at the baseline's hourly cost.
- **Upkeep** is monthly maintenance plus monthly evaluation, for the days in the period.
- **Reworked and discarded units deliver nothing.** A person then does them as before,
  at the baseline cost, which cancels out. Only the inference and review time they took
  count against the AI. This is the paper's formula, `(generation + review cost per
unit) ÷ acceptance rate + amortized evaluation cost`, written per period.

Payback, first-year ROI, the three-year net present value and which single input moves
the result most come from [`@roai-us/roi-core`](../packages/roi-core), the same math as
the roai.us ROI calculator. The report includes the calculator version.

Purser never assumes an acceptance rate of 1. With no results, the acceptance rate is
unknown and the cost per accepted unit has no value. A negative return is shown as
negative.

## How far each number can be trusted

Every number carries one label:

| Label        | Means                                                                     |
| ------------ | ------------------------------------------------------------------------- |
| `measured`   | Counted by Purser, or reported for each result                            |
| `attributed` | Measured, then put down to the AI by a holdout or a before-and-after test |
| `modelled`   | Rests on an estimate, a default or a projection                           |

A number takes the weakest label of its parts. Review time is `modelled` if any of it
is the default. Value is `attributed` with a holdout or before-and-after comparison and
a measured baseline, and `modelled` otherwise. Projections are always `modelled`.

## The verdict

- `too_early` until there are `minUnits` results in the period.
- `stop` when the stop threshold is crossed. Stop wins over scale.
- `scale` when the scale threshold is crossed.
- `continue` otherwise.

With nothing accepted, the cost per accepted unit counts as above any line.

Each report also lists **caveats** in plain sentences: too few results, a period
shorter than a week, results with no metered spend (the agents may be calling
providers directly), calls priced by estimate, default review time, results reported by
the agents themselves, an estimated baseline, modelled attribution, and changes made
after the lock.

## In the web UI

Admins find **Workflows** in the sidebar:

- **The list** shows each workflow's verdict and its last 30 days: results, acceptance
  rate, cost per accepted unit against the cost before, and net return a month.
- **A workflow's page** shows the verdict, the caveats and the rules, takes tallies,
  and lists results, where a mistaken one can be voided. Once the rules lock, the edit
  form shows them but won't change them.
- **The one-page report** follows the framework's five sections: the workflow and its
  unit, the baseline, attribution, the full cost, and the net return with its caveats.
  It names the number that would stop the program, takes any period, and prints on
  one page.

`roai demo-seed` adds four example workflows, one for each verdict.

## Admin API

All under `/admin`, with the admin token or an admin's session. See
[admin-api.md](admin-api.md) for signing in and the error shape.

| Route                                         | Does                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `GET /workflows?status=active\|archived\|all` | Workflows with a summary for the last 30 days                            |
| `POST /workflows`                             | Creates one. `agents` takes agent ids or names                           |
| `GET /workflows/:ref`                         | The workflow, its agents and the report for the last 30 days             |
| `PATCH /workflows/:ref`                       | Changes fields. Locked fields give `409 locked`. `status` archives it    |
| `GET /workflows/:ref/report?from=&to=`        | The report for a period of whole UTC days, both ends included, up to 366 |
| `GET /workflows/:ref/outcomes?limit=`         | Results, newest first, voided ones included                              |
| `POST /workflows/:ref/outcomes`               | Records a result or tally. `at` dates it in the past                     |
| `POST /workflows/:ref/outcomes/:id/void`      | Voids a result                                                           |

`:ref` is the workflow's id or name.

Creating, changing and locking a workflow, recording a result by hand and voiding one
are written to the audit log.

## Not yet

- Results over OpenTelemetry, using the GenAI semantic conventions.
- The five numbers for decision workflows: cost per decision, automation rate, error
  rate, escalation cost and latency.
- Managers setting up workflows for their own departments. For now it takes an admin.
