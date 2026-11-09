import { useEffect, useId, useMemo, useState } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { api } from "../api/client";
import type {
  AgentQuery,
  AgentState,
  BulkResult,
  Connector,
  CreatedAgent,
  KeyState,
  Light,
  SearchField,
  SortKey,
  StateFilter,
} from "../api/types";
import { AgentForm } from "../components/AgentForm";
import { ConnectionValues } from "../components/ConnectionValues";
import { Dialog } from "../components/Dialog";
import { GracePicker, USE_POLICY } from "../components/GracePicker";
import { KeyExpiry } from "../components/KeyExpiry";
import { KeyReveal } from "../components/KeyReveal";
import { ErrorNote, Loading } from "../components/Notice";
import { capNow } from "../components/RaiseLimit";
import { SpendBar } from "../components/SpendBar";
import { StateBadge } from "../components/StateBadge";
import { StatusLight } from "../components/StatusLight";
import { CopyButton } from "../components/CopyButton";
import { downloadText, toCsv } from "../lib/csv";
import {
  formatNumber,
  formatRelative,
  formatUsd,
  KEY_STATE_LABELS,
  STATE_LABELS,
} from "../lib/format";
import { useDebounced } from "../lib/hooks";
import { AgentDetail } from "./AgentDetail";

const PAGE_SIZES = [50, 100, 200];
const STATES = Object.keys(STATE_LABELS) as AgentState[];
const STATE_FILTERS: StateFilter[] = [...STATES, "not_running"];
const LIGHTS: Light[] = ["green", "yellow", "red"];
/** The search box can look everywhere, or in one field. */
const SEARCH_FIELDS: { value: SearchField; label: string }[] = [
  { value: "all", label: "Everything" },
  { value: "name", label: "Name" },
  { value: "owner", label: "Owner" },
  { value: "team", label: "Department" },
  { value: "provider", label: "Provider" },
];
const SEARCH_PLACEHOLDERS: Record<SearchField, string> = {
  all: "Name, owner, department or provider",
  name: "Agent name",
  owner: "Owner's name",
  team: "Department",
  provider: "Provider, such as OpenRouter",
};
const KEY_STATES = Object.keys(KEY_STATE_LABELS) as KeyState[];
const KEY_FILTER_LABELS: Record<KeyState, string> = {
  ok: "Current",
  expiring: "Expiring within 14 days",
  expired: "Expired",
};
const SORTS: SortKey[] = [
  "name",
  "spend_today",
  "spend_month",
  "created",
  "last_used",
  "key_expires",
];

/** Reads the agent list query from the page address. */
export function queryFromParams(params: URLSearchParams): AgentQuery {
  const query: AgentQuery = {};
  const q = params.get("q");
  if (q) query.q = q;
  const field = params.get("in");
  if (
    field &&
    field !== "all" &&
    SEARCH_FIELDS.some((f) => f.value === field)
  ) {
    query.in = field as SearchField;
  }
  const state = params.get("state");
  if (state && (STATE_FILTERS as string[]).includes(state)) {
    query.state = state as StateFilter;
  }
  const light = params.get("light");
  if (light && (LIGHTS as string[]).includes(light)) {
    query.light = light as Light;
  }
  const keyState = params.get("keyState");
  if (keyState && (KEY_STATES as string[]).includes(keyState)) {
    query.keyState = keyState as KeyState;
  }
  for (const key of ["provider", "owner", "team"] as const) {
    const value = params.get(key);
    if (value) query[key] = value;
  }
  if (params.get("awaiting") === "1") query.awaitingKey = "1";
  const sort = params.get("sort");
  if (sort && (SORTS as string[]).includes(sort)) query.sort = sort as SortKey;
  const dir = params.get("dir");
  if (dir === "asc" || dir === "desc") query.dir = dir;
  const page = Number(params.get("page"));
  query.page = Number.isInteger(page) && page > 0 ? page : 1;
  const size = Number(params.get("pageSize"));
  query.pageSize = PAGE_SIZES.includes(size) ? size : 50;
  return query;
}

/** Names and soonest expiry read best from the top; money and dates from the most. */
const ascFirst = (key: SortKey) => key === "name" || key === "key_expires";

type BulkStep =
  | { kind: "rotate-choose" }
  | {
      kind: "result";
      action: "kill" | "resume" | "rotate-key";
      result: BulkResult;
    };

export function AgentsPage() {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const query = useMemo(() => queryFromParams(params), [params]);
  const selectedAgent = params.get("agent");

  const [search, setSearch] = useState(query.q ?? "");
  const debounced = useDebounced(search, 300);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [bulkStep, setBulkStep] = useState<BulkStep | null>(null);
  const [grace, setGrace] = useState(USE_POLICY);

  const list = useQuery({
    queryKey: ["agents", query],
    queryFn: () => api.agents(query),
    placeholderData: keepPreviousData,
  });
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: api.providers,
  });

  /** Changes some address parameters. Filters send you back to page 1. */
  function update(
    changes: Record<string, string | undefined>,
    keepPage = false,
  ) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(changes)) {
          if (value === undefined || value === "") next.delete(key);
          else next.set(key, value);
        }
        if (!keepPage) next.delete("page");
        return next;
      },
      { replace: true },
    );
  }

  useEffect(() => {
    // Only the debounced text should trigger this.
    if ((debounced || undefined) !== query.q) update({ q: debounced });
    // Deliberately keyed on the debounced text alone: re-running when the address
    // changes (Back, Clear filters) would write stale search text back into it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  // A new page or new filters means a new set of rows: clear the selection.
  const listKey = JSON.stringify({ ...query });
  useEffect(() => setSelection(new Set()), [listKey]);

  const bulk = useMutation({
    mutationFn: (vars: {
      action: "kill" | "resume" | "rotate-key";
      graceMinutes?: number;
    }) =>
      api.bulk(
        vars.action,
        [...selection],
        vars.graceMinutes === USE_POLICY ? undefined : vars.graceMinutes,
      ),
    onSuccess: (result, vars) => {
      setBulkStep({ kind: "result", action: vars.action, result });
      setSelection(new Set());
      void queryClient.invalidateQueries();
    },
  });

  const data = list.data;
  const items = data?.items ?? [];
  const totalPages = data
    ? Math.max(1, Math.ceil(data.total / data.pageSize))
    : 1;
  const allOnPage = items.length > 0 && items.every((a) => selection.has(a.id));
  const someOnPage = items.some((a) => selection.has(a.id));

  function toggle(id: string) {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function sortBy(key: SortKey) {
    const same = (query.sort ?? "name") === key;
    const dir = same
      ? (query.dir ?? (ascFirst(key) ? "asc" : "desc")) === "asc"
        ? "desc"
        : "asc"
      : ascFirst(key)
        ? "asc"
        : "desc";
    update({ sort: key, dir }, true);
  }

  function ariaSort(key: SortKey): "ascending" | "descending" | "none" {
    if ((query.sort ?? "name") !== key) return "none";
    const dir = query.dir ?? (ascFirst(key) ? "asc" : "desc");
    return dir === "asc" ? "ascending" : "descending";
  }

  const facets = data?.facets ?? { owners: [], teams: [], providers: [] };
  const connectorName = (id: string) =>
    providers.data?.find((c) => c.id === id)?.name ?? id;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Agents</h1>
          <p className="muted">
            {data
              ? `${formatNumber(data.total)} ${data.total === 1 ? "agent" : "agents"}`
              : " "}
          </p>
        </div>
        <button
          type="button"
          className="button"
          onClick={() => setAdding(true)}
        >
          Add agent
        </button>
      </header>

      {query.awaitingKey && (
        <p className="note note-info" role="status">
          Showing agents whose owners still have a new key to collect.{" "}
          <button
            type="button"
            className="link-button"
            onClick={() => update({ awaiting: undefined })}
          >
            Show all
          </button>
        </p>
      )}
      <div className="filters" role="search">
        <div className="search-group grow">
          <label className="field">
            <span>Search in</span>
            <select
              value={query.in ?? "all"}
              onChange={(e) =>
                update({ in: e.target.value === "all" ? "" : e.target.value })
              }
            >
              {SEARCH_FIELDS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field grow">
            <span>Search</span>
            <input
              type="search"
              value={search}
              placeholder={SEARCH_PLACEHOLDERS[query.in ?? "all"]}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </div>
        <label className="field">
          <span>Status</span>
          <select
            value={query.light ?? query.state ?? ""}
            onChange={(e) => {
              const value = e.target.value;
              const isLight = (LIGHTS as string[]).includes(value);
              update({
                light: isLight ? value : "",
                state: isLight ? "" : value,
              });
            }}
          >
            <option value="">Any</option>
            <option value="green">Green: running</option>
            <option value="yellow">Yellow: at limit</option>
            <option value="red">Red: stopped</option>
            <option value="not_running">Yellow or red</option>
            <optgroup label="Red because">
              {STATES.filter((s) => s !== "running" && s !== "at_limit").map(
                (s) => (
                  <option key={s} value={s}>
                    {STATE_LABELS[s]}
                  </option>
                ),
              )}
            </optgroup>
          </select>
        </label>
        <label className="field">
          <span>Key</span>
          <select
            value={query.keyState ?? ""}
            onChange={(e) => update({ keyState: e.target.value })}
          >
            <option value="">Any</option>
            {KEY_STATES.map((k) => (
              <option key={k} value={k}>
                {KEY_FILTER_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Provider</span>
          <select
            value={query.provider ?? ""}
            onChange={(e) => update({ provider: e.target.value })}
          >
            <option value="">Any</option>
            {facets.providers.map((p) => (
              <option key={p} value={p}>
                {connectorName(p)}
              </option>
            ))}
          </select>
        </label>
        <FacetFilter
          label="Department"
          value={query.team ?? ""}
          options={facets.teams}
          onChange={(team) => update({ team })}
        />
        <FacetFilter
          label="Owner"
          value={query.owner ?? ""}
          options={facets.owners}
          onChange={(owner) => update({ owner })}
        />
      </div>

      {selection.size > 0 && (
        <div className="bulk-bar" role="region" aria-label="Selected agents">
          <span>
            <strong>{formatNumber(selection.size)}</strong> selected
          </span>
          <button
            type="button"
            className="button button-dark"
            disabled={bulk.isPending}
            onClick={() => bulk.mutate({ action: "kill" })}
          >
            Stop
          </button>
          <button
            type="button"
            className="button button-soft"
            disabled={bulk.isPending}
            onClick={() => bulk.mutate({ action: "resume" })}
          >
            Turn on
          </button>
          <button
            type="button"
            className="button button-soft"
            disabled={bulk.isPending}
            onClick={() => {
              setGrace(USE_POLICY);
              setBulkStep({ kind: "rotate-choose" });
            }}
          >
            Rotate keys
          </button>
          <button
            type="button"
            className="link-button"
            onClick={() => setSelection(new Set())}
          >
            Clear
          </button>
          <ErrorNote error={bulk.error} />
        </div>
      )}

      <div className="card flush">
        {list.isPending ? (
          <Loading label="Loading agents" />
        ) : list.isError ? (
          <ErrorNote error={list.error} />
        ) : items.length === 0 ? (
          <p className="empty">
            {query.q ||
            query.state ||
            query.light ||
            query.keyState ||
            query.provider ||
            query.owner ||
            query.team
              ? "No agents match these filters."
              : "No agents yet. Add one to give it its own key and limits."}
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table agents-table" aria-busy={list.isFetching}>
              <thead>
                <tr>
                  <th scope="col" className="col-check">
                    <input
                      type="checkbox"
                      aria-label="Select all agents on this page"
                      checked={allOnPage}
                      ref={(el) => {
                        if (el) el.indeterminate = someOnPage && !allOnPage;
                      }}
                      onChange={() =>
                        setSelection((current) => {
                          const next = new Set(current);
                          for (const a of items) {
                            if (allOnPage) next.delete(a.id);
                            else next.add(a.id);
                          }
                          return next;
                        })
                      }
                    />
                  </th>
                  <SortHeader
                    label="Name"
                    sortKey="name"
                    aria={ariaSort("name")}
                    onSort={sortBy}
                  />
                  <th scope="col">Owner</th>
                  <th scope="col">Department</th>
                  <SortHeader
                    label="Today"
                    sortKey="spend_today"
                    aria={ariaSort("spend_today")}
                    onSort={sortBy}
                  />
                  <SortHeader
                    label="This month"
                    sortKey="spend_month"
                    aria={ariaSort("spend_month")}
                    onSort={sortBy}
                  />
                  <SortHeader
                    label="Last used"
                    sortKey="last_used"
                    aria={ariaSort("last_used")}
                    onSort={sortBy}
                  />
                  <SortHeader
                    label="Key expires"
                    sortKey="key_expires"
                    aria={ariaSort("key_expires")}
                    onSort={sortBy}
                  />
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((agent) => (
                  <tr
                    key={agent.id}
                    className={
                      selection.has(agent.id) ? "row-selected" : undefined
                    }
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest("input,button,a"))
                        return;
                      update({ agent: agent.id }, true);
                    }}
                  >
                    <td className="col-check">
                      <input
                        type="checkbox"
                        aria-label={`Select ${agent.name}`}
                        checked={selection.has(agent.id)}
                        onChange={() => toggle(agent.id)}
                      />
                    </td>
                    <td>
                      <span className="name-cell">
                        <StatusLight state={agent.state} />
                        <button
                          type="button"
                          className="link-button strong"
                          onClick={() => update({ agent: agent.id }, true)}
                        >
                          {agent.name}
                        </button>
                        {agent.awaitingKey && (
                          <span className="badge badge-plain">Key waiting</span>
                        )}
                      </span>
                    </td>
                    <td>{agent.owner}</td>
                    <td>{agent.team ?? <span className="muted">None</span>}</td>
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

      {data && data.total > 0 && (
        <nav className="pager" aria-label="Pages">
          <label className="field inline">
            <span>Rows per page</span>
            <select
              value={query.pageSize}
              onChange={(e) => update({ pageSize: e.target.value })}
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <span className="muted">
            {formatNumber((data.page - 1) * data.pageSize + 1)} to{" "}
            {formatNumber(Math.min(data.total, data.page * data.pageSize))} of{" "}
            {formatNumber(data.total)}
          </span>
          <button
            type="button"
            className="button button-ghost"
            disabled={data.page <= 1}
            onClick={() => update({ page: String(data.page - 1) }, true)}
          >
            Previous
          </button>
          <span>
            Page {data.page} of {totalPages}
          </span>
          <button
            type="button"
            className="button button-ghost"
            disabled={data.page >= totalPages}
            onClick={() => update({ page: String(data.page + 1) }, true)}
          >
            Next
          </button>
        </nav>
      )}

      {selectedAgent && (
        <AgentDetail
          agentRef={selectedAgent}
          connectors={providers.data ?? []}
          onClose={() => update({ agent: undefined }, true)}
        />
      )}

      {adding && (
        <AddAgentDialog
          onClose={() => setAdding(false)}
          connectors={providers.data ?? []}
        />
      )}

      {bulkStep?.kind === "rotate-choose" && (
        <Dialog
          title={`Rotate ${formatNumber(selection.size)} keys`}
          onClose={() => setBulkStep(null)}
        >
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              bulk.mutate({ action: "rotate-key", graceMinutes: grace });
            }}
          >
            <p>
              Each selected agent gets a new key. You will see the new keys
              once, so have somewhere ready to keep them.
            </p>
            <GracePicker value={grace} onChange={setGrace} mixedPolicies />
            <p className="hint">
              Agents with a rotation schedule get a new expiry date from it.
            </p>
            <ErrorNote error={bulk.error} />
            <div className="row end">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setBulkStep(null)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="button"
                disabled={bulk.isPending}
              >
                {bulk.isPending ? "Rotating…" : "Rotate keys"}
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {bulkStep?.kind === "result" && (
        <BulkResultDialog
          action={bulkStep.action}
          result={bulkStep.result}
          onClose={() => setBulkStep(null)}
        />
      )}
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  aria,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  aria: "ascending" | "descending" | "none";
  onSort: (key: SortKey) => void;
}) {
  return (
    <th scope="col" aria-sort={aria}>
      <button
        type="button"
        className="sort-button"
        onClick={() => onSort(sortKey)}
      >
        {label}
        <span className="sort-mark" aria-hidden="true">
          {aria === "ascending" ? "▲" : aria === "descending" ? "▼" : ""}
        </span>
      </button>
    </th>
  );
}

/**
 * A searchable filter for owners or teams. There can be hundreds, so it uses
 * a text box with suggestions rather than a long menu. It applies once the
 * text matches one of them, or is cleared.
 */
function FacetFilter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  const listId = useId();
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label className="field">
      <span>{label}</span>
      <input
        list={listId}
        value={text}
        placeholder="Any"
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          if (next === "" || options.includes(next)) onChange(next);
        }}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </label>
  );
}

function BulkResultDialog({
  action,
  result,
  onClose,
}: {
  action: "kill" | "resume" | "rotate-key";
  result: BulkResult;
  onClose: () => void;
}) {
  const ok = result.results.filter((r) => r.ok);
  const failed = result.results.filter((r) => !r.ok);
  const keys = ok.filter((r) => r.key);
  const verb =
    action === "kill"
      ? "Stopped"
      : action === "resume"
        ? "Turned on"
        : "Rotated keys for";
  const csv = toCsv(
    ["agent", "id", "key"],
    keys.map((r) => [r.name, r.id, r.key ?? ""]),
  );
  const keyText = keys.map((r) => `${r.name}\t${r.key ?? ""}`).join("\n");

  return (
    <Dialog title="Done" onClose={onClose} wide={keys.length > 0}>
      <div className="stack" role="status">
        <p className="big">
          {verb} {formatNumber(ok.length)}{" "}
          {ok.length === 1 ? "agent" : "agents"}
          {action === "kill" ? ` in ${Math.round(result.elapsedMs)} ms` : ""}.
        </p>
        {action === "kill" && result.abortedRequests !== undefined && (
          <p>
            {result.abortedRequests === 0
              ? "Nothing was running at the time."
              : `Cut ${formatNumber(result.abortedRequests)} requests that were still running.`}
          </p>
        )}
        {failed.length > 0 && (
          <div className="note note-error" role="alert">
            {formatNumber(failed.length)} didn't work:
            <ul>
              {failed.slice(0, 10).map((r) => (
                <li key={r.id}>
                  {r.name}: {r.error ?? "unknown error"}
                </li>
              ))}
            </ul>
          </div>
        )}
        {keys.length > 0 && (
          <>
            <p>
              These keys are shown once. Copy them or download them now, then
              paste each into its tool.
            </p>
            <div className="row">
              <CopyButton text={keyText} label="Copy all" />
              <button
                type="button"
                className="button button-soft"
                onClick={() => downloadText("purser-new-keys.csv", csv)}
              >
                Download CSV
              </button>
            </div>
            <div className="table-wrap key-table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Agent</th>
                    <th scope="col">New key</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((r) => (
                    <tr key={r.id}>
                      <td>{r.name}</td>
                      <td>
                        <code className="mono small">{r.key}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="row end">
          <button type="button" className="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function AddAgentDialog({
  onClose,
  connectors,
}: {
  onClose: () => void;
  connectors: Connector[];
}) {
  const queryClient = useQueryClient();
  const [created, setCreated] = useState<CreatedAgent | null>(null);
  const create = useMutation({
    mutationFn: api.createAgent,
    onSuccess: (data) => {
      setCreated(data);
      void queryClient.invalidateQueries();
    },
  });

  const configured = connectors.filter((c) => c.configured);
  const allowed = created?.agent.providers;
  const targets = allowed?.length
    ? configured.filter((c) => allowed.includes(c.id))
    : configured;

  return (
    <Dialog
      title={created ? `${created.agent.name} is ready` : "Add an agent"}
      onClose={onClose}
      wide
    >
      {created ? (
        <div className="stack">
          <KeyReveal name={created.agent.name} agentKey={created.key} />
          {targets.map((c) => (
            <section key={c.id} className="stack">
              <h3>Connect through {c.name}</h3>
              <ConnectionValues connector={c} agentKey={created.key} />
            </section>
          ))}
          <div className="row end">
            <button type="button" className="button" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <AgentForm
          connectors={connectors}
          busy={create.isPending}
          error={create.error}
          onSubmit={(agent) => create.mutate(agent)}
        />
      )}
    </Dialog>
  );
}
