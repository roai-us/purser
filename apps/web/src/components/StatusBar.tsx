import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router";
import { api, meApi } from "../api/client";
import type { StoppedAgent } from "../api/types";
import { formatNumber, formatRelative, STATE_REASONS } from "../lib/format";
import { LIGHT_CLASS, lightOf } from "./StatusLight";

/** How many red lights to draw before "and N more". */
export const MAX_LIGHTS = 60;
/** How often the bar checks for changes, in milliseconds. */
const REFRESH_MS = 10_000;

/** "hr-helper is stopped (by admin, 2 hours ago)" */
export function describeStopped(agent: StoppedAgent): string {
  const details = [
    agent.by ? `by ${agent.by}` : undefined,
    agent.since ? formatRelative(agent.since) : undefined,
  ].filter(Boolean);
  return `${agent.name} is ${STATE_REASONS[agent.state]}${
    details.length > 0 ? ` (${details.join(", ")})` : ""
  }`;
}

/**
 * The fleet at a glance, on every page: how many agents are running, and a
 * light for each one that isn't: yellow at a spending limit, red stopped.
 * Clicking a light opens that agent.
 */
export function StatusBar({
  source = "admin",
}: {
  /** Whose agents: every agent, the departments a manager runs, or your own. */
  source?: "admin" | "team" | "mine";
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [focused, setFocused] = useState<StoppedAgent | null>(null);
  const status = useQuery({
    queryKey: ["status", source],
    queryFn: () =>
      source === "admin" ? api.status(MAX_LIGHTS) : meApi.status(source),
    refetchInterval: REFRESH_MS,
  });

  const board = status.data;
  if (!board || board.total === 0) return null;

  function open(id: string) {
    // On the agents page keep its search and filters; elsewhere start fresh.
    const params = new URLSearchParams(
      location.pathname === "/agents" ? location.search : "",
    );
    params.set("agent", id);
    void navigate(`/agents?${params.toString()}`);
  }

  if (board.notRunning === 0) {
    return (
      <section className="status-bar all-clear" aria-label="Agent status">
        <span className="light light-on" aria-hidden="true" />
        <span>
          {board.total === 1
            ? "1 agent is running."
            : `All ${formatNumber(board.total)} agents are running.`}
        </span>
      </section>
    );
  }

  const more = board.notRunning - board.stopped.length;
  const red = board.notRunning - board.atLimit;
  return (
    <section className="status-bar" aria-label="Agent status">
      <div className="status-summary">
        <Link className="status-count" to="/agents?light=green">
          <span className={LIGHT_CLASS.green} aria-hidden="true" />
          <strong>{formatNumber(board.running)}</strong> running
        </Link>
        {board.atLimit > 0 && (
          <Link className="status-count" to="/agents?light=yellow">
            <span className={LIGHT_CLASS.yellow} aria-hidden="true" />
            <strong>{formatNumber(board.atLimit)}</strong> at limit
          </Link>
        )}
        {red > 0 && (
          <Link className="status-count" to="/agents?light=red">
            <span className={LIGHT_CLASS.red} aria-hidden="true" />
            <strong>{formatNumber(red)}</strong> stopped
          </Link>
        )}
        <span className="status-caption" aria-hidden="true">
          {focused
            ? describeStopped(focused)
            : "Click a light to open that agent."}
        </span>
      </div>
      <ul
        className="status-lights"
        aria-label="Agents that are not running"
        onMouseLeave={() => setFocused(null)}
      >
        {board.stopped.map((agent) => (
          <li key={agent.id}>
            <button
              type="button"
              className="light-button"
              aria-label={describeStopped(agent)}
              onClick={() => open(agent.id)}
              onMouseEnter={() => setFocused(agent)}
              onFocus={() => setFocused(agent)}
              onBlur={() => setFocused(null)}
            >
              <span
                className={LIGHT_CLASS[lightOf(agent.state)]}
                aria-hidden="true"
              />
            </button>
          </li>
        ))}
        {more > 0 && (
          <li>
            <Link className="status-more" to="/agents?state=not_running">
              and {formatNumber(more)} more
            </Link>
          </li>
        )}
      </ul>
    </section>
  );
}
