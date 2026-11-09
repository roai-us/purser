import { useId, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../api/client";
import type { Connector, DepartmentRow, Light } from "../api/types";
import { parseMoney } from "../components/AgentForm";
import { Dialog } from "../components/Dialog";
import { ErrorNote, Loading } from "../components/Notice";
import {
  draftFromPolicy,
  Field,
  policySummary,
  PolicyFields,
  readPolicy,
} from "../components/OrgSettings";
import { LIGHT_CLASS } from "../components/StatusLight";
import { formatNumber, formatUsd } from "../lib/format";
import "../org.css";

const LIGHT_WORDS: Record<Light, string> = {
  green: "running",
  yellow: "at limit",
  red: "stopped",
};

/** Spend this month against the department's monthly budget. */
export function BudgetBar({
  spent,
  budget,
}: {
  spent: number;
  budget?: number | undefined;
}) {
  if (budget === undefined) {
    return (
      <span className="budget">
        {formatUsd(spent)} <span className="muted">no budget</span>
      </span>
    );
  }
  const over = spent > budget;
  const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 100;
  const tone = over ? "over" : pct >= 100 ? "full" : pct >= 80 ? "high" : "ok";
  return (
    <span className="budget">
      <span>
        {formatUsd(spent)} <span className="muted">of {formatUsd(budget)}</span>
      </span>
      <svg
        className="spend-bar"
        viewBox="0 0 100 8"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <rect width="100" height="8" rx="4" className="spend-track" />
        <rect width={pct} height="8" rx="4" className={`spend-fill ${tone}`} />
      </svg>
      {over && (
        <span className="budget-over">
          Over budget by {formatUsd(spent - budget)}
        </span>
      )}
    </span>
  );
}

function LightCounts({ row }: { row: DepartmentRow }) {
  return (
    <span className="light-counts">
      {(["green", "yellow", "red"] as const).map((light) => (
        <span key={light} className="light-count" title={LIGHT_WORDS[light]}>
          <span className={LIGHT_CLASS[light]} aria-hidden="true" />
          {formatNumber(row[light])}
          <span className="sr-only"> {LIGHT_WORDS[light]}</span>
        </span>
      ))}
    </span>
  );
}

export function DepartmentsPage() {
  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: api.departments,
  });
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: api.providers,
  });
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<DepartmentRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const data = departments.data;
  const rows = useMemo(() => {
    const text = search.trim().toLowerCase();
    return [...(data?.items ?? [])]
      .filter((d) => !text || d.name.toLowerCase().includes(text))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data, search]);

  const connectors = providers.data ?? [];
  const providerName = (id: string) =>
    connectors.find((c) => c.id === id)?.name ?? id;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Departments</h1>
          <p className="muted">
            {data
              ? `${formatNumber(data.items.length)} ${data.items.length === 1 ? "department" : "departments"}`
              : " "}
          </p>
        </div>
      </header>

      {data && !data.selfService && (
        <p className="note note-info">
          People can't ask for agents themselves yet, so these rules don't apply
          until you turn that on in <Link to="/settings">Settings</Link>.
        </p>
      )}

      {notice && (
        <p className="note note-ok" role="status">
          {notice}
        </p>
      )}

      <div className="filters" role="search">
        <label className="field grow">
          <span>Search</span>
          <input
            type="search"
            value={search}
            placeholder="Department name"
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>

      <div className="card flush">
        {departments.isPending ? (
          <Loading label="Loading departments" />
        ) : departments.isError ? (
          <ErrorNote error={departments.error} />
        ) : rows.length === 0 ? (
          <p className="empty">
            {search.trim()
              ? "No departments match this search."
              : "No departments yet. They appear when people or agents are given one."}
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table departments-table">
              <thead>
                <tr>
                  <th scope="col">Department</th>
                  <th scope="col">Agents</th>
                  <th scope="col">This month</th>
                  <th scope="col">Today</th>
                  <th scope="col">People</th>
                  <th scope="col">Managers</th>
                  <th scope="col">Requests waiting</th>
                  <th scope="col">Rules</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.name}>
                    <th scope="row" className="strong">
                      {row.name}
                    </th>
                    <td>
                      <span className="strong">{formatNumber(row.agents)}</span>
                      <LightCounts row={row} />
                    </td>
                    <td>
                      <BudgetBar
                        spent={row.spendMonth}
                        budget={row.budgetMonthlyUsd}
                      />
                    </td>
                    <td>{formatUsd(row.spendToday)}</td>
                    <td>{formatNumber(row.people)}</td>
                    <td>
                      {row.managers.length > 0 ? (
                        row.managers.map((m) => m.name).join(", ")
                      ) : (
                        <span className="muted">None</span>
                      )}
                    </td>
                    <td>
                      {row.pending > 0 ? (
                        <Link
                          to={`/approvals?department=${encodeURIComponent(row.name)}`}
                          aria-label={`${formatNumber(row.pending)} ${row.pending === 1 ? "request" : "requests"} waiting in ${row.name}`}
                        >
                          {formatNumber(row.pending)} waiting
                        </Link>
                      ) : (
                        <span className="muted">None</span>
                      )}
                    </td>
                    <td className="rules-cell">
                      {policySummary(row.policy)}
                      {row.policy.allowedProviders?.length ? (
                        <span className="cell-sub">
                          Only{" "}
                          {row.policy.allowedProviders
                            .map(providerName)
                            .join(", ")}
                        </span>
                      ) : null}
                      <span className="block">
                        <span
                          className={
                            row.selfService ? "rule-tag own" : "rule-tag"
                          }
                        >
                          {row.selfService ? "Own rules" : "Default rules"}
                        </span>
                      </span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="button button-soft"
                        aria-label={`Edit ${row.name}`}
                        onClick={() => {
                          setNotice(null);
                          setEditing(row);
                        }}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && data && (
        <EditDepartmentDialog
          row={editing}
          defaults={data.defaults}
          connectors={connectors}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setNotice(`Saved the rules for ${editing.name}.`);
          }}
        />
      )}
    </div>
  );
}

function EditDepartmentDialog({
  row,
  defaults,
  connectors,
  onClose,
  onSaved,
}: {
  row: DepartmentRow;
  defaults: DepartmentRow["policy"];
  connectors: Connector[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [budget, setBudget] = useState(
    row.budgetMonthlyUsd === undefined ? "" : String(row.budgetMonthlyUsd),
  );
  const [own, setOwn] = useState(Boolean(row.selfService));
  const [draft, setDraft] = useState(() =>
    draftFromPolicy(row.selfService ?? defaults),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const radioName = useId();

  const save = useMutation({
    mutationFn: (patch: Parameters<typeof api.saveDepartment>[1]) =>
      api.saveDepartment(row.name, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      onSaved();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    let budgetMonthlyUsd: number | null = null;
    if (budget.trim()) {
      const value = parseMoney(budget);
      if (value === undefined) {
        setProblem(
          "Enter the monthly budget in dollars, or leave it empty for none.",
        );
        return;
      }
      budgetMonthlyUsd = value;
    }
    let selfService = null;
    if (own) {
      const read = readPolicy(draft);
      if ("problem" in read) {
        setProblem(read.problem);
        return;
      }
      selfService = read.policy;
    }
    setProblem(null);
    save.mutate({ budgetMonthlyUsd, selfService });
  }

  return (
    <Dialog title={`Edit ${row.name}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field
          label="Monthly budget ($)"
          hint="What the department's agents can spend together each month. Leave empty for no budget."
        >
          <input
            inputMode="decimal"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
          />
        </Field>
        <fieldset className="radio-list">
          <legend>Rules for asking for agents</legend>
          <label className="radio radio-block">
            <input
              type="radio"
              name={radioName}
              checked={!own}
              onChange={() => setOwn(false)}
            />
            <span>
              Use the organisation's default rules
              <span className="hint block">{policySummary(defaults)}</span>
            </span>
          </label>
          <label className="radio radio-block">
            <input
              type="radio"
              name={radioName}
              checked={own}
              onChange={() => setOwn(true)}
            />
            <span>
              Own rules
              <span className="hint block">
                Set different limits for this department.
              </span>
            </span>
          </label>
        </fieldset>
        {own && (
          <PolicyFields
            value={draft}
            onChange={setDraft}
            connectors={connectors}
          />
        )}
        {problem && (
          <p className="note note-error" role="alert">
            {problem}
          </p>
        )}
        <ErrorNote error={save.error} />
        <div className="row end">
          <button
            type="button"
            className="button button-ghost"
            onClick={onClose}
          >
            Cancel
          </button>
          <button type="submit" className="button" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
