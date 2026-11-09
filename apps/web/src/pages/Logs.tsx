import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { api } from "../api/client";
import type { CallEntry } from "../api/types";
import { ErrorNote, Loading } from "../components/Notice";
import { formatDateTime, formatUsd } from "../lib/format";
import { useDebounced } from "../lib/hooks";

const PAGE = 50;

/** One turn of a conversation, for showing a request as people read it. */
export interface Turn {
  role: string;
  text: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function partsText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (!isObject(p)) return "";
        if (typeof p.text === "string") return p.text;
        return `[${typeof p.type === "string" ? p.type : "part"}]`;
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * The conversation in a request body: the system prompt and each message,
 * for chat, messages and responses shapes. Null when it isn't one of those.
 */
export function turnsOf(body: string): Turn[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  const turns: Turn[] = [];
  const system = partsText(parsed.system) || partsText(parsed.instructions);
  if (system) turns.push({ role: "system", text: system });
  const list = Array.isArray(parsed.messages)
    ? parsed.messages
    : Array.isArray(parsed.input)
      ? parsed.input
      : null;
  if (list) {
    for (const m of list) {
      if (!isObject(m)) continue;
      turns.push({
        role: typeof m.role === "string" ? m.role : "message",
        text: partsText(m.content),
      });
    }
  } else if (typeof parsed.input === "string") {
    turns.push({ role: "user", text: parsed.input });
  } else if (typeof parsed.prompt === "string") {
    turns.push({ role: "user", text: parsed.prompt });
  }
  return turns.length > 0 ? turns : null;
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

const RESULT = (r: { outcome: string; status: number }) =>
  r.outcome === "complete"
    ? r.status >= 400
      ? `Error ${r.status}`
      : "Done"
    : r.outcome === "aborted"
      ? "Cut off"
      : `Error ${r.status}`;

/** Every logged call, newest first, and what was said in each. */
export function LogsPage() {
  const [params, setParams] = useSearchParams();
  const agent = params.get("agent") ?? "";
  const call = params.get("call");
  const [text, setText] = useState(agent);
  const debounced = useDebounced(text, 400);

  const set = (key: string, value: string | null) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );

  useEffect(() => {
    if (debounced !== agent) set("agent", debounced || null);
    // Keyed on the debounced text alone, as on the agents page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const logs = useInfiniteQuery({
    queryKey: ["logs", agent],
    queryFn: ({ pageParam }) =>
      api.logs({
        limit: PAGE,
        ...(pageParam ? { before: pageParam } : {}),
        ...(agent ? { agent } : {}),
      }),
    initialPageParam: "",
    getNextPageParam: (last) => last.next,
  });

  const items = logs.data?.pages.flatMap((p) => p.items) ?? [];
  const settings = logs.data?.pages[0]?.settings;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Call log</h1>
          <p className="muted">
            What agents sent and what came back, newest first.
          </p>
        </div>
        <Link className="button button-soft" to="/settings">
          Log settings
        </Link>
      </header>

      {settings?.mode === "off" && (
        <p className="note note-info">
          The call log is off, so only calls from when it was on are here.
          Purser still records the cost and tokens of every call. Turn it on in{" "}
          <Link to="/settings">Settings</Link>.
        </p>
      )}
      {settings && settings.mode !== "off" && (
        <p className="muted small">
          {settings.mode === "all"
            ? "Every agent's calls are kept"
            : "Calls from the agents you chose are kept"}{" "}
          for {settings.retentionDays} days, then deleted. Opening a call is
          recorded in Activity.
        </p>
      )}

      <div className="filters">
        <label className="field">
          <span>Agent</span>
          <input
            value={text}
            placeholder="All agents (name or ID)"
            onChange={(e) => setText(e.target.value.trim())}
          />
        </label>
      </div>

      <div className="card flush">
        {logs.isPending ? (
          <Loading label="Loading calls" />
        ) : logs.isError ? (
          <ErrorNote error={logs.error} />
        ) : items.length === 0 ? (
          <p className="empty">No calls logged yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table logs-table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Agent</th>
                  <th scope="col">Asked</th>
                  <th scope="col">Answer</th>
                  <th scope="col">Model</th>
                  <th scope="col">Cost</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr
                    key={r.id}
                    className={call === r.id ? "row-selected" : undefined}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest("button,a")) return;
                      set("call", r.id);
                    }}
                  >
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => set("call", r.id)}
                      >
                        {formatDateTime(r.at)}
                      </button>
                    </td>
                    <td>{r.agentName}</td>
                    <td className="clip">
                      {r.requestPreview || <span className="muted">None</span>}
                    </td>
                    <td className="clip">
                      {r.responsePreview || <span className="muted">None</span>}
                    </td>
                    <td className="mono small">{r.model}</td>
                    <td>{formatUsd(r.costUsd)}</td>
                    <td>{RESULT(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {logs.hasNextPage && (
        <div className="row">
          <button
            type="button"
            className="button button-ghost"
            disabled={logs.isFetchingNextPage}
            onClick={() => void logs.fetchNextPage()}
          >
            {logs.isFetchingNextPage ? "Loading…" : "Older calls"}
          </button>
        </div>
      )}

      {call && <CallDetail id={call} onClose={() => set("call", null)} />}
    </div>
  );
}

function CallDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const entry = useQuery({
    queryKey: ["log", id],
    queryFn: () => api.log(id),
    staleTime: Infinity,
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className="panel" aria-label="Call details">
      <div className="panel-head">
        <h2>Call</h2>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Close call"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" className="stroke" />
          </svg>
        </button>
      </div>
      {entry.isPending ? (
        <Loading />
      ) : entry.isError ? (
        <div className="panel-body">
          <ErrorNote error={entry.error} />
        </div>
      ) : (
        <CallBody entry={entry.data} />
      )}
    </aside>
  );
}

function CallBody({ entry }: { entry: CallEntry }) {
  const turns = turnsOf(entry.request);
  return (
    <div className="panel-body">
      <dl className="facts">
        <div>
          <dt>Agent</dt>
          <dd>
            <Link to={`/agents?agent=${encodeURIComponent(entry.agentId)}`}>
              {entry.agentName}
            </Link>
          </dd>
        </div>
        <div>
          <dt>When</dt>
          <dd>{formatDateTime(entry.at)}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd className="mono">{entry.model}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>{formatUsd(entry.costUsd)}</dd>
        </div>
        <div>
          <dt>Result</dt>
          <dd>{RESULT(entry)}</dd>
        </div>
        <div>
          <dt>Took</dt>
          <dd>{(entry.durationMs / 1000).toFixed(1)} s</dd>
        </div>
      </dl>
      {entry.truncated && (
        <p className="note note-warn">
          This call was longer than the log's size limit, so the end is cut off.
        </p>
      )}
      <section className="stack" aria-labelledby="req-h">
        <h3 id="req-h">Request</h3>
        {turns ? (
          <ol className="turns">
            {turns.map((t, i) => (
              <li key={i} className={`turn turn-${t.role}`}>
                <span className="turn-role">{t.role}</span>
                <p className="turn-text">{t.text || "(no text)"}</p>
              </li>
            ))}
          </ol>
        ) : null}
        <details>
          <summary>Raw request</summary>
          <pre className="raw">{pretty(entry.request)}</pre>
        </details>
      </section>
      <section className="stack" aria-labelledby="res-h">
        <h3 id="res-h">Response</h3>
        {entry.responseText ? (
          <div className="turn turn-assistant">
            <span className="turn-role">answer</span>
            <p className="turn-text">{entry.responseText}</p>
          </div>
        ) : (
          <p className="muted">No text in the response.</p>
        )}
        <details>
          <summary>Raw response</summary>
          <pre className="raw">{pretty(entry.response)}</pre>
        </details>
      </section>
    </div>
  );
}
