import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { meApi } from "../api/client";
import type { AgentRequest, RequestStatus } from "../api/types";
import { ErrorNote, Loading } from "../components/Notice";
import { formatDateTime, formatRelative, formatUsd } from "../lib/format";

export const REQUEST_STATUS: Record<RequestStatus, string> = {
  pending: "Waiting",
  approved: "Approved",
  denied: "Turned down",
  cancelled: "Cancelled",
};

/** What a request asks for, in one line. */
export function describeRequest(r: AgentRequest): string {
  if (r.kind === "agent" && r.agent) {
    return `New agent ${r.agent.name}, ${formatUsd(r.agent.dailyUsd)} a day`;
  }
  if (r.kind === "service" && r.service) {
    return `${r.service.providerName} for ${r.service.agentName}, ${formatUsd(r.service.dailyUsd)} a day`;
  }
  if (r.raise) {
    return `${formatUsd(r.raise.amountUsd)} more ${r.raise.window === "day" ? "today" : "this month"} for ${r.raise.agentName}`;
  }
  return "Request";
}

/** Shown when an agent asked for this itself, not a person. */
function AskedByAgent({ request: r }: { request: AgentRequest }) {
  return r.askedByAgent ? (
    <span className="badge badge-plain">Asked by {r.askedByAgent.name}</span>
  ) : null;
}

function StatusChip({ status }: { status: RequestStatus }) {
  return (
    <span className={`badge request-${status}`}>{REQUEST_STATUS[status]}</span>
  );
}

/** What the signed-in person asked for, and the answers. */
export function RequestsPage() {
  const queryClient = useQueryClient();
  const requests = useQuery({
    queryKey: ["my-requests"],
    queryFn: meApi.requests,
  });
  const cancel = useMutation({
    mutationFn: meApi.cancelRequest,
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  const decide = useMutation({
    mutationFn: ({ id, yes }: { id: string; yes: boolean }) =>
      yes ? meApi.approve(id) : meApi.deny(id),
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  const items = requests.data?.items ?? [];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>My requests</h1>
          <p className="muted">
            Agents, services and extra budget you or your agents asked for, and
            what was decided.
          </p>
        </div>
      </header>
      <ErrorNote error={cancel.error ?? decide.error} />
      <div className="card flush">
        {requests.isPending ? (
          <Loading />
        ) : requests.isError ? (
          <ErrorNote error={requests.error} />
        ) : items.length === 0 ? (
          <p className="empty">
            Nothing yet. Ask for an agent on the My agents page.
          </p>
        ) : (
          <ul className="request-list">
            {items.map((r) => (
              <li key={r.id} className="request-item">
                <div className="request-main">
                  <StatusChip status={r.status} />
                  <strong>{describeRequest(r)}</strong>
                  <AskedByAgent request={r} />
                  <span className="muted small">
                    Asked {formatRelative(r.createdAt)}
                  </span>
                </div>
                {r.agent?.purpose && <p className="muted">{r.agent.purpose}</p>}
                {r.askedByAgent && r.reason && (
                  <p className="request-reason">"{r.reason}"</p>
                )}
                {r.status === "pending" && r.ownerMayDecide && (
                  <p className="small">
                    Your agent asked for this. It's within what you can give it
                    yourself, so it's your call.
                  </p>
                )}
                {r.decidedAt && (
                  <p className="small">
                    {REQUEST_STATUS[r.status]}{" "}
                    {r.decidedBy === "auto"
                      ? "automatically, within your department's limit"
                      : `by ${r.decidedByName ?? r.decidedBy ?? "someone"}`}{" "}
                    on {formatDateTime(r.decidedAt)}
                    {r.note ? `: "${r.note}"` : "."}
                  </p>
                )}
                <div className="row">
                  {r.status === "pending" && r.ownerMayDecide && (
                    <button
                      type="button"
                      className="button"
                      disabled={decide.isPending}
                      onClick={() => decide.mutate({ id: r.id, yes: true })}
                    >
                      Approve
                    </button>
                  )}
                  {r.status === "pending" && r.ownerMayDecide && (
                    <button
                      type="button"
                      className="button button-ghost"
                      disabled={decide.isPending}
                      onClick={() => decide.mutate({ id: r.id, yes: false })}
                    >
                      Turn down
                    </button>
                  )}
                  {r.status === "pending" && !r.ownerMayDecide && (
                    <button
                      type="button"
                      className="button button-ghost"
                      disabled={cancel.isPending}
                      onClick={() => cancel.mutate(r.id)}
                    >
                      Cancel request
                    </button>
                  )}
                  {r.status === "approved" && r.agentId && (
                    <Link to={`/agents?agent=${encodeURIComponent(r.agentId)}`}>
                      {r.kind === "agent" ? "Open the agent" : "See the agent"}
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Requests the signed-in manager or admin decides. */
export function ApprovalsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "decided" ? "decided" : "pending";
  const department = params.get("department");
  const approvals = useQuery({
    queryKey: ["approvals"],
    queryFn: () => meApi.approvals(),
    refetchInterval: 30_000,
  });
  const all = approvals.data?.items ?? [];
  const items = all.filter(
    (r) =>
      (tab === "pending" ? r.status === "pending" : r.status !== "pending") &&
      (!department || r.department === department),
  );
  const waiting = all.filter((r) => r.status === "pending").length;
  const setTab = (next: string | null) =>
    setParams(
      (current) => {
        const p = new URLSearchParams(current);
        if (next) p.set("tab", next);
        else p.delete("tab");
        return p;
      },
      { replace: true },
    );

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Approvals</h1>
          <p className="muted">
            New agents and extra budget people asked for.
            {department ? ` Showing ${department}.` : ""}
          </p>
        </div>
        {department && (
          <Link className="button button-ghost" to="/approvals">
            All departments
          </Link>
        )}
      </header>
      <div className="segmented" role="group" aria-label="Show">
        <button
          type="button"
          aria-pressed={tab === "pending"}
          onClick={() => setTab(null)}
        >
          Waiting ({waiting})
        </button>
        <button
          type="button"
          aria-pressed={tab === "decided"}
          onClick={() => setTab("decided")}
        >
          Decided
        </button>
      </div>
      <div className="card flush">
        {approvals.isPending ? (
          <Loading />
        ) : approvals.isError ? (
          <ErrorNote error={approvals.error} />
        ) : items.length === 0 ? (
          <p className="empty">
            {tab === "pending" ? "Nothing waiting for you." : "Nothing yet."}
          </p>
        ) : (
          <ul className="request-list">
            {items.map((r) => (
              <Decision key={r.id} request={r} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Decision({ request: r }: { request: AgentRequest }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const decide = useMutation({
    mutationFn: (kind: "approve" | "deny") =>
      kind === "approve"
        ? meApi.approve(r.id, note.trim() || undefined)
        : meApi.deny(r.id, note.trim() || undefined),
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  return (
    <li className="request-item">
      <div className="request-main">
        <StatusChip status={r.status} />
        <strong>{describeRequest(r)}</strong>
        <AskedByAgent request={r} />
        <span className="muted small">
          {r.askedByAgent ? "Owner: " : ""}
          {r.byName}
          {r.department ? `, ${r.department}` : ""},{" "}
          {formatRelative(r.createdAt)}
        </span>
      </div>
      {r.agent && (
        <p>
          {/[.!?]$/.test(r.agent.purpose)
            ? r.agent.purpose
            : `${r.agent.purpose}.`}
          {r.agent.monthlyUsd !== undefined &&
            ` Up to ${formatUsd(r.agent.monthlyUsd)} a month.`}
          {r.agent.providers?.length
            ? ` Through ${r.agent.providers.join(", ")}.`
            : ""}
        </p>
      )}
      {r.reason && <p className="request-reason">"{r.reason}"</p>}
      {r.status === "pending" ? (
        <div className="row bottom">
          <label className="field grow">
            <span>Note to {r.byName.split(" ")[0]} (optional)</span>
            <input
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="button"
            disabled={decide.isPending}
            onClick={() => decide.mutate("approve")}
          >
            Approve
          </button>
          <button
            type="button"
            className="button button-ghost"
            disabled={decide.isPending}
            onClick={() => decide.mutate("deny")}
          >
            Turn down
          </button>
        </div>
      ) : (
        <p className="small muted">
          {REQUEST_STATUS[r.status]}
          {r.decidedBy ? ` by ${r.decidedByName ?? r.decidedBy}` : ""}
          {r.decidedAt ? ` on ${formatDateTime(r.decidedAt)}` : ""}
          {r.note ? `: "${r.note}"` : ""}
        </p>
      )}
      <ErrorNote error={decide.error} />
    </li>
  );
}
