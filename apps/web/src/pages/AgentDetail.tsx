import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../api/client";
import type { Agent, AgentPatch, Connector, RotateResult } from "../api/types";
import { parseMoney } from "../components/AgentForm";
import { GracePicker } from "../components/GracePicker";
import { KeyExpiry } from "../components/KeyExpiry";
import {
  expiryFromPolicy,
  KeyPolicyFields,
  policyFromAgent,
  rotationFromPolicy,
} from "../components/KeyPolicyFields";
import { KeyReveal } from "../components/KeyReveal";
import { capNow, RaiseLimitDialog } from "../components/RaiseLimit";
import { AgentServices } from "../components/AgentServices";
import { ConnectAgent } from "../components/ConnectAgent";
import { ConnectionValues } from "../components/ConnectionValues";
import { useAgentApi } from "../lib/agentApi";
import { ErrorNote, Loading } from "../components/Notice";
import { SpendBar } from "../components/SpendBar";
import { SpendChart } from "../components/SpendChart";
import { StateBadge } from "../components/StateBadge";
import { StatusLight } from "../components/StatusLight";
import {
  formatDateTime,
  formatRelative,
  formatUsd,
  rotationLabel,
} from "../lib/format";

/** Side panel with one agent's details, limits, key and spending. */
export function AgentDetail({
  agentRef,
  connectors,
  onClose,
}: {
  agentRef: string;
  connectors: Connector[];
  onClose: () => void;
}) {
  const agentApi = useAgentApi();
  const admin = agentApi.scope === "admin";
  const agent = useQuery({
    queryKey: ["agent", agentRef],
    queryFn: () => agentApi.agent(agentRef),
  });
  const usage = useQuery({
    queryKey: ["agent-usage", agentRef],
    queryFn: () => agentApi.agentUsage(agentRef, 30),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".backdrop")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className="panel" aria-label="Agent details">
      <div className="panel-head">
        <h2 className="name-cell">
          {agent.data && <StatusLight state={agent.data.state} />}
          {agent.data?.name ?? "Agent"}
        </h2>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Close details"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" className="stroke" />
          </svg>
        </button>
      </div>
      {agent.isPending ? (
        <Loading />
      ) : agent.isError ? (
        <ErrorNote error={agent.error} />
      ) : (
        <div className="panel-body">
          <StopControls agent={agent.data} />
          <Facts agent={agent.data} connectors={connectors} />
          <AgentServices agent={agent.data} connectors={connectors} />
          <RotateKey agent={agent.data} connectors={connectors} />
          {admin && <CallLogging agent={agent.data} />}
          <section className="stack" aria-labelledby="spend-h">
            <h3 id="spend-h">Last 30 days</h3>
            {usage.isPending ? (
              <Loading />
            ) : usage.isError ? (
              <ErrorNote error={usage.error} />
            ) : (
              <SpendChart daily={usage.data.daily} />
            )}
          </section>
          {admin && (
            <EditAgent
              key={agent.data.id}
              agent={agent.data}
              connectors={connectors}
            />
          )}
          <section className="stack" aria-labelledby="recent-h">
            <div className="row between">
              <h3 id="recent-h">Recent requests</h3>
              {admin && (
                <span className="row">
                  <Link to={`/logs?agent=${encodeURIComponent(agent.data.id)}`}>
                    Its call log
                  </Link>
                  <Link
                    to={`/activity?agent=${encodeURIComponent(agent.data.id)}`}
                  >
                    Its activity
                  </Link>
                </span>
              )}
            </div>
            {usage.data && usage.data.recent.length === 0 && (
              <p className="muted">No requests yet.</p>
            )}
            {usage.data && usage.data.recent.length > 0 && (
              <div className="table-wrap">
                <table className="table small">
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Model</th>
                      <th scope="col">Cost</th>
                      <th scope="col">Result</th>
                      <th scope="col">
                        <span className="sr-only">Log</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.data.recent.map((r) => (
                      <tr key={r.id}>
                        <td>{formatDateTime(r.at)}</td>
                        <td className="mono">{r.model}</td>
                        <td>
                          {formatUsd(r.costUsd)}
                          {r.priced === "fallback" && (
                            <span
                              className="muted"
                              title="Model not in the price table, so priced at the highest rate"
                            >
                              {" "}
                              (estimate)
                            </span>
                          )}
                        </td>
                        <td>
                          {r.outcome === "complete"
                            ? "Done"
                            : r.outcome === "aborted"
                              ? "Cut off"
                              : `Error ${r.status}`}
                        </td>
                        <td>
                          {admin && r.logged && (
                            <Link
                              to={`/logs?agent=${encodeURIComponent(r.agentId)}&call=${encodeURIComponent(r.id)}`}
                              aria-label={`View the call at ${formatDateTime(r.at)}`}
                            >
                              View
                            </Link>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </aside>
  );
}

function useRefreshAgents() {
  const queryClient = useQueryClient();
  return (agent?: Agent) => {
    if (agent) queryClient.setQueryData(["agent", agent.id], agent);
    void queryClient.invalidateQueries();
  };
}

function StopControls({ agent }: { agent: Agent }) {
  const agentApi = useAgentApi();
  const canRaise = agentApi.canRaise(agent);
  const refresh = useRefreshAgents();
  const [message, setMessage] = useState<string | null>(null);
  const [raising, setRaising] = useState(false);
  const kill = useMutation({
    mutationFn: () => agentApi.kill(agent.id),
    onSuccess: (r) => {
      setMessage(
        `Stopped in ${Math.round(r.elapsedMs)} ms. ${
          r.abortedRequests === 0
            ? "Nothing was running."
            : `Cut ${r.abortedRequests} ${r.abortedRequests === 1 ? "request" : "requests"} that ${r.abortedRequests === 1 ? "was" : "were"} still running.`
        }`,
      );
      refresh(r.agent);
    },
  });
  const resume = useMutation({
    mutationFn: () => agentApi.resume(agent.id),
    onSuccess: (r) => {
      setMessage("Running again.");
      refresh(r.agent);
    },
  });
  const paused = agent.status === "paused";
  const atLimit = agent.state === "at_limit";
  return (
    <div className="stack">
      <div className="row between">
        <StateBadge state={agent.state} />
        <span className="row">
          {(atLimit ||
            agent.limits.dailyUsd !== undefined ||
            agent.limits.monthlyUsd !== undefined) &&
            !paused && (
              <button
                type="button"
                className={atLimit ? "button" : "button button-soft"}
                onClick={() => setRaising(true)}
              >
                {canRaise ? "Raise limit once" : "Ask for more budget"}
              </button>
            )}
          {paused ? (
            <button
              type="button"
              className="button"
              disabled={resume.isPending}
              onClick={() => resume.mutate()}
            >
              Turn on
            </button>
          ) : (
            <button
              type="button"
              className="button button-dark"
              disabled={kill.isPending}
              onClick={() => kill.mutate()}
            >
              Stop
            </button>
          )}
        </span>
      </div>
      {atLimit && !message && (
        <p className="note note-warn" role="status">
          {agent.name} hit its spending limit, so Purser is refusing its calls.
          {canRaise
            ? " Raise the limit once to let it finish today's work, or wait for the limit to reset at midnight UTC."
            : " Ask your manager for more budget, or wait for the limit to reset at midnight UTC."}
        </p>
      )}
      {raising && (
        <RaiseLimitDialog
          agent={agent}
          onClose={() => setRaising(false)}
          onDone={(updated, text) => {
            setRaising(false);
            setMessage(text);
            refresh(updated);
          }}
        />
      )}
      {message && (
        <p className="note note-info" role="status">
          {message}
        </p>
      )}
      <ErrorNote error={kill.error ?? resume.error} />
    </div>
  );
}

/** Whether this agent's request and response bodies are kept. */
function CallLogging({ agent }: { agent: Agent }) {
  const refresh = useRefreshAgents();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const toggle = useMutation({
    mutationFn: (on: boolean) => api.updateAgent(agent.id, { logCalls: on }),
    onSuccess: (updated) => refresh(updated),
  });
  if (!settings.data) return null;
  const { mode, retentionDays } = settings.data.logging;
  return (
    <section className="stack" aria-labelledby="calllog-h">
      <h3 id="calllog-h">Call log</h3>
      {mode === "off" && (
        <p className="muted">
          Purser keeps costs and token counts for every call, but not what was
          said. To keep requests and responses too, turn on the call log in{" "}
          <Link to="/settings">Settings</Link>.
        </p>
      )}
      {mode === "all" && (
        <p className="muted">
          Every agent's requests and responses are kept for {retentionDays}{" "}
          days.{" "}
          <Link to={`/logs?agent=${encodeURIComponent(agent.id)}`}>
            See this agent's calls
          </Link>
          .
        </p>
      )}
      {mode === "selected" && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={agent.logCalls === true}
              disabled={toggle.isPending}
              onChange={(e) => toggle.mutate(e.target.checked)}
            />
            Keep this agent's requests and responses for {retentionDays} days
          </label>
          <ErrorNote error={toggle.error} />
        </>
      )}
    </section>
  );
}

function Facts({
  agent,
  connectors,
}: {
  agent: Agent;
  connectors: Connector[];
}) {
  const names = (agent.providers ?? []).map(
    (id) => connectors.find((c) => c.id === id)?.name ?? id,
  );
  return (
    <dl className="facts">
      <div>
        <dt>Today</dt>
        <dd>
          <SpendBar spent={agent.spend.today} limit={capNow(agent, "day")} />
          {agent.raised?.dailyUsd !== undefined && (
            <span className="muted small block">
              Includes a one-time {formatUsd(agent.raised.dailyUsd)} for today
            </span>
          )}
        </dd>
      </div>
      <div>
        <dt>This month</dt>
        <dd>
          {formatUsd(agent.spend.month)}
          {agent.limits.monthlyUsd !== undefined && (
            <span className="muted">
              {" "}
              of {formatUsd(capNow(agent, "month") ?? 0)}
            </span>
          )}
          {agent.raised?.monthlyUsd !== undefined && (
            <span className="muted small">
              {" "}
              (includes a one-time {formatUsd(agent.raised.monthlyUsd)})
            </span>
          )}
        </dd>
      </div>
      <div>
        <dt>Owner</dt>
        <dd>{agent.owner}</dd>
      </div>
      <div>
        <dt>Department</dt>
        <dd>{agent.team ?? "None"}</dd>
      </div>
      {agent.purpose && (
        <div>
          <dt>What it does</dt>
          <dd>{agent.purpose}</dd>
        </div>
      )}
      <div>
        <dt>Providers</dt>
        <dd>{names.length ? names.join(", ") : "Any connected provider"}</dd>
      </div>
      <div>
        <dt>Models, unless a service says otherwise</dt>
        <dd>
          {agent.limits.models?.length ? agent.limits.models.join(", ") : "Any"}
        </dd>
      </div>
      <div>
        <dt>Key</dt>
        <dd className="mono">{agent.keyHint}</dd>
      </div>
      <div>
        <dt>Key expires</dt>
        <dd>
          <KeyExpiry expiresAt={agent.keyExpiresAt} state={agent.keyState} />
        </dd>
      </div>
      <div>
        <dt>Rotation</dt>
        <dd>{rotationLabel(agent.rotation)}</dd>
      </div>
      <div>
        <dt>Last used</dt>
        <dd>{formatRelative(agent.lastUsedAt)}</dd>
      </div>
      <div>
        <dt>Added</dt>
        <dd>{formatDateTime(agent.createdAt)}</dd>
      </div>
      {agent.endsAt && (
        <div>
          <dt>Switches off</dt>
          <dd>{formatDateTime(agent.endsAt)}</dd>
        </div>
      )}
      {agent.pausedAt && (
        <div>
          <dt>Stopped</dt>
          <dd>
            {formatDateTime(agent.pausedAt)}
            {agent.pausedBy ? ` by ${agent.pausedBy}` : ""}
          </dd>
        </div>
      )}
    </dl>
  );
}

function RotateKey({
  agent,
  connectors,
}: {
  agent: Agent;
  connectors: Connector[];
}) {
  const agentApi = useAgentApi();
  const refresh = useRefreshAgents();
  const collecting = agent.awaitingKey === true;
  // Remembered past the rotation, which clears awaitingKey.
  const [firstKey, setFirstKey] = useState(false);
  const [open, setOpen] = useState(false);
  const policyGrace = (agent.rotation?.graceDays ?? 0) * 1440;
  const [grace, setGrace] = useState(policyGrace);
  const [result, setResult] = useState<RotateResult | null>(null);
  const rotate = useMutation({
    mutationFn: () => agentApi.rotateKey(agent.id, collecting ? 0 : grace),
    onSuccess: (r) => {
      setFirstKey(collecting);
      setResult(r);
      setOpen(false);
      refresh(r.agent);
    },
  });

  return (
    <section className="stack" aria-labelledby="rotate-h">
      <h3 id="rotate-h">Key</h3>
      {result ? (
        <>
          <KeyReveal name={agent.name} agentKey={result.key} />
          {agentApi.scope === "me" &&
            connectors
              .filter(
                (c) =>
                  c.configured &&
                  (!agent.providers?.length || agent.providers.includes(c.id)),
              )
              .map((c) => (
                <section key={c.id} className="stack">
                  <h4>Connect through {c.name}</h4>
                  <ConnectionValues connector={c} agentKey={result.key} />
                </section>
              ))}
          <section className="stack">
            <h4>Connect over MCP</h4>
            <ConnectAgent agentKey={result.key} />
          </section>
          <p className="muted">
            {result.previousKeyValidUntil
              ? `The old key works until ${formatDateTime(result.previousKeyValidUntil)}. `
              : firstKey
                ? ""
                : "The old key has stopped working. "}
            {result.agent.keyExpiresAt
              ? `The new key expires on ${formatDateTime(result.agent.keyExpiresAt)}.`
              : "The new key doesn't expire."}
          </p>
          <div>
            <button
              type="button"
              className="button button-ghost"
              onClick={() => setResult(null)}
            >
              I've saved it
            </button>
          </div>
        </>
      ) : open ? (
        <form
          className="stack"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            rotate.mutate();
          }}
        >
          <GracePicker
            value={grace}
            onChange={setGrace}
            policyGraceDays={agent.rotation?.graceDays}
          />
          {agent.rotation && (
            <p className="hint">
              The new key will expire {agent.rotation.everyDays} days from now,
              following this agent's rotation schedule.
            </p>
          )}
          <ErrorNote error={rotate.error} />
          <div className="row">
            <button
              type="submit"
              className="button"
              disabled={rotate.isPending}
            >
              {rotate.isPending ? "Rotating…" : "Make a new key"}
            </button>
            <button
              type="button"
              className="button button-ghost"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : collecting ? (
        <div className="stack">
          <p className="note note-info">
            {agent.keyRotatedAt
              ? `The key for ${agent.name} was replaced. Get the new one and put it in your tool. You will see it once.`
              : `${agent.name} was approved. Get its key to connect your tool. You will see the key once.`}
            {agent.previousKeyValidUntil
              ? ` The old key works until ${formatDateTime(agent.previousKeyValidUntil)}.`
              : ""}
          </p>
          <ErrorNote error={rotate.error} />
          <div>
            <button
              type="button"
              className="button"
              disabled={rotate.isPending}
              onClick={() => rotate.mutate()}
            >
              {rotate.isPending ? "Making the key…" : "Get your key"}
            </button>
          </div>
        </div>
      ) : (
        <div className="stack">
          {agent.previousKeyValidUntil && (
            <p className="muted">
              The previous key still works until{" "}
              {formatDateTime(agent.previousKeyValidUntil)}.
            </p>
          )}
          <div>
            <button
              type="button"
              className="button button-soft"
              onClick={() => {
                setGrace(policyGrace);
                setOpen(true);
              }}
            >
              Rotate key
            </button>
          </div>
          <details className="edit">
            <summary>Connect this agent over MCP</summary>
            <ConnectAgent />
          </details>
        </div>
      )}
    </section>
  );
}

function money(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function EditAgent({
  agent,
  connectors,
}: {
  agent: Agent;
  connectors: Connector[];
}) {
  const refresh = useRefreshAgents();
  const configured = connectors.filter(
    (c) => c.configured || agent.providers?.includes(c.id),
  );
  const [owner, setOwner] = useState(agent.owner);
  const [ownerEmail, setOwnerEmail] = useState(agent.ownerEmail ?? "");
  const [team, setTeam] = useState(agent.team ?? "");
  const [purpose, setPurpose] = useState(agent.purpose ?? "");
  const [endsAt, setEndsAt] = useState(
    agent.endsAt ? agent.endsAt.slice(0, 10) : "",
  );
  const [daily, setDaily] = useState(money(agent.limits.dailyUsd));
  const [monthly, setMonthly] = useState(money(agent.limits.monthlyUsd));
  const [models, setModels] = useState((agent.limits.models ?? []).join(", "));
  const [providers, setProviders] = useState<string[]>(agent.providers ?? []);
  const [keyPolicy, setKeyPolicy] = useState(policyFromAgent(agent));
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: (patch: AgentPatch) => api.updateAgent(agent.id, patch),
    onSuccess: (updated) => {
      setSaved(true);
      refresh(updated);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    const dailyUsd = parseMoney(daily);
    const monthlyUsd = parseMoney(monthly);
    const modelList = models
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    const rotation = rotationFromPolicy(keyPolicy);
    // With a schedule and no date, the first expiry is one period from now.
    const keyExpiresAt =
      expiryFromPolicy(keyPolicy) ??
      (rotation
        ? new Date(Date.now() + rotation.everyDays * 86_400_000).toISOString()
        : null);
    const email = ownerEmail.trim().toLowerCase();
    save.mutate({
      owner: owner.trim(),
      ...(email !== (agent.ownerEmail ?? "")
        ? { ownerEmail: email || null }
        : {}),
      team: team.trim(),
      purpose: purpose.trim(),
      providers,
      endsAt: endsAt ? new Date(`${endsAt}T23:59:59Z`).toISOString() : null,
      keyExpiresAt,
      rotation: rotation ?? null,
      limits: {
        ...(dailyUsd !== undefined ? { dailyUsd } : {}),
        ...(monthlyUsd !== undefined ? { monthlyUsd } : {}),
        models: modelList,
      },
    });
  }

  return (
    <details className="edit">
      <summary>Edit details and limits</summary>
      <form className="stack" onSubmit={submit}>
        <div className="grid-2">
          <label className="field">
            <span>Owner</span>
            <input
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>Owner's company email</span>
            <input
              type="email"
              value={ownerEmail}
              onChange={(e) => setOwnerEmail(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Department</span>
            <input value={team} onChange={(e) => setTeam(e.target.value)} />
          </label>
          <label className="field span-2">
            <span>What it does</span>
            <input
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Daily limit</span>
            <input
              inputMode="decimal"
              value={daily}
              onChange={(e) => setDaily(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Monthly limit</span>
            <input
              inputMode="decimal"
              value={monthly}
              onChange={(e) => setMonthly(e.target.value)}
            />
          </label>
          <label className="field span-2">
            <span>Allowed models, separated by commas (empty means any)</span>
            <input
              value={models}
              onChange={(e) => setModels(e.target.value)}
              className="mono"
            />
          </label>
          <label className="field">
            <span>Switch it off on</span>
            <input
              type="date"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
            />
          </label>
        </div>
        <KeyPolicyFields value={keyPolicy} onChange={setKeyPolicy} />
        {configured.length > 0 && (
          <fieldset className="checks">
            <legend>Allowed providers (none ticked means any)</legend>
            {configured.map((c) => (
              <label key={c.id} className="check">
                <input
                  type="checkbox"
                  checked={providers.includes(c.id)}
                  onChange={(e) =>
                    setProviders((list) =>
                      e.target.checked
                        ? [...list, c.id]
                        : list.filter((id) => id !== c.id),
                    )
                  }
                />
                {c.name}
              </label>
            ))}
          </fieldset>
        )}
        <ErrorNote error={save.error} />
        {saved && (
          <p className="note note-ok" role="status">
            Saved.
          </p>
        )}
        <div className="row end">
          <button type="submit" className="button" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </details>
  );
}
