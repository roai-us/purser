import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { api } from "../api/client";
import type { OffboardResult, Person, PersonRow, Role } from "../api/types";
import { Dialog } from "../components/Dialog";
import { ErrorNote, Loading } from "../components/Notice";
import { Field } from "../components/OrgSettings";
import { LIGHT_CLASS } from "../components/StatusLight";
import {
  formatDate,
  formatDateTime,
  formatNumber,
  formatRelative,
  formatUsd,
} from "../lib/format";
import { useDebounced } from "../lib/hooks";
import "../org.css";

const PAGE_SIZES = [50, 100, 200];
const ROLES: Role[] = ["admin", "manager", "member"];
export const ROLE_LABELS: Record<Role, string> = {
  admin: "Admin",
  manager: "Manager",
  member: "Member",
};
const ROLE_HINTS: Record<Role, string> = {
  admin: "Can see and change everything in Purser.",
  manager: "Decides on agent requests for the departments they manage.",
  member: "Can ask for agents and look after their own.",
};
type Status = Person["status"];
const STATUS_LABELS: Record<Status, string> = {
  active: "Active",
  disabled: "Turned off",
};
const SOURCE_LABELS: Record<Person["source"], string> = {
  sso: "Company sign-in",
  admin: "Added by an admin",
  demo: "Demo account",
};

export interface PeopleQuery {
  q?: string;
  role?: Role;
  department?: string;
  status?: Status;
  page: number;
  pageSize: number;
}

/** Reads the people list query from the page address. */
export function peopleQueryFromParams(params: URLSearchParams): PeopleQuery {
  const query: PeopleQuery = { page: 1, pageSize: 50 };
  const q = params.get("q");
  if (q) query.q = q;
  const role = params.get("role");
  if (role && (ROLES as string[]).includes(role)) query.role = role as Role;
  const department = params.get("department");
  if (department) query.department = department;
  const status = params.get("status");
  if (status === "active" || status === "disabled") query.status = status;
  const page = Number(params.get("page"));
  if (Number.isInteger(page) && page > 0) query.page = page;
  const size = Number(params.get("pageSize"));
  if (PAGE_SIZES.includes(size)) query.pageSize = size;
  return query;
}

const plural = (n: number, one: string, many: string) =>
  `${formatNumber(n)} ${n === 1 ? one : many}`;
const agentCount = (n: number) => plural(n, "agent", "agents");

/** One or two sentences saying what turning someone off did. */
export function offboardSummary(
  result: OffboardResult,
  handedTo?: string,
): string {
  const sessions = result.sessionsEnded;
  const sessionCount = plural(sessions, "session", "sessions");
  const signIn =
    sessions > 0
      ? `Signed them out of ${sessionCount}.`
      : "They were not signed in anywhere.";
  if (handedTo) {
    return `Handed ${agentCount(result.reassigned)} to ${handedTo}. ${signIn}`;
  }
  if (result.stopped > 0 && sessions > 0) {
    return `Stopped ${agentCount(result.stopped)} and signed them out of ${sessionCount}.`;
  }
  const agents =
    result.stopped > 0
      ? `Stopped ${agentCount(result.stopped)}.`
      : "No agents needed stopping.";
  return `${agents} ${signIn}`;
}

function StatusCell({ status }: { status: Status }) {
  return (
    <span className="status-cell">
      <span
        className={LIGHT_CLASS[status === "active" ? "green" : "red"]}
        aria-hidden="true"
      />
      {STATUS_LABELS[status]}
    </span>
  );
}

function useDepartmentNames() {
  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: api.departments,
  });
  return useMemo(
    () => (departments.data?.items ?? []).map((d) => d.name),
    [departments.data],
  );
}

export function PeoplePage() {
  const [params, setParams] = useSearchParams();
  const query = useMemo(() => peopleQueryFromParams(params), [params]);
  const selectedId = params.get("person");
  const departments = useDepartmentNames();

  const [search, setSearch] = useState(query.q ?? "");
  const debounced = useDebounced(search, 300);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["people", query],
    queryFn: () => api.people({ ...query }),
    placeholderData: keepPreviousData,
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
    if ((debounced || undefined) !== query.q) update({ q: debounced });
    // Keyed on the debounced text alone, as on the Agents page: re-running when
    // the address changes would write stale search text back into it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const data = list.data;
  const items = data?.items ?? [];
  const totalPages = data
    ? Math.max(1, Math.ceil(data.total / data.pageSize))
    : 1;

  // Keep the open person even if a change moves them off this page or out of
  // the filters, so the panel and its result stay put.
  const found = items.find((p) => p.id === selectedId);
  const [remembered, setRemembered] = useState<PersonRow | null>(null);
  useEffect(() => {
    if (found) setRemembered(found);
  }, [found]);
  const open =
    found ?? (remembered?.id === selectedId ? remembered : undefined);

  const filtered = Boolean(
    query.q || query.role || query.department || query.status,
  );
  const departmentOptions =
    query.department && !departments.includes(query.department)
      ? [...departments, query.department]
      : departments;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>People</h1>
          <p className="muted">
            {data ? plural(data.total, "person", "people") : " "}
          </p>
        </div>
        <button
          type="button"
          className="button"
          onClick={() => {
            setNotice(null);
            setAdding(true);
          }}
        >
          Add person
        </button>
      </header>

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
            placeholder="Name, email or department"
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Role</span>
          <select
            value={query.role ?? ""}
            onChange={(e) => update({ role: e.target.value })}
          >
            <option value="">Any</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Department</span>
          <select
            value={query.department ?? ""}
            onChange={(e) => update({ department: e.target.value })}
          >
            <option value="">Any</option>
            {departmentOptions.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Status</span>
          <select
            value={query.status ?? ""}
            onChange={(e) => update({ status: e.target.value })}
          >
            <option value="">Any</option>
            <option value="active">Active</option>
            <option value="disabled">Turned off</option>
          </select>
        </label>
      </div>

      <div className="card flush">
        {list.isPending ? (
          <Loading label="Loading people" />
        ) : list.isError ? (
          <ErrorNote error={list.error} />
        ) : items.length === 0 ? (
          <p className="empty">
            {filtered
              ? "No people match these filters."
              : "No people yet. Add someone, or set up company sign-in in Settings."}
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table people-table" aria-busy={list.isFetching}>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Department</th>
                  <th scope="col">Agents</th>
                  <th scope="col">This month</th>
                  <th scope="col">Last sign-in</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((person) => (
                  <tr key={person.id}>
                    <td>
                      <button
                        type="button"
                        className="link-button strong"
                        onClick={() => update({ person: person.id }, true)}
                      >
                        {person.name}
                      </button>
                    </td>
                    <td>{person.email}</td>
                    <td>{ROLE_LABELS[person.role]}</td>
                    <td>
                      {person.department ?? <span className="muted">None</span>}
                    </td>
                    <td>
                      {formatNumber(person.agents)}
                      {person.agents > 0 && (
                        <span className="cell-sub">
                          {formatNumber(person.running)} running
                        </span>
                      )}
                    </td>
                    <td>{formatUsd(person.spendMonth)}</td>
                    <td>{formatRelative(person.lastSignInAt)}</td>
                    <td>
                      <StatusCell status={person.status} />
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

      {open && (
        <PersonPanel
          key={open.id}
          row={open}
          departments={departments}
          onClose={() => update({ person: undefined }, true)}
        />
      )}

      {adding && (
        <AddPersonDialog
          departments={departments}
          onClose={() => setAdding(false)}
          onAdded={(person) => {
            setAdding(false);
            setNotice(`Added ${person.name}.`);
          }}
        />
      )}
    </div>
  );
}

/** The fields shared by adding and editing someone. */
interface PersonDraft {
  name: string;
  role: Role;
  department: string;
  manages: string;
}

function PersonFields({
  draft,
  onChange,
  departments,
}: {
  draft: PersonDraft;
  onChange: (next: PersonDraft) => void;
  departments: string[];
}) {
  const listId = useId();
  return (
    <>
      <label className="field">
        <span>Name</span>
        <input
          value={draft.name}
          required
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
        />
      </label>
      <Field label="Role" hint={ROLE_HINTS[draft.role]}>
        <select
          value={draft.role}
          onChange={(e) => onChange({ ...draft, role: e.target.value as Role })}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </Field>
      <label className="field">
        <span>Department</span>
        <input
          list={listId}
          value={draft.department}
          onChange={(e) => onChange({ ...draft, department: e.target.value })}
        />
        <datalist id={listId}>
          {departments.map((d) => (
            <option key={d} value={d} />
          ))}
        </datalist>
      </label>
      {draft.role === "manager" && (
        <Field
          label="Departments they manage"
          hint="Separate departments with commas. They decide on agent requests from these departments."
        >
          <input
            value={draft.manages}
            placeholder={departments.slice(0, 2).join(", ")}
            onChange={(e) => onChange({ ...draft, manages: e.target.value })}
          />
        </Field>
      )}
    </>
  );
}

/** Department names typed with commas. Spaces stay inside names. */
function splitDepartments(text: string): string[] {
  return [
    ...new Set(
      text
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

function AddPersonDialog({
  departments,
  onClose,
  onAdded,
}: {
  departments: string[];
  onClose: () => void;
  onAdded: (person: Person) => void;
}) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [draft, setDraft] = useState<PersonDraft>({
    name: "",
    role: "member",
    department: "",
    manages: "",
  });
  const add = useMutation({
    mutationFn: api.addPerson,
    onSuccess: (person) => {
      void queryClient.invalidateQueries();
      onAdded(person);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const department = draft.department.trim();
    const manages = splitDepartments(draft.manages);
    add.mutate({
      email: email.trim(),
      name: draft.name.trim(),
      role: draft.role,
      ...(department ? { department } : {}),
      ...(draft.role === "manager" && manages.length ? { manages } : {}),
    });
  }

  return (
    <Dialog title="Add a person" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted">
          With company sign-in, people are added the first time they sign in.
          Add someone here to set their role or department before then.
        </p>
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            autoComplete="off"
            value={email}
            required
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <PersonFields
          draft={draft}
          onChange={setDraft}
          departments={departments}
        />
        <ErrorNote error={add.error} />
        <div className="row end">
          <button
            type="button"
            className="button button-ghost"
            onClick={onClose}
          >
            Cancel
          </button>
          <button type="submit" className="button" disabled={add.isPending}>
            {add.isPending ? "Adding…" : "Add person"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Side panel with one person's details, an edit form and their access. */
function PersonPanel({
  row,
  departments,
  onClose,
}: {
  row: PersonRow;
  departments: string[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  // The list row, updated straight away by whatever we change here.
  const [person, setPerson] = useState<PersonRow>(row);
  useEffect(() => setPerson(row), [row]);
  const [message, setMessage] = useState<string | null>(null);
  const [turningOff, setTurningOff] = useState(false);

  const changed = (next: Person) => {
    setPerson((current) => ({ ...current, ...next }));
    void queryClient.invalidateQueries();
  };

  const enable = useMutation({
    mutationFn: () => api.enablePerson(person.id),
    onSuccess: (next) => {
      changed(next);
      setMessage(
        `${next.name} can sign in again. Their agents stay stopped until someone turns them on.`,
      );
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".backdrop")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const off = person.status === "disabled";

  return (
    <aside className="panel" aria-label="Person details">
      <div className="panel-head">
        <h2 className="name-cell">
          <span
            className={LIGHT_CLASS[off ? "red" : "green"]}
            aria-hidden="true"
          />
          {person.name}
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
      <div className="panel-body">
        {message && (
          <p className="note note-ok" role="status">
            {message}
          </p>
        )}

        <section className="access stack" aria-labelledby="access-h">
          <h3 id="access-h">Access</h3>
          {off ? (
            <>
              <p>
                Access turned off
                {person.disabledAt
                  ? ` on ${formatDateTime(person.disabledAt)}`
                  : ""}
                {person.disabledBy ? ` by ${person.disabledBy}` : ""}. They
                can't sign in.
              </p>
              <p className="hint">
                Turning access back on lets them sign in again. Their agents
                stay stopped until someone turns them on.
              </p>
              <ErrorNote error={enable.error} />
              <div className="row">
                <button
                  type="button"
                  className="button"
                  disabled={enable.isPending}
                  onClick={() => {
                    setMessage(null);
                    enable.mutate();
                  }}
                >
                  {enable.isPending ? "Turning on…" : "Turn access back on"}
                </button>
              </div>
            </>
          ) : (
            <>
              <p>
                When someone leaves, turn off their access. Their agents are
                stopped or handed to someone else.
              </p>
              <div className="row">
                <button
                  type="button"
                  className="button button-dark"
                  onClick={() => {
                    setMessage(null);
                    setTurningOff(true);
                  }}
                >
                  Turn off access
                </button>
              </div>
            </>
          )}
        </section>

        <dl className="facts">
          <div>
            <dt>Email</dt>
            <dd>{person.email}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>
              <StatusCell status={person.status} />
            </dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>{ROLE_LABELS[person.role]}</dd>
          </div>
          <div>
            <dt>Department</dt>
            <dd>{person.department ?? <span className="muted">None</span>}</dd>
          </div>
          {person.manages && person.manages.length > 0 && (
            <div>
              <dt>Manages</dt>
              <dd>{person.manages.join(", ")}</dd>
            </div>
          )}
          <div>
            <dt>Agents</dt>
            <dd>
              {formatNumber(person.agents)}{" "}
              <span className="muted">
                ({formatNumber(person.running)} running)
              </span>
            </dd>
          </div>
          <div>
            <dt>Spent this month</dt>
            <dd>{formatUsd(person.spendMonth)}</dd>
          </div>
          <div>
            <dt>Last sign-in</dt>
            <dd>{formatRelative(person.lastSignInAt)}</dd>
          </div>
          <div>
            <dt>Added</dt>
            <dd>{formatDate(person.createdAt)}</dd>
          </div>
          <div>
            <dt>Joined through</dt>
            <dd>{SOURCE_LABELS[person.source]}</dd>
          </div>
        </dl>

        <EditPerson
          person={person}
          departments={departments}
          onSaved={changed}
        />
      </div>

      {turningOff && (
        <TurnOffDialog
          person={person}
          onClose={() => setTurningOff(false)}
          onDone={changed}
        />
      )}
    </aside>
  );
}

function EditPerson({
  person,
  departments,
  onSaved,
}: {
  person: Person;
  departments: string[];
  onSaved: (person: Person) => void;
}) {
  const [draft, setDraft] = useState<PersonDraft>({
    name: person.name,
    role: person.role,
    department: person.department ?? "",
    manages: (person.manages ?? []).join(", "),
  });
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: (patch: Parameters<typeof api.updatePerson>[1]) =>
      api.updatePerson(person.id, patch),
    onSuccess: (next) => {
      setSaved(true);
      onSaved(next);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    const department = draft.department.trim();
    save.mutate({
      name: draft.name.trim(),
      role: draft.role,
      department: department || null,
      manages: draft.role === "manager" ? splitDepartments(draft.manages) : [],
    });
  }

  return (
    <details className="edit">
      <summary>Edit details</summary>
      <form className="stack" onSubmit={submit}>
        <PersonFields
          draft={draft}
          onChange={setDraft}
          departments={departments}
        />
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

function TurnOffDialog({
  person,
  onClose,
  onDone,
}: {
  person: PersonRow;
  onClose: () => void;
  onDone: (person: Person) => void;
}) {
  const radioName = useId();
  const listId = useId();
  const [handOver, setHandOver] = useState(false);
  const [to, setTo] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  // Suggest active people as the admin types a name or email.
  const lookup = useDebounced(to.trim(), 250);
  const suggestions = useQuery({
    queryKey: ["people", "suggest", lookup],
    queryFn: () => api.people({ q: lookup, status: "active", pageSize: 20 }),
    enabled: handOver && lookup.length >= 2,
  });
  const candidates = (suggestions.data?.items ?? []).filter(
    (p) => p.id !== person.id,
  );

  const disable = useMutation({
    mutationFn: (reassignTo: string | undefined) =>
      api.disablePerson(person.id, reassignTo),
    onSuccess: (data, reassignTo) => {
      const target = reassignTo
        ? (candidates.find(
            (p) => p.email.toLowerCase() === reassignTo.toLowerCase(),
          )?.name ?? reassignTo)
        : undefined;
      setResult(offboardSummary(data, target));
      onDone(data.person);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (handOver && person.agents > 0) {
      const target = to.trim();
      if (!target) {
        setProblem("Enter the email of the person who takes over the agents.");
        return;
      }
      if (target.toLowerCase() === person.email.toLowerCase()) {
        setProblem("Pick someone else to take over the agents.");
        return;
      }
      setProblem(null);
      disable.mutate(target);
      return;
    }
    setProblem(null);
    disable.mutate(undefined);
  }

  if (result) {
    return (
      <Dialog title={`${person.name}'s access is off`} onClose={onClose}>
        <div className="stack">
          <p className="big" role="status">
            {result}
          </p>
          <p className="muted">
            Any requests they were waiting on were cancelled.
          </p>
          <div className="row end">
            <button type="button" className="button" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={`Turn off access for ${person.name}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p>
          This signs {person.name} out everywhere and cancels any requests they
          are waiting on. They can't sign in again until someone turns their
          access back on.
        </p>
        {person.agents > 0 ? (
          <fieldset className="radio-list">
            <legend>Their {agentCount(person.agents)}</legend>
            <label className="radio radio-block">
              <input
                type="radio"
                name={radioName}
                checked={!handOver}
                onChange={() => setHandOver(false)}
              />
              <span>
                Stop their {agentCount(person.agents)}
                <span className="hint block">
                  Each agent stops at once. Someone can turn them back on later.
                </span>
              </span>
            </label>
            <label className="radio radio-block">
              <input
                type="radio"
                name={radioName}
                checked={handOver}
                onChange={() => setHandOver(true)}
              />
              <span>
                Hand them to someone else
                <span className="hint block">
                  The agents keep running, with a new owner.
                </span>
              </span>
            </label>
          </fieldset>
        ) : (
          <p className="muted">They have no agents.</p>
        )}
        {handOver && person.agents > 0 && (
          <label className="field">
            <span>Hand their agents to</span>
            <input
              list={listId}
              value={to}
              autoComplete="off"
              placeholder="Email address"
              onChange={(e) => setTo(e.target.value)}
            />
            <datalist id={listId}>
              {candidates.map((p) => (
                <option key={p.id} value={p.email}>
                  {p.name}
                </option>
              ))}
            </datalist>
          </label>
        )}
        {problem && (
          <p className="note note-error" role="alert">
            {problem}
          </p>
        )}
        <ErrorNote error={disable.error} />
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
            disabled={disable.isPending}
          >
            {disable.isPending ? "Turning off…" : "Turn off access"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
