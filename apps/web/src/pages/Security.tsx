import { ProviderKeys } from "../components/ProviderKeys";
import { useId, useState, type FormEvent } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../api/client";
import type { RotateAllResult, SecurityView } from "../api/types";
import { CopyButton } from "../components/CopyButton";
import { Dialog } from "../components/Dialog";
import { ErrorNote, Loading } from "../components/Notice";
import { formatDateTime, formatNumber } from "../lib/format";

const OVERLAPS = [
  {
    minutes: 0,
    label: "Right away",
    hint: "Use this if a key may have leaked. Tools stop until they get a new key.",
  },
  {
    minutes: 60,
    label: "After 1 hour",
    hint: "For a planned change. A leaked key would keep working for that hour.",
  },
  {
    minutes: 1440,
    label: "After 24 hours",
    hint: "For a planned change. A leaked key would keep working for that day.",
  },
];

/** A spreadsheet cell: quoted, and never read as a formula. */
function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** The new keys as a spreadsheet, with one row per agent. */
export function keysCsv(keys: RotateAllResult["keys"]): string {
  const rows = [
    ["agent", "owner", "department", "new key"],
    ...keys.map((k) => [k.name, k.owner, k.team ?? "", k.key]),
  ];
  return `${rows.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

function downloadKeys(keys: RotateAllResult["keys"]) {
  const url = URL.createObjectURL(
    new Blob([keysCsv(keys)], { type: "text/csv" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "purser-new-keys.csv";
  link.click();
  URL.revokeObjectURL(url);
}

/** For a security incident: replace every agent key, and see what's left to do. */
export function SecurityPage() {
  const view = useQuery({
    queryKey: ["security"],
    queryFn: () => api.security(),
  });
  const [rotating, setRotating] = useState(false);
  const [result, setResult] = useState<RotateAllResult | null>(null);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Security</h1>
          <p className="muted">
            What to do if a key or this server is exposed.
          </p>
        </div>
      </header>
      {view.isPending ? (
        <Loading />
      ) : view.isError ? (
        <ErrorNote error={view.error} />
      ) : (
        <>
          {result ? (
            <RotationDone
              result={result}
              view={view.data}
              onDone={() => setResult(null)}
            />
          ) : (
            <section className="card stack danger-card" aria-labelledby="rot-h">
              <h2 id="rot-h">Rotate all keys</h2>
              <p>
                Replaces the key of every agent, including stopped ones. Tools
                using the old keys stop working until they have the new ones, so
                use this when a key may have leaked and you don't know which.
              </p>
              <dl className="facts compact">
                <div>
                  <dt>Agents</dt>
                  <dd>{formatNumber(view.data.agents.total)}</dd>
                </div>
                <div>
                  <dt>Owners collect their own</dt>
                  <dd>{formatNumber(view.data.agents.ownerCollects)}</dd>
                </div>
                <div>
                  <dt>You download these</dt>
                  <dd>{formatNumber(view.data.agents.adminGets)}</dd>
                </div>
              </dl>
              {!view.data.peopleCanSignIn && (
                <p className="hint">
                  Company sign-in is off, so owners can't collect keys. Every
                  new key would come to you as a download.
                </p>
              )}
              <div>
                <button
                  type="button"
                  className="button button-danger"
                  onClick={() => setRotating(true)}
                >
                  Rotate all keys
                </button>
              </div>
            </section>
          )}
          {view.data.agents.waiting > 0 && (
            <section className="card stack" aria-labelledby="wait-h">
              <h2 id="wait-h">Keys still to collect</h2>
              <p>
                {formatNumber(view.data.agents.waiting)}{" "}
                {view.data.agents.waiting === 1
                  ? "agent's owner hasn't"
                  : "agents' owners haven't"}{" "}
                collected a new key yet.{" "}
                <Link to="/agents?awaiting=1">See which</Link>
              </p>
            </section>
          )}
          <ProviderKeys demoKeys={view.data.demoKeys === true} />
          {view.data.history.length > 0 && (
            <section className="card stack" aria-labelledby="hist-h">
              <h2 id="hist-h">Past rotations</h2>
              <div className="table-wrap">
                <table className="table small">
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Who</th>
                      <th scope="col">Why</th>
                      <th scope="col">Keys</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.data.history.map((h) => (
                      <tr key={h.at}>
                        <td>{formatDateTime(h.at)}</td>
                        <td>{h.by}</td>
                        <td>{h.reason}</td>
                        <td>
                          {formatNumber(h.rotated ?? 0)}
                          {h.department ? ` in ${h.department}` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
      {rotating && view.data && (
        <RotateDialog
          view={view.data}
          onClose={() => setRotating(false)}
          onDone={(r) => {
            setRotating(false);
            setResult(r);
          }}
        />
      )}
    </div>
  );
}

function RotateDialog({
  view,
  onClose,
  onDone,
}: {
  view: SecurityView;
  onClose: () => void;
  onDone: (result: RotateAllResult) => void;
}) {
  const queryClient = useQueryClient();
  const name = useId();
  const [department, setDepartment] = useState("");
  const [overlap, setOverlap] = useState(0);
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const scoped = useQuery({
    queryKey: ["security", department],
    queryFn: () => api.security(department),
    enabled: department !== "",
    placeholderData: keepPreviousData,
  });
  const counts = department ? scoped.data?.agents : view.agents;
  const rotate = useMutation({
    mutationFn: () =>
      api.rotateAll({
        confirm: typed,
        reason: reason.trim(),
        graceMinutes: overlap,
        ...(department ? { department } : {}),
      }),
    onSuccess: (r) => {
      void queryClient.invalidateQueries();
      onDone(r);
    },
  });
  const valid = typed === view.confirm && reason.trim().length >= 3;

  return (
    <Dialog title="Rotate all keys" onClose={onClose} wide>
      <form
        className="stack"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (valid) rotate.mutate();
        }}
      >
        <label className="field">
          <span>Which agents</span>
          <select
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
          >
            <option value="">Every agent</option>
            {view.departments.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="radio-list">
          <legend>When should the old keys stop working?</legend>
          {OVERLAPS.map((o) => (
            <label key={o.minutes} className="radio radio-block">
              <input
                type="radio"
                name={name}
                checked={overlap === o.minutes}
                onChange={() => setOverlap(o.minutes)}
              />
              <span>
                {o.label}
                <span className="hint block">{o.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <label className="field">
          <span>Why (kept in Activity)</span>
          <input
            value={reason}
            maxLength={500}
            placeholder="A key turned up in a public repository"
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <p className="note note-warn">
          This replaces {formatNumber(counts?.total ?? 0)}{" "}
          {counts?.total === 1 ? "key" : "keys"}
          {overlap === 0
            ? `, cuts any requests running on ${counts?.total === 1 ? "it" : "them"}, and can't be undone.`
            : ", and can't be undone."}{" "}
          {formatNumber(counts?.ownerCollects ?? 0)} owners collect their own
          when they sign in, and you download the other{" "}
          {formatNumber(counts?.adminGets ?? 0)} once.
        </p>
        <label className="field">
          <span>
            Type <strong>{view.confirm}</strong> to go ahead
          </span>
          <input
            value={typed}
            autoComplete="off"
            onChange={(e) => setTyped(e.target.value)}
          />
        </label>
        <ErrorNote error={rotate.error} />
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
            className="button button-danger"
            disabled={!valid || rotate.isPending}
          >
            {rotate.isPending ? "Rotating…" : "Rotate the keys"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function RotationDone({
  result,
  view,
  onDone,
}: {
  result: RotateAllResult;
  view: SecurityView;
  onDone: () => void;
}) {
  const [downloaded, setDownloaded] = useState(false);
  const mustDownload = result.keys.length > 0 && !downloaded;
  const oneKey = result.rotated === 1;
  const oneToSave = result.keys.length === 1;
  return (
    <section className="card stack" aria-labelledby="done-h" role="status">
      <h2 id="done-h">
        {formatNumber(result.rotated)} {oneKey ? "key" : "keys"} replaced
      </h2>
      <p>
        {result.oldKeysUntil
          ? `The old ${oneKey ? "key works" : "keys work"} until ${formatDateTime(result.oldKeysUntil)}.`
          : `The old ${oneKey ? "key has" : "keys have"} stopped working.`}
        {result.abortedRequests > 0
          ? ` ${formatNumber(result.abortedRequests)} running ${result.abortedRequests === 1 ? "request was" : "requests were"} cut.`
          : ""}
      </p>
      <h3>What to do now</h3>
      <ol className="steps">
        {result.keys.length > 0 && (
          <li>
            <div className="stack">
              <span>
                {oneToSave
                  ? "Save the 1 new key that has no owner to collect it. "
                  : `Save the ${formatNumber(result.keys.length)} new keys that have no owner to collect them. `}
                <strong>
                  This is the only time {oneToSave ? "it" : "they"} can be read.
                </strong>{" "}
                {oneToSave
                  ? "Keep it somewhere safe. If you lose it, rotate that agent."
                  : "Keep them somewhere safe. If you lose them, rotate those agents one by one."}
              </span>
              <span className="row">
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    downloadKeys(result.keys);
                    setDownloaded(true);
                  }}
                >
                  Download new keys
                </button>
                <CopyButton
                  text={keysCsv(result.keys)}
                  label="Copy instead"
                  onCopied={() => setDownloaded(true)}
                />
              </span>
            </div>
          </li>
        )}
        {result.waitingForOwners > 0 && (
          <li>
            Tell people. {formatNumber(result.waitingForOwners)} new{" "}
            {result.waitingForOwners === 1
              ? "key is waiting for its owner, who sees it when they sign in."
              : "keys are waiting for their owners, who see them when they sign in."}{" "}
            Purser doesn't send email yet.
          </li>
        )}
        <li>
          If this server or its data folder may be exposed, the keys Purser
          holds for{" "}
          {view.providers.map((p) => p.name).join(", ") || "providers"} may be
          too. Replace them under Provider keys, below.
        </li>
        <li>
          If the admin token may be exposed too, delete the file{" "}
          <code>admin-token</code> in Purser's data folder and restart Purser,
          which makes a new one.
        </li>
      </ol>
      <div className="row">
        <button
          type="button"
          className="button button-ghost"
          disabled={mustDownload}
          onClick={onDone}
        >
          Done
        </button>
        {mustDownload && (
          <span className="hint">
            Save the new {oneToSave ? "key" : "keys"} first.
          </span>
        )}
      </div>
    </section>
  );
}
