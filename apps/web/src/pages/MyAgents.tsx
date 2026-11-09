import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { meApi } from "../api/client";
import type { Light } from "../api/types";
import { AskAgentDialog } from "../components/AskAgent";
import { KeyExpiry } from "../components/KeyExpiry";
import { ErrorNote, Loading } from "../components/Notice";
import { capNow } from "../components/RaiseLimit";
import { SpendBar } from "../components/SpendBar";
import { StateBadge } from "../components/StateBadge";
import { StatusLight } from "../components/StatusLight";
import { AgentApiProvider, meAgentApi, useViewer } from "../lib/agentApi";
import { formatNumber, formatRelative, formatUsd } from "../lib/format";
import { useDebounced } from "../lib/hooks";
import { AgentDetail } from "./AgentDetail";

const LIGHTS: Light[] = ["green", "yellow", "red"];
const PAGE_SIZE = 50;

/**
 * The agents page for employees and managers: your own agents, or for a
 * manager, every agent in the departments you manage.
 */
export function MyAgentsPage() {
  const viewer = useViewer();
  const isManager = viewer?.role === "manager";
  const [params, setParams] = useSearchParams();
  const scope: "team" | "mine" =
    isManager && params.get("scope") !== "mine" ? "team" : "mine";
  const light = params.get("light");
  const awaiting = params.get("awaiting") === "1";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const selected = params.get("agent");
  const q = params.get("q") ?? "";
  const [search, setSearch] = useState(q);
  const debounced = useDebounced(search, 300);
  const [asking, setAsking] = useState(false);

  const set = (changes: Record<string, string | null>, keepPage = false) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [k, v] of Object.entries(changes)) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        if (!keepPage) next.delete("page");
        return next;
      },
      { replace: true },
    );

  useEffect(() => {
    if (debounced !== q) set({ q: debounced || null });
    // Keyed on the debounced text alone, as on the admin agents page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const me = useQuery({ queryKey: ["me"], queryFn: meApi.me });
  const query = useMemo(
    () => ({
      scope,
      ...(q ? { q } : {}),
      ...(light && (LIGHTS as string[]).includes(light)
        ? { light: light as Light }
        : {}),
      ...(awaiting ? { awaitingKey: "1" as const } : {}),
      page,
      pageSize: PAGE_SIZE,
    }),
    [scope, q, light, awaiting, page],
  );
  const list = useQuery({
    queryKey: ["my-agents", query],
    queryFn: () => meApi.agents(query),
    placeholderData: keepPreviousData,
  });
  const agentApi = useMemo(() => meAgentApi(viewer), [viewer]);
  const data = list.data;
  const items = data?.items ?? [];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const team = scope === "team";

  return (
    <AgentApiProvider value={agentApi}>
      <div className="page">
        <header className="page-head">
          <div>
            <h1>{team ? "Agents" : "My agents"}</h1>
            <p className="muted">
              {team
                ? `In ${(viewer?.manages ?? []).join(", ") || "your departments"}`
                : "Agents you own. Each has its own key and spending limit."}
            </p>
          </div>
          {me.data?.selfService && viewer?.kind === "person" && (
            <button
              type="button"
              className="button"
              onClick={() => setAsking(true)}
            >
              Ask for an agent
            </button>
          )}
        </header>

        {(me.data?.keysWaiting ?? 0) > 0 && (
          <p className="note note-warn" role="status">
            {me.data?.keysWaiting === 1
              ? "One of your agents has a new key waiting. Its old key is being replaced, so get the new one and put it in your tool."
              : `${formatNumber(me.data?.keysWaiting ?? 0)} of your agents have new keys waiting. Their old keys are being replaced, so get the new ones and put them in your tools.`}{" "}
            <button
              type="button"
              className="link-button"
              onClick={() =>
                set({ awaiting: awaiting ? null : "1", scope: "mine" })
              }
            >
              {awaiting ? "Show all" : "Show them"}
            </button>
          </p>
        )}

        <div className="filters" role="search">
          {isManager && (
            <div className="segmented" role="group" aria-label="Show">
              <button
                type="button"
                aria-pressed={team}
                onClick={() => set({ scope: null })}
              >
                My departments
              </button>
              <button
                type="button"
                aria-pressed={!team}
                onClick={() => set({ scope: "mine" })}
              >
                Mine
              </button>
            </div>
          )}
          <label className="field grow">
            <span>Search</span>
            <input
              type="search"
              value={search}
              placeholder={
                team
                  ? "Name, owner, department or provider"
                  : "Name or provider"
              }
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Status</span>
            <select
              value={light ?? ""}
              onChange={(e) => set({ light: e.target.value || null })}
            >
              <option value="">Any</option>
              <option value="green">Green: running</option>
              <option value="yellow">Yellow: at limit</option>
              <option value="red">Red: stopped</option>
            </select>
          </label>
        </div>

        <div className="card flush">
          {list.isPending ? (
            <Loading label="Loading agents" />
          ) : list.isError ? (
            <ErrorNote error={list.error} />
          ) : items.length === 0 ? (
            <p className="empty">
              {q || light || awaiting
                ? "No agents match."
                : team
                  ? "No agents in your departments yet."
                  : "You don't have any agents yet. Ask for one to get its own key and limit."}
            </p>
          ) : (
            <div className="table-wrap">
              <table className="table agents-table" aria-busy={list.isFetching}>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    {team && <th scope="col">Owner</th>}
                    {team && <th scope="col">Department</th>}
                    <th scope="col">Today</th>
                    <th scope="col">This month</th>
                    <th scope="col">Last used</th>
                    <th scope="col">Key expires</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((agent) => (
                    <tr
                      key={agent.id}
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest("button,a")) {
                          return;
                        }
                        set({ agent: agent.id }, true);
                      }}
                    >
                      <td>
                        <span className="name-cell">
                          <StatusLight state={agent.state} />
                          <button
                            type="button"
                            className="link-button strong"
                            onClick={() => set({ agent: agent.id }, true)}
                          >
                            {agent.name}
                          </button>
                          {agent.awaitingKey && (
                            <span className="badge badge-plain">
                              Key waiting
                            </span>
                          )}
                        </span>
                      </td>
                      {team && <td>{agent.owner}</td>}
                      {team && <td>{agent.team ?? ""}</td>}
                      <td>
                        <SpendBar
                          spent={agent.spend.today}
                          limit={capNow(agent, "day")}
                        />
                      </td>
                      <td>{formatUsd(agent.spend.month)}</td>
                      <td>{formatRelative(agent.lastUsedAt)}</td>
                      <td>
                        <KeyExpiry
                          expiresAt={agent.keyExpiresAt}
                          state={agent.keyState}
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
        </div>

        {data && data.total > data.pageSize && (
          <nav className="pager" aria-label="Pages">
            <span className="muted">{formatNumber(data.total)} agents</span>
            <button
              type="button"
              className="button button-ghost"
              disabled={page <= 1}
              onClick={() => set({ page: String(page - 1) }, true)}
            >
              Previous
            </button>
            <span>
              Page {page} of {pages}
            </span>
            <button
              type="button"
              className="button button-ghost"
              disabled={page >= pages}
              onClick={() => set({ page: String(page + 1) }, true)}
            >
              Next
            </button>
          </nav>
        )}

        {selected && (
          <AgentDetail
            agentRef={selected}
            connectors={me.data?.providers ?? []}
            onClose={() => set({ agent: null }, true)}
          />
        )}
        {asking && me.data && (
          <AskAgentDialog me={me.data} onClose={() => setAsking(false)} />
        )}
      </div>
    </AgentApiProvider>
  );
}
