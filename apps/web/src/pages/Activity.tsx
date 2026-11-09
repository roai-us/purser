import { useEffect, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { api } from "../api/client";
import { ErrorNote, Loading } from "../components/Notice";
import { eventLabel, eventSummary, formatDateTime } from "../lib/format";
import { useDebounced } from "../lib/hooks";

const PAGE = 100;

export function ActivityPage() {
  const [params, setParams] = useSearchParams();
  const agent = params.get("agent") ?? "";
  const [text, setText] = useState(agent);
  const debounced = useDebounced(text, 400);

  useEffect(() => {
    if (debounced === agent) return;
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (debounced) next.set("agent", debounced);
        else next.delete("agent");
        return next;
      },
      { replace: true },
    );
  }, [debounced, agent, setParams]);

  const audit = useInfiniteQuery({
    queryKey: ["audit", agent],
    queryFn: ({ pageParam }) =>
      api.audit({
        limit: PAGE,
        ...(pageParam ? { before: pageParam } : {}),
        ...(agent ? { agent } : {}),
      }),
    initialPageParam: "",
    getNextPageParam: (last) => last.next,
  });

  const events = audit.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Activity</h1>
          <p className="muted">
            Everything Purser has done or refused, newest first.
          </p>
        </div>
      </header>
      <div className="filters">
        <label className="field">
          <span>Agent ID</span>
          <input
            value={text}
            placeholder="All agents"
            onChange={(e) => setText(e.target.value.trim())}
          />
        </label>
      </div>
      <div className="card flush">
        {audit.isPending ? (
          <Loading />
        ) : audit.isError ? (
          <ErrorNote error={audit.error} />
        ) : events.length === 0 ? (
          <p className="empty">Nothing to show yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">What happened</th>
                  <th scope="col">Agent</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event, i) => (
                  <tr key={`${event.at}-${i}`}>
                    <td>{formatDateTime(event.at)}</td>
                    <td>{eventLabel(event.type)}</td>
                    <td>
                      {event.agentId ? (
                        <Link
                          to={`/agents?agent=${encodeURIComponent(event.agentId)}`}
                          className="mono"
                        >
                          {event.agentId}
                        </Link>
                      ) : (
                        <span className="muted">None</span>
                      )}
                    </td>
                    <td className="muted">{eventSummary(event.detail)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {audit.hasNextPage && (
        <div className="row center">
          <button
            type="button"
            className="button button-ghost"
            disabled={audit.isFetchingNextPage}
            onClick={() => void audit.fetchNextPage()}
          >
            {audit.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
