import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api/client";
import type {
  Outcome,
  OutcomeResult,
  Workflow,
  WorkflowAgent,
} from "../api/types";
import { Dialog } from "../components/Dialog";
import { ErrorNote, Loading } from "../components/Notice";
import { Field } from "../components/OrgSettings";
import {
  ATTRIBUTION_WORDS,
  draftFromWorkflow,
  formatPercent,
  LabelledValue,
  thresholdText,
  VERDICT_SENTENCES,
  VerdictBadge,
  WorkflowForm,
} from "../components/Roi";
import {
  formatDate,
  formatDateTime,
  formatNumber,
  formatUsd,
} from "../lib/format";
import "../org.css";
import "../roi.css";

const RESULT_WORDS: Record<OutcomeResult, string> = {
  accepted: "Accepted",
  reworked: "Reworked",
  discarded: "Discarded",
};

export function WorkflowDetailPage() {
  const { ref = "" } = useParams();
  const detail = useQuery({
    queryKey: ["workflow", ref],
    queryFn: () => api.workflow(ref),
  });
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (detail.isPending) return <Loading label="Loading the workflow" />;
  if (detail.isError) {
    return (
      <div className="page">
        <ErrorNote error={detail.error} />
        <p>
          <Link to="/workflows">All workflows</Link>
        </p>
      </div>
    );
  }
  const { workflow, agents, report } = detail.data;
  const reportLink = `/workflows/${encodeURIComponent(workflow.name)}/report`;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">
            <Link to="/workflows">Workflows</Link>
          </p>
          <h1>{workflow.name}</h1>
          <p className="muted">
            One unit: {workflow.unit}. Owner: {workflow.owner}
            {workflow.team ? `, ${workflow.team}` : ""}.
            {workflow.status === "archived" ? " Archived." : ""}
          </p>
        </div>
        <div className="row">
          <Link to={reportLink} className="button">
            One-page report
          </Link>
          <button
            type="button"
            className="button button-soft"
            onClick={() => {
              setNotice(null);
              setEditing(true);
            }}
          >
            Edit
          </button>
        </div>
      </header>

      {notice && (
        <p className="note note-ok" role="status">
          {notice}
        </p>
      )}

      <section className={`verdict-card verdict-card-${report.verdict}`}>
        <VerdictBadge verdict={report.verdict} />
        <p>{VERDICT_SENTENCES[report.verdict]}</p>
        <p className="small muted">
          Last 30 days, {formatDate(report.period.from)} to{" "}
          {formatDate(report.period.to)}.
        </p>
      </section>

      <section className="tiles" aria-label="Last 30 days">
        <div className="tile">
          <div className="tile-label">Cost per accepted unit</div>
          <div className="tile-value">
            <LabelledValue value={report.perUnit.costPerAcceptedUnit} />
          </div>
          <div className="tile-sub">
            Before the AI: {formatUsd(report.perUnit.baseline.value ?? 0)}
          </div>
        </div>
        <div className="tile">
          <div className="tile-label">Accepted</div>
          <div className="tile-value">
            {report.results.acceptanceRate === null
              ? "None yet"
              : formatPercent(report.results.acceptanceRate)}
          </div>
          <div className="tile-sub">
            {formatNumber(report.results.accepted)} of{" "}
            {formatNumber(report.results.total)} results
          </div>
        </div>
        <div className="tile">
          <div className="tile-label">Net return a month</div>
          <div className="tile-value">
            <LabelledValue value={report.netMonthlyReturn} />
          </div>
          <div className="tile-sub">
            Total cost {formatUsd(report.cost.total.value ?? 0)} in 30 days
          </div>
        </div>
      </section>

      {report.caveats.length > 0 && (
        <section className="card stack">
          <h2>What weakens these numbers</h2>
          <ul className="caveats">
            {report.caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid-2 roi-columns">
        <Rules workflow={workflow} agents={agents} />
        {workflow.status === "active" ? (
          <RecordResults
            workflow={workflow}
            onRecorded={(text) => setNotice(text)}
          />
        ) : (
          <section className="card stack">
            <h2>Record results</h2>
            <p className="muted">
              This workflow is archived and takes no more results.
            </p>
          </section>
        )}
      </div>

      <Results workflow={workflow} agents={agents} />

      {editing && (
        <EditWorkflowDialog
          workflow={workflow}
          agents={agents}
          onClose={() => setEditing(false)}
          onSaved={(text) => {
            setEditing(false);
            setNotice(text);
          }}
        />
      )}
    </div>
  );
}

function Rules({
  workflow,
  agents,
}: {
  workflow: Workflow;
  agents: WorkflowAgent[];
}) {
  const b = workflow.baseline;
  return (
    <section className="card stack">
      <h2>The rules</h2>
      <p className="small muted">
        {workflow.lockedAt
          ? `Locked on ${formatDate(workflow.lockedAt)}, when the first result arrived.`
          : "Not locked yet. These lock when the first result arrives."}
      </p>
      <dl className="facts compact">
        <div>
          <dt>Before the AI</dt>
          <dd>
            {formatNumber(b.minutesPerUnit)} minutes at{" "}
            {formatUsd(b.hourlyCostUsd)} an hour,{" "}
            {b.source === "measured" ? "measured" : "estimated"} on{" "}
            {formatDate(b.measuredOn)}
          </dd>
        </div>
        <div>
          <dt>Attribution</dt>
          <dd>{ATTRIBUTION_WORDS[workflow.attribution]}</dd>
        </div>
        <div>
          <dt>Stop line</dt>
          <dd>{thresholdText("Stop", workflow.stopIf)}</dd>
        </div>
        <div>
          <dt>Scale line</dt>
          <dd>
            {workflow.scaleIf
              ? thresholdText("Scale up", workflow.scaleIf)
              : "None set"}
          </dd>
        </div>
        <div>
          <dt>Verdict after</dt>
          <dd>{formatNumber(workflow.minUnits)} results</dd>
        </div>
        <div>
          <dt>Agents</dt>
          <dd>
            {agents.length === 0
              ? "None linked"
              : agents.map((a) => a.name ?? `${a.id} (removed)`).join(", ")}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function RecordResults({
  workflow,
  onRecorded,
}: {
  workflow: Workflow;
  onRecorded: (text: string) => void;
}) {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<OutcomeResult>("accepted");
  const [count, setCount] = useState("1");
  const [minutes, setMinutes] = useState("");
  const [day, setDay] = useState("");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const record = useMutation({
    mutationFn: (input: Parameters<typeof api.recordOutcome>[1]) =>
      api.recordOutcome(workflow.id, input),
    onSuccess: (done) => {
      void queryClient.invalidateQueries({ queryKey: ["workflow"] });
      void queryClient.invalidateQueries({ queryKey: ["outcomes"] });
      void queryClient.invalidateQueries({ queryKey: ["workflows"] });
      setCount("1");
      setMinutes("");
      setNote("");
      const what = `Recorded ${formatNumber(done.outcome.count)} ${done.outcome.result}.`;
      onRecorded(
        done.locked
          ? `${what} That was the first result, so the rules are now locked.`
          : what,
      );
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1) {
      setProblem("How many: a whole number, 1 or more.");
      return;
    }
    const m = minutes.trim() ? Number(minutes) : undefined;
    if (m !== undefined && (!Number.isFinite(m) || m < 0)) {
      setProblem("Review minutes must be a number, or left empty.");
      return;
    }
    setProblem(null);
    record.mutate({
      result,
      count: n,
      ...(m === undefined ? {} : { reviewMinutes: m }),
      ...(note.trim() ? { note: note.trim() } : {}),
      // Noon UTC on the chosen day, so it lands on that day everywhere.
      ...(day ? { at: `${day}T12:00:00.000Z` } : {}),
    });
  }

  return (
    <section className="card stack">
      <h2>Record results</h2>
      <p className="small muted">
        For a tally kept by hand. Agents can report their own with their key;
        see the docs.
      </p>
      <form className="stack" onSubmit={submit}>
        <div className="grid-2">
          <Field label="Result">
            <select
              value={result}
              onChange={(e) => setResult(e.target.value as OutcomeResult)}
            >
              <option value="accepted">
                Accepted: used, maybe after small fixes
              </option>
              <option value="reworked">
                Reworked: a person redid most of it
              </option>
              <option value="discarded">Discarded: thrown away</option>
            </select>
          </Field>
          <Field label="How many">
            <input
              inputMode="numeric"
              value={count}
              onChange={(e) => setCount(e.target.value)}
            />
          </Field>
          <Field
            label="Review minutes, all together"
            hint={`Empty: ${formatNumber(workflow.defaultReviewMinutes)} a result, marked as modelled.`}
          >
            <input
              inputMode="decimal"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </Field>
          <Field label="Day (optional)" hint="Empty: today.">
            <input
              type="date"
              value={day}
              onChange={(e) => setDay(e.target.value)}
            />
          </Field>
          <Field label="Note (optional)" className="span-2">
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        {problem && (
          <p className="note note-error" role="alert">
            {problem}
          </p>
        )}
        <ErrorNote error={record.error} />
        <div className="row end">
          <button type="submit" className="button" disabled={record.isPending}>
            {record.isPending ? "Recording…" : "Record"}
          </button>
        </div>
      </form>
    </section>
  );
}

function Results({
  workflow,
  agents,
}: {
  workflow: Workflow;
  agents: WorkflowAgent[];
}) {
  const queryClient = useQueryClient();
  const outcomes = useQuery({
    queryKey: ["outcomes", workflow.id],
    queryFn: () => api.outcomes(workflow.id),
  });
  const [voiding, setVoiding] = useState<Outcome | null>(null);
  const voidIt = useMutation({
    mutationFn: (id: string) => api.voidOutcome(workflow.id, id),
    onSuccess: () => {
      setVoiding(null);
      void queryClient.invalidateQueries({ queryKey: ["workflow"] });
      void queryClient.invalidateQueries({ queryKey: ["outcomes"] });
      void queryClient.invalidateQueries({ queryKey: ["workflows"] });
    },
  });
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;

  return (
    <section className="card flush">
      <div className="card-head">
        <h2>Results</h2>
        {outcomes.data && (
          <span className="muted small">
            {outcomes.data.total > outcomes.data.outcomes.length
              ? `Newest ${formatNumber(outcomes.data.outcomes.length)} of ${formatNumber(outcomes.data.total)}`
              : `${formatNumber(outcomes.data.total)} in all`}
          </span>
        )}
      </div>
      {outcomes.isPending ? (
        <Loading label="Loading results" />
      ) : outcomes.isError ? (
        <ErrorNote error={outcomes.error} />
      ) : outcomes.data.outcomes.length === 0 ? (
        <p className="empty">No results yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table outcomes-table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Result</th>
                <th scope="col">How many</th>
                <th scope="col">Review minutes</th>
                <th scope="col">Reported by</th>
                <th scope="col">Note</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {outcomes.data.outcomes.map((o) => (
                <tr key={o.id} className={o.voidedAt ? "voided" : undefined}>
                  <td>{formatDateTime(o.at)}</td>
                  <td>
                    {RESULT_WORDS[o.result]}
                    {o.voidedAt && (
                      <span className="cell-sub">
                        Voided by {o.voidedBy} on {formatDate(o.voidedAt)}
                      </span>
                    )}
                  </td>
                  <td>{formatNumber(o.count)}</td>
                  <td>
                    {o.reviewMinutes === undefined ? (
                      <span className="muted">Default</span>
                    ) : (
                      formatNumber(o.reviewMinutes)
                    )}
                  </td>
                  <td>
                    {o.source === "agent" ? (
                      <>
                        {agentName(o.by)}
                        <span className="cell-sub">the agent itself</span>
                      </>
                    ) : (
                      o.by
                    )}
                  </td>
                  <td>{o.note ?? o.ref ?? ""}</td>
                  <td>
                    {!o.voidedAt && (
                      <button
                        type="button"
                        className="button button-ghost"
                        aria-label={`Void ${o.count} ${o.result} from ${formatDateTime(o.at)}`}
                        onClick={() => setVoiding(o)}
                      >
                        Void
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {voiding && (
        <Dialog title="Void this result?" onClose={() => setVoiding(null)}>
          <div className="stack">
            <p>
              {formatNumber(voiding.count)} {voiding.result}, from{" "}
              {formatDateTime(voiding.at)}, will drop out of every count. It
              stays on file with your name, and can't be counted again.
            </p>
            <ErrorNote error={voidIt.error} />
            <div className="row end">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setVoiding(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button button-danger"
                disabled={voidIt.isPending}
                onClick={() => voidIt.mutate(voiding.id)}
              >
                Void it
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}

function EditWorkflowDialog({
  workflow,
  agents,
  onClose,
  onSaved,
}: {
  workflow: Workflow;
  agents: WorkflowAgent[];
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const save = useMutation({
    mutationFn: (patch: Parameters<typeof api.updateWorkflow>[1]) =>
      api.updateWorkflow(workflow.id, patch),
    onSuccess: ({ workflow: next }) => {
      void queryClient.invalidateQueries();
      if (next.name !== workflow.name) {
        navigate(`/workflows/${encodeURIComponent(next.name)}`, {
          replace: true,
        });
      }
    },
  });
  const archive = useMutation({
    mutationFn: () =>
      api.updateWorkflow(workflow.id, {
        status: workflow.status === "active" ? "archived" : "active",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      onSaved(
        workflow.status === "active"
          ? `Archived ${workflow.name}. Its agents can join another workflow.`
          : `Reopened ${workflow.name}.`,
      );
    },
  });

  return (
    <Dialog title={`Edit ${workflow.name}`} onClose={onClose} wide>
      <div className="stack">
        <WorkflowForm
          initial={draftFromWorkflow(
            workflow,
            agents.map((a) => a.name ?? a.id),
          )}
          lockedAt={workflow.lockedAt}
          busy={save.isPending}
          error={save.error}
          submitLabel="Save"
          onSubmit={(input) =>
            save.mutate(
              {
                ...input,
                ownerEmail: input.ownerEmail ?? null,
                team: input.team ?? null,
                scaleIf: input.scaleIf ?? null,
              },
              { onSuccess: () => onSaved(`Saved ${input.name}.`) },
            )
          }
          onCancel={onClose}
        />
        <hr />
        <div className="row between">
          <p className="small muted">
            {workflow.status === "active"
              ? "Archiving keeps every result and report, takes no more results, and frees its agents."
              : "Reopening takes results again."}
          </p>
          <button
            type="button"
            className="button button-soft"
            disabled={archive.isPending}
            onClick={() => archive.mutate()}
          >
            {workflow.status === "active" ? "Archive" : "Reopen"}
          </button>
        </div>
        <ErrorNote error={archive.error} />
      </div>
    </Dialog>
  );
}
