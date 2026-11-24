import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { api } from "../api/client";
import { Dialog } from "../components/Dialog";
import { ErrorNote, Loading } from "../components/Notice";
import {
  emptyDraft,
  formatPercent,
  LabelledValue,
  VerdictBadge,
  WorkflowForm,
} from "../components/Roi";
import { formatNumber } from "../lib/format";
import "../roi.css";

export function WorkflowsPage() {
  const [status, setStatus] = useState<"active" | "archived">("active");
  const [creating, setCreating] = useState(false);
  const list = useQuery({
    queryKey: ["workflows", status],
    queryFn: () => api.workflows(status),
  });
  const rows = list.data?.workflows ?? [];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Workflows</h1>
          <p className="muted">
            What the AI's work returns: cost per accepted unit against the cost
            before, over the last 30 days.
          </p>
        </div>
        <button
          type="button"
          className="button"
          onClick={() => setCreating(true)}
        >
          New workflow
        </button>
      </header>

      <div className="tabs" role="tablist" aria-label="Which workflows">
        {(["active", "archived"] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={status === s}
            className={status === s ? "tab tab-on" : "tab"}
            onClick={() => setStatus(s)}
          >
            {s === "active" ? "Active" : "Archived"}
          </button>
        ))}
      </div>

      <div className="card flush">
        {list.isPending ? (
          <Loading label="Loading workflows" />
        ) : list.isError ? (
          <ErrorNote error={list.error} />
        ) : rows.length === 0 ? (
          <div className="empty stack">
            {status === "active" ? (
              <>
                <p>
                  No workflows yet. A workflow is one kind of work the AI helps
                  with, such as answering support tickets. Write down how long
                  it took before and the number that would make you stop, then
                  count the results.
                </p>
                <p>
                  <button
                    type="button"
                    className="button"
                    onClick={() => setCreating(true)}
                  >
                    Set up the first one
                  </button>
                </p>
              </>
            ) : (
              <p>No archived workflows.</p>
            )}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table workflows-table">
              <thead>
                <tr>
                  <th scope="col">Workflow</th>
                  <th scope="col">Verdict</th>
                  <th scope="col">Results</th>
                  <th scope="col">Accepted</th>
                  <th scope="col">Cost per accepted unit</th>
                  <th scope="col">Before the AI</th>
                  <th scope="col">Net return a month</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => (
                  <tr key={w.id}>
                    <th scope="row">
                      <Link to={`/workflows/${encodeURIComponent(w.name)}`}>
                        {w.name}
                      </Link>
                      <span className="cell-sub">{w.unit}</span>
                    </th>
                    <td>
                      <VerdictBadge verdict={w.summary.verdict} />
                    </td>
                    <td>{formatNumber(w.summary.results)}</td>
                    <td>
                      {w.summary.acceptanceRate === null ? (
                        <span className="muted">None yet</span>
                      ) : (
                        formatPercent(w.summary.acceptanceRate)
                      )}
                    </td>
                    <td>
                      <LabelledValue value={w.summary.costPerAcceptedUnit} />
                    </td>
                    <td>
                      <LabelledValue value={w.summary.baselineCostPerUnit} />
                    </td>
                    <td>
                      <LabelledValue value={w.summary.netMonthlyReturn} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {creating && <NewWorkflowDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewWorkflowDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: api.createWorkflow,
    onSuccess: ({ workflow }) => {
      void queryClient.invalidateQueries({ queryKey: ["workflows"] });
      navigate(`/workflows/${encodeURIComponent(workflow.name)}`);
    },
  });
  return (
    <Dialog title="New workflow" onClose={onClose} wide>
      <WorkflowForm
        initial={emptyDraft(new Date().toISOString().slice(0, 10))}
        busy={create.isPending}
        error={create.error}
        submitLabel="Create workflow"
        onSubmit={(input) => create.mutate(input)}
        onCancel={onClose}
      />
    </Dialog>
  );
}
