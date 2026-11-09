import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, meApi } from "../api/client";
import type { KillAllResult } from "../api/types";
import { Dialog } from "../components/Dialog";
import { ErrorNote, Loading } from "../components/Notice";
import { SpendBar } from "../components/SpendBar";
import { StateBadge } from "../components/StateBadge";
import {
  eventLabel,
  eventSummary,
  formatDateTime,
  formatNumber,
  formatUsd,
} from "../lib/format";
import { Setup } from "./Setup";

export function HomePage() {
  const overview = useQuery({ queryKey: ["overview"], queryFn: api.overview });
  // Decided once, so finishing a step doesn't swap the page mid-setup.
  const [setup, setSetup] = useState<boolean | null>(null);

  if (overview.isPending) return <Loading />;
  if (overview.isError) return <ErrorNote error={overview.error} />;

  const data = overview.data;
  const fresh = data.providers.configured === 0 && data.agents.total === 0;
  if (setup === null && fresh) {
    setSetup(true);
  }
  if (setup ?? fresh) return <Setup onDone={() => setSetup(false)} />;

  return <Overview />;
}

function Overview() {
  const queryClient = useQueryClient();
  const overview = useQuery({ queryKey: ["overview"], queryFn: api.overview });
  const me = useQuery({ queryKey: ["me"], queryFn: meApi.me });
  const [confirming, setConfirming] = useState(false);

  if (!overview.data) return null;
  const waiting = me.data?.pending.toDecide ?? 0;
  const { spend, requests, agents, topToday, recentEvents } = overview.data;
  const keys = overview.data.keys ?? { expiring: 0, expired: 0 };
  const stoppable = agents.total - agents.paused;
  const dueKeys = keys.expiring + keys.expired;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Home</h1>
          <p className="muted">Spending since midnight UTC and this month.</p>
        </div>
        <button
          type="button"
          className="button button-dark"
          onClick={() => setConfirming(true)}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <rect x="5" y="5" width="14" height="14" rx="2" className="fill" />
          </svg>
          Stop everything
        </button>
      </header>

      <section className="tiles" aria-label="Summary">
        <Tile label="Spent today" value={formatUsd(spend.today)} />
        <Tile label="This month" value={formatUsd(spend.month)} />
        <Tile label="Requests today" value={formatNumber(requests.today)} />
        <Tile
          label="Agents"
          value={`${formatNumber(agents.running)} running`}
          sub={`${formatNumber(agents.total - agents.running)} not running · ${formatNumber(agents.total)} in all`}
        />
        <Link
          to={
            keys.expired > 0
              ? "/agents?keyState=expired"
              : "/agents?keyState=expiring&sort=key_expires&dir=asc"
          }
          className={
            keys.expired > 0 ? "tile tile-link tile-alert" : "tile tile-link"
          }
        >
          <div className="tile-label">Keys expiring in 14 days</div>
          <div className="tile-value">{formatNumber(keys.expiring)}</div>
          <div className="tile-sub">
            {formatNumber(keys.expired)} already expired
          </div>
        </Link>
        {waiting > 0 && (
          <Link to="/approvals" className="tile tile-link tile-alert">
            <div className="tile-label">Waiting for approval</div>
            <div className="tile-value">{formatNumber(waiting)}</div>
            <div className="tile-sub">New agents and extra budget</div>
          </Link>
        )}
      </section>

      {dueKeys > 0 && (
        <div className="callout" role="status">
          <p>
            <strong>
              {formatNumber(dueKeys)}{" "}
              {dueKeys === 1 ? "key needs" : "keys need"} rotating.
            </strong>{" "}
            Open them in Agents, select all on the page and choose Rotate keys.
            Each agent's old key keeps working for its grace period.
          </p>
          <div className="row">
            {keys.expired > 0 && (
              <Link
                className="button button-dark"
                to="/agents?keyState=expired"
              >
                Rotate expired keys
              </Link>
            )}
            {keys.expiring > 0 && (
              <Link
                className="button button-soft"
                to="/agents?keyState=expiring&sort=key_expires&dir=asc"
              >
                Rotate expiring keys
              </Link>
            )}
          </div>
        </div>
      )}

      <div className="columns">
        <section className="card grow" aria-labelledby="top-h">
          <div className="card-head">
            <h2 id="top-h">Top spenders today</h2>
            <Link to="/agents?sort=spend_today&dir=desc">See all agents</Link>
          </div>
          {topToday.length === 0 ? (
            <p className="muted">No spending yet today.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Agent</th>
                    <th scope="col">Today</th>
                    <th scope="col">State</th>
                  </tr>
                </thead>
                <tbody>
                  {topToday.map((agent) => (
                    <tr key={agent.id}>
                      <td>
                        <Link
                          to={`/agents?agent=${encodeURIComponent(agent.id)}`}
                        >
                          {agent.name}
                        </Link>
                        <div className="muted small">
                          {agent.owner}
                          {agent.team ? ` · ${agent.team}` : ""}
                        </div>
                      </td>
                      <td>
                        <SpendBar
                          spent={agent.spend.today}
                          limit={agent.limits.dailyUsd}
                        />
                      </td>
                      <td>
                        <StateBadge state={agent.state} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="card side" aria-labelledby="events-h">
          <div className="card-head">
            <h2 id="events-h">Recent events</h2>
            <Link to="/activity">All activity</Link>
          </div>
          {recentEvents.length === 0 ? (
            <p className="muted">Nothing has happened yet.</p>
          ) : (
            <ul className="events">
              {recentEvents.map((event, i) => (
                <li key={`${event.at}-${i}`}>
                  <span className="event-type">{eventLabel(event.type)}</span>
                  <span className="muted small">
                    {formatDateTime(event.at)}
                    {event.detail ? ` · ${eventSummary(event.detail)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {confirming && (
        <StopEverything
          count={stoppable}
          onClose={() => setConfirming(false)}
          onDone={() => queryClient.invalidateQueries()}
        />
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}

export function StopEverything({
  count,
  onClose,
  onDone,
}: {
  count: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [result, setResult] = useState<KillAllResult | null>(null);
  const stop = useMutation({
    mutationFn: api.killAll,
    onSuccess: (data) => {
      setResult(data);
      onDone();
    },
  });

  return (
    <Dialog title="Stop everything" onClose={onClose}>
      {result ? (
        <div className="stack" role="status">
          <p className="big">
            Stopped {formatNumber(result.paused)}{" "}
            {result.paused === 1 ? "agent" : "agents"} in{" "}
            {Math.round(result.elapsedMs)} ms.
          </p>
          <p>
            {result.abortedRequests === 0
              ? "Nothing was running at the time."
              : `Cut ${formatNumber(result.abortedRequests)} ${result.abortedRequests === 1 ? "request" : "requests"} that ${result.abortedRequests === 1 ? "was" : "were"} still running.`}
          </p>
          <p className="muted">
            Each agent stays stopped until you turn it back on.
          </p>
          <div className="row end">
            <button type="button" className="button" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed === "STOP") stop.mutate();
          }}
        >
          <p>
            This stops{" "}
            <strong>
              {formatNumber(count)} {count === 1 ? "agent" : "agents"}
            </strong>{" "}
            straight away and cuts any request they have open. Their keys stop
            working until you turn them back on.
          </p>
          <label className="field">
            <span>
              Type <strong>STOP</strong> to confirm
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
            />
          </label>
          <ErrorNote error={stop.error} />
          <div className="row end">
            <button
              type="button"
              className="button button-ghost"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="button button-dark"
              disabled={typed !== "STOP" || stop.isPending}
            >
              {stop.isPending ? "Stopping…" : "Stop everything"}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
