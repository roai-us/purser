import { useState, type FormEvent } from "react";
import type {
  Attribution,
  Confidence,
  Labelled,
  NewWorkflow,
  Threshold,
  ThresholdMetric,
  Verdict,
  Workflow,
} from "../api/types";
import { formatDate, formatNumber, formatUsd } from "../lib/format";
import { parseMoney } from "./AgentForm";
import { ErrorNote } from "./Notice";
import { Field } from "./OrgSettings";

export const VERDICT_WORDS: Record<Verdict, string> = {
  too_early: "Too early to judge",
  stop: "Stop",
  scale: "Scale up",
  continue: "Keep going",
};

export const VERDICT_SENTENCES: Record<Verdict, string> = {
  too_early: "Not enough results yet for a verdict.",
  stop: "The stop line is crossed. By the rules written down at the start, this program should stop.",
  scale:
    "The scale line is crossed. By the rules written down at the start, this is worth expanding.",
  continue: "Neither line is crossed. Keep going and keep measuring.",
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return (
    <span className={`verdict verdict-${verdict}`}>
      {VERDICT_WORDS[verdict]}
    </span>
  );
}

const LABEL_HINTS: Record<Confidence, string> = {
  measured: "Counted by Purser, or reported for each result.",
  attributed:
    "Measured, then put down to the AI by a holdout or a before-and-after comparison.",
  modelled: "Rests on an estimate, a default or a projection.",
};

/** How far a number can be trusted, next to the number. */
export function ConfidenceChip({ label }: { label: Confidence }) {
  return (
    <span
      className={`confidence confidence-${label}`}
      title={LABEL_HINTS[label]}
    >
      {label}
    </span>
  );
}

/** A labelled number: the value and its confidence, or a dash when unknown. */
export function LabelledValue({
  value,
  format = formatUsd,
  empty = "Not known yet",
}: {
  value: Labelled;
  format?: (n: number) => string;
  empty?: string;
}) {
  return (
    <span className="labelled">
      {value.value === null ? (
        <span className="muted">{empty}</span>
      ) : (
        <span className={value.value < 0 ? "negative" : undefined}>
          {format(value.value)}
        </span>
      )}{" "}
      <ConfidenceChip label={value.label} />
    </span>
  );
}

export const formatPercent = (fraction: number) =>
  `${formatNumber(Math.round(fraction * 1000) / 10)}%`;

export const formatMonths = (months: number) =>
  `${formatNumber(Math.round(months * 10) / 10)} months`;

export const ATTRIBUTION_WORDS: Record<Attribution, string> = {
  holdout: "Holdout group",
  before_after: "Before and after",
  modelled: "Modelled",
};

export const ATTRIBUTION_SENTENCES: Record<Attribution, string> = {
  holdout:
    "Part of the work was kept away from the AI and measured the same way. The difference is put down to the AI. This is the strongest method.",
  before_after:
    "The same work was measured before and after the AI. Anything else that changed in between is not separated out.",
  modelled:
    "There is no comparison group. The AI's share of the change is an estimate.",
};

const METRIC_WORDS: Record<ThresholdMetric, string> = {
  cost_per_accepted_unit: "cost per accepted unit",
  acceptance_rate: "acceptance rate",
  net_monthly_return: "net return a month",
};

const formatMetric = (metric: ThresholdMetric, value: number) =>
  metric === "acceptance_rate" ? formatPercent(value) : formatUsd(value);

/** "Stop if cost per accepted unit is above $25.00". */
export function thresholdText(verb: "Stop" | "Scale up", t: Threshold): string {
  return `${verb} if ${METRIC_WORDS[t.metric]} is ${t.when} ${formatMetric(t.metric, t.value)}`;
}

// The form for a new or changed workflow.

interface ThresholdDraft {
  metric: ThresholdMetric;
  when: "above" | "below";
  value: string;
}

export interface WorkflowDraft {
  name: string;
  unit: string;
  owner: string;
  ownerEmail: string;
  team: string;
  agents: string;
  minutesPerUnit: string;
  hourlyCostUsd: string;
  unitsPerMonth: string;
  measuredOn: string;
  method: string;
  source: "measured" | "estimated";
  attribution: Attribution;
  defaultReviewMinutes: string;
  implementationUsd: string;
  monthlyMaintenanceUsd: string;
  monthlyEvaluationUsd: string;
  discountPercent: string;
  stop: ThresholdDraft;
  scaleOn: boolean;
  scale: ThresholdDraft;
  minUnits: string;
}

const thresholdDraft = (t: Threshold): ThresholdDraft => ({
  metric: t.metric,
  when: t.when,
  value: String(
    t.metric === "acceptance_rate" ? Math.round(t.value * 1000) / 10 : t.value,
  ),
});

export function emptyDraft(today: string): WorkflowDraft {
  return {
    name: "",
    unit: "",
    owner: "",
    ownerEmail: "",
    team: "",
    agents: "",
    minutesPerUnit: "",
    hourlyCostUsd: "",
    unitsPerMonth: "",
    measuredOn: today,
    method: "",
    source: "measured",
    attribution: "before_after",
    defaultReviewMinutes: "0",
    implementationUsd: "0",
    monthlyMaintenanceUsd: "0",
    monthlyEvaluationUsd: "0",
    discountPercent: "10",
    stop: { metric: "cost_per_accepted_unit", when: "above", value: "" },
    scaleOn: false,
    scale: { metric: "acceptance_rate", when: "above", value: "" },
    minUnits: "30",
  };
}

export function draftFromWorkflow(
  w: Workflow,
  agentNames: string[],
): WorkflowDraft {
  return {
    name: w.name,
    unit: w.unit,
    owner: w.owner,
    ownerEmail: w.ownerEmail ?? "",
    team: w.team ?? "",
    agents: agentNames.join(", "),
    minutesPerUnit: String(w.baseline.minutesPerUnit),
    hourlyCostUsd: String(w.baseline.hourlyCostUsd),
    unitsPerMonth:
      w.baseline.unitsPerMonth === undefined
        ? ""
        : String(w.baseline.unitsPerMonth),
    measuredOn: w.baseline.measuredOn,
    method: w.baseline.method,
    source: w.baseline.source,
    attribution: w.attribution,
    defaultReviewMinutes: String(w.defaultReviewMinutes),
    implementationUsd: String(w.costs.implementationUsd),
    monthlyMaintenanceUsd: String(w.costs.monthlyMaintenanceUsd),
    monthlyEvaluationUsd: String(w.costs.monthlyEvaluationUsd),
    discountPercent: String(Math.round(w.costs.discountRate * 1000) / 10),
    stop: thresholdDraft(w.stopIf),
    scaleOn: w.scaleIf !== undefined,
    scale: w.scaleIf
      ? thresholdDraft(w.scaleIf)
      : { metric: "acceptance_rate", when: "above", value: "" },
    minUnits: String(w.minUnits),
  };
}

const num = (text: string): number | undefined => {
  const cleaned = text.replace(/[,\s]/g, "");
  if (!cleaned) return undefined;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
};

function readThreshold(
  d: ThresholdDraft,
  which: string,
): Threshold | { problem: string } {
  const value = num(d.value.replace(/\$/g, ""));
  if (value === undefined) {
    return { problem: `Enter a number for the ${which} line.` };
  }
  if (d.metric === "acceptance_rate") {
    if (value < 0 || value > 100) {
      return {
        problem: `The ${which} line's acceptance rate is a percent from 0 to 100.`,
      };
    }
    return { metric: d.metric, when: d.when, value: value / 100 };
  }
  if (d.metric === "cost_per_accepted_unit" && value < 0) {
    return { problem: `The ${which} line's cost can't be negative.` };
  }
  return { metric: d.metric, when: d.when, value };
}

/** The draft as an API body, or the first problem with it. */
export function readDraft(d: WorkflowDraft): NewWorkflow | { problem: string } {
  if (!d.name.trim()) return { problem: "Give the workflow a name." };
  if (!d.unit.trim()) return { problem: "Say what one unit of work is." };
  if (!d.owner.trim()) return { problem: "Name the person who owns it." };
  const minutes = num(d.minutesPerUnit);
  if (minutes === undefined || minutes <= 0) {
    return { problem: "Enter the minutes a person spent on one unit before." };
  }
  const hourly = parseMoney(d.hourlyCostUsd);
  if (hourly === undefined) {
    return { problem: "Enter the hourly cost of that person's time." };
  }
  const units = d.unitsPerMonth.trim() ? num(d.unitsPerMonth) : undefined;
  if (d.unitsPerMonth.trim() && (units === undefined || units < 0)) {
    return { problem: "Units a month must be a number, or left empty." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.measuredOn)) {
    return { problem: "Enter the day the baseline was measured." };
  }
  if (!d.method.trim()) {
    return { problem: "Say how the baseline was measured." };
  }
  const review = num(d.defaultReviewMinutes);
  if (review === undefined || review < 0) {
    return { problem: "Default review minutes must be 0 or more." };
  }
  const implementation = parseMoney(d.implementationUsd);
  const maintenance = parseMoney(d.monthlyMaintenanceUsd);
  const evaluation = parseMoney(d.monthlyEvaluationUsd);
  if (
    implementation === undefined ||
    maintenance === undefined ||
    evaluation === undefined
  ) {
    return { problem: "Enter each cost in dollars, or 0." };
  }
  const discount = num(d.discountPercent);
  if (discount === undefined || discount < 0 || discount > 100) {
    return { problem: "The discount rate is a percent from 0 to 100." };
  }
  const stopIf = readThreshold(d.stop, "stop");
  if ("problem" in stopIf) return stopIf;
  let scaleIf: Threshold | undefined;
  if (d.scaleOn) {
    const read = readThreshold(d.scale, "scale");
    if ("problem" in read) return read;
    scaleIf = read;
  }
  const minUnits = num(d.minUnits);
  if (minUnits === undefined || !Number.isInteger(minUnits) || minUnits < 1) {
    return {
      problem:
        "Results needed for a verdict must be a whole number, 1 or more.",
    };
  }
  return {
    name: d.name.trim(),
    unit: d.unit.trim(),
    owner: d.owner.trim(),
    ...(d.ownerEmail.trim() ? { ownerEmail: d.ownerEmail.trim() } : {}),
    ...(d.team.trim() ? { team: d.team.trim() } : {}),
    agents: d.agents
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean),
    baseline: {
      minutesPerUnit: minutes,
      hourlyCostUsd: hourly,
      ...(units === undefined ? {} : { unitsPerMonth: units }),
      measuredOn: d.measuredOn,
      method: d.method.trim(),
      source: d.source,
    },
    attribution: d.attribution,
    defaultReviewMinutes: review,
    costs: {
      implementationUsd: implementation,
      monthlyMaintenanceUsd: maintenance,
      monthlyEvaluationUsd: evaluation,
      discountRate: discount / 100,
    },
    stopIf,
    ...(scaleIf ? { scaleIf } : {}),
    minUnits,
  };
}

function ThresholdFields({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: ThresholdDraft;
  onChange: (next: ThresholdDraft) => void;
  disabled: boolean;
}) {
  return (
    <div className="threshold-fields">
      <Field label={`${label}: when`}>
        <select
          value={value.metric}
          disabled={disabled}
          onChange={(e) =>
            onChange({ ...value, metric: e.target.value as ThresholdMetric })
          }
        >
          <option value="cost_per_accepted_unit">
            Cost per accepted unit ($)
          </option>
          <option value="acceptance_rate">Acceptance rate (%)</option>
          <option value="net_monthly_return">Net return a month ($)</option>
        </select>
      </Field>
      <Field label="is">
        <select
          value={value.when}
          disabled={disabled}
          onChange={(e) =>
            onChange({ ...value, when: e.target.value as "above" | "below" })
          }
        >
          <option value="above">above</option>
          <option value="below">below</option>
        </select>
      </Field>
      <Field label={value.metric === "acceptance_rate" ? "Percent" : "Dollars"}>
        <input
          inputMode="decimal"
          value={value.value}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, value: e.target.value })}
        />
      </Field>
    </div>
  );
}

/**
 * Every field of a workflow. Once locked, the baseline, attribution and
 * thresholds are shown but can't be changed.
 */
export function WorkflowForm({
  initial,
  lockedAt,
  busy,
  error,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: WorkflowDraft;
  lockedAt?: string | undefined;
  busy: boolean;
  error: unknown;
  submitLabel: string;
  onSubmit: (input: NewWorkflow) => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const locked = lockedAt !== undefined;
  const set = <K extends keyof WorkflowDraft>(
    key: K,
    value: WorkflowDraft[K],
  ) => setD((prev) => ({ ...prev, [key]: value }));

  function submit(event: FormEvent) {
    event.preventDefault();
    const read = readDraft(d);
    if ("problem" in read) {
      setProblem(read.problem);
      return;
    }
    setProblem(null);
    onSubmit(read);
  }

  return (
    <form className="stack workflow-form" onSubmit={submit}>
      <div className="grid-2">
        <Field label="Name">
          <input value={d.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field
          label="One unit of work"
          hint='For example "support ticket answered".'
        >
          <input
            value={d.unit}
            disabled={locked}
            onChange={(e) => set("unit", e.target.value)}
          />
        </Field>
        <Field label="Owner">
          <input
            value={d.owner}
            onChange={(e) => set("owner", e.target.value)}
          />
        </Field>
        <Field label="Owner's email (optional)">
          <input
            type="email"
            value={d.ownerEmail}
            onChange={(e) => set("ownerEmail", e.target.value)}
          />
        </Field>
        <Field label="Team (optional)">
          <input value={d.team} onChange={(e) => set("team", e.target.value)} />
        </Field>
        <Field
          label="Agents"
          hint="Names, separated by commas. Their AI spend counts toward this workflow."
        >
          <input
            value={d.agents}
            onChange={(e) => set("agents", e.target.value)}
          />
        </Field>
      </div>

      <fieldset className="form-section">
        <legend>Before the AI: the baseline</legend>
        {locked && (
          <p className="note note-info">
            The baseline, attribution and thresholds locked on{" "}
            {formatDate(lockedAt)}, when the first result arrived. To judge by
            new rules, start a new workflow.
          </p>
        )}
        <div className="grid-2">
          <Field label="Minutes a person spent on one unit">
            <input
              inputMode="decimal"
              value={d.minutesPerUnit}
              disabled={locked}
              onChange={(e) => set("minutesPerUnit", e.target.value)}
            />
          </Field>
          <Field
            label="Hourly cost of that time ($)"
            hint="Fully loaded: pay, benefits and overhead."
          >
            <input
              inputMode="decimal"
              value={d.hourlyCostUsd}
              disabled={locked}
              onChange={(e) => set("hourlyCostUsd", e.target.value)}
            />
          </Field>
          <Field label="Units a month (optional)">
            <input
              inputMode="decimal"
              value={d.unitsPerMonth}
              disabled={locked}
              onChange={(e) => set("unitsPerMonth", e.target.value)}
            />
          </Field>
          <Field label="Measured on">
            <input
              type="date"
              value={d.measuredOn}
              disabled={locked}
              onChange={(e) => set("measuredOn", e.target.value)}
            />
          </Field>
          <Field label="How it was measured" className="span-2">
            <textarea
              rows={2}
              value={d.method}
              disabled={locked}
              onChange={(e) => set("method", e.target.value)}
            />
          </Field>
          <Field label="This baseline is">
            <select
              value={d.source}
              disabled={locked}
              onChange={(e) =>
                set("source", e.target.value as "measured" | "estimated")
              }
            >
              <option value="measured">Measured from real work</option>
              <option value="estimated">An estimate</option>
            </select>
          </Field>
          <Field label="How the change is put down to the AI">
            <select
              value={d.attribution}
              disabled={locked}
              onChange={(e) =>
                set("attribution", e.target.value as Attribution)
              }
            >
              <option value="holdout">Holdout group (strongest)</option>
              <option value="before_after">Before and after</option>
              <option value="modelled">Modelled (weakest)</option>
            </select>
          </Field>
        </div>
      </fieldset>

      <fieldset className="form-section">
        <legend>Written down before any result</legend>
        <ThresholdFields
          label="Stop"
          value={d.stop}
          disabled={locked}
          onChange={(v) => set("stop", v)}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={d.scaleOn}
            disabled={locked}
            onChange={(e) => set("scaleOn", e.target.checked)}
          />
          <span>Also set a line for scaling up</span>
        </label>
        {d.scaleOn && (
          <ThresholdFields
            label="Scale up"
            value={d.scale}
            disabled={locked}
            onChange={(v) => set("scale", v)}
          />
        )}
        <Field label="Results needed before a verdict">
          <input
            inputMode="numeric"
            value={d.minUnits}
            disabled={locked}
            onChange={(e) => set("minUnits", e.target.value)}
          />
        </Field>
      </fieldset>

      <fieldset className="form-section">
        <legend>The full cost</legend>
        <p className="hint">
          AI spend comes from the agents. These are the costs around it. Changes
          after the lock are shown on every report.
        </p>
        <div className="grid-2">
          <Field label="Review minutes for a result that reports none">
            <input
              inputMode="decimal"
              value={d.defaultReviewMinutes}
              onChange={(e) => set("defaultReviewMinutes", e.target.value)}
            />
          </Field>
          <Field label="Implementation, one-off ($)">
            <input
              inputMode="decimal"
              value={d.implementationUsd}
              onChange={(e) => set("implementationUsd", e.target.value)}
            />
          </Field>
          <Field label="Maintenance a month ($)">
            <input
              inputMode="decimal"
              value={d.monthlyMaintenanceUsd}
              onChange={(e) => set("monthlyMaintenanceUsd", e.target.value)}
            />
          </Field>
          <Field
            label="Evaluation a month ($)"
            hint="Test sets, graders, spot checks."
          >
            <input
              inputMode="decimal"
              value={d.monthlyEvaluationUsd}
              onChange={(e) => set("monthlyEvaluationUsd", e.target.value)}
            />
          </Field>
          <Field
            label="Discount rate (%)"
            hint="For the three-year present value."
          >
            <input
              inputMode="decimal"
              value={d.discountPercent}
              onChange={(e) => set("discountPercent", e.target.value)}
            />
          </Field>
        </div>
      </fieldset>

      {problem && (
        <p className="note note-error" role="alert">
          {problem}
        </p>
      )}
      <ErrorNote error={error} />
      <div className="row end">
        <button
          type="button"
          className="button button-ghost"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button type="submit" className="button" disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
