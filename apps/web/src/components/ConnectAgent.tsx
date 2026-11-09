import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { meApi } from "../api/client";
import { CopyButton } from "./CopyButton";

const PLACEHOLDER = "<the agent's key>";

/**
 * How to connect an agent to Purser's MCP server. With the key to hand (just
 * after it was made) the snippets include it; otherwise they show a placeholder.
 */
export function ConnectAgent({ agentKey }: { agentKey?: string }) {
  const me = useQuery({ queryKey: ["me"], queryFn: meApi.me, retry: false });
  const [tab, setTab] = useState<"config" | "command" | "local">("config");
  if (me.data?.mcp?.enabled === false) {
    return (
      <p className="muted">
        Your admins have turned off Purser's MCP server, so agents connect with
        the provider addresses instead.
      </p>
    );
  }
  const url = me.data?.mcp?.url ?? `${window.location.origin}/mcp`;
  const origin = url.replace(/\/mcp$/, "");
  const key = agentKey ?? PLACEHOLDER;
  const config = JSON.stringify(
    {
      mcpServers: {
        purser: {
          type: "http",
          url,
          headers: { Authorization: `Bearer ${key}` },
        },
      },
    },
    null,
    2,
  );
  const command = `claude mcp add --transport http purser ${url} --header "Authorization: Bearer ${key}"`;
  const local = JSON.stringify(
    {
      mcpServers: {
        purser: {
          command: "roai",
          args: ["mcp"],
          env: { PURSER_URL: origin, PURSER_AGENT_KEY: key },
        },
      },
    },
    null,
    2,
  );
  const shown = tab === "config" ? config : tab === "command" ? command : local;
  const tabs = [
    ["config", "Most tools"],
    ["command", "Claude Code"],
    ["local", "Local programs only"],
  ] as const;

  return (
    <div className="stack connection">
      <p className="muted">
        The agent can see its own services, limits and spending, ask another
        model for a second opinion, and ask a person for more. Everything counts
        toward its limits, and stopping it stops all of this too.
      </p>
      <div className="tabs" role="tablist" aria-label="MCP setup">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "tab tab-on" : "tab"}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="stack" role="tabpanel">
        <pre className="code-block">{shown}</pre>
        <div className="row">
          <CopyButton text={shown} label="Copy" />
          {!agentKey && (
            <span className="hint">
              Put the agent's key in place of {PLACEHOLDER}. Lost it? Rotate the
              key to get a new one.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
