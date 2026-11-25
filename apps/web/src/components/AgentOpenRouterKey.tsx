import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Agent, AgentOpenRouterKey } from "../api/types";
import { formatDateTime, formatUsd } from "../lib/format";
import { ErrorNote } from "./Notice";

function limitWords(key: AgentOpenRouterKey): string {
  if (key.limit === null) return "No limit at OpenRouter";
  return `${formatUsd(key.limit)} a ${key.limitReset === "daily" ? "day" : "month"}`;
}

/**
 * The agent's own OpenRouter key, for admins, when per-agent keys are on:
 * what OpenRouter enforces for it, what OpenRouter says it spent, and a way
 * to replace a key that broke.
 */
export function AgentOpenRouterKeySection({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const view = useQuery({
    queryKey: ["agent-openrouter-key", agent.id],
    queryFn: () => api.agentOpenRouterKey(agent.id),
  });
  const replace = useMutation({
    mutationFn: () => api.replaceAgentOpenRouterKey(agent.id),
    onSuccess: (next) => {
      queryClient.setQueryData(["agent-openrouter-key", agent.id], next);
      void queryClient.invalidateQueries({ queryKey: ["openrouter-keys"] });
    },
  });
  const v = view.data;
  if (!v?.enabled) return null;
  const key = v.key;
  const spentHere = agent.serviceSpend?.openrouter;

  return (
    <section className="stack" aria-labelledby="orkey-h">
      <h3 id="orkey-h">OpenRouter key</h3>
      {!key ? (
        <p className="muted">
          {v.failure
            ? `No key yet: ${v.failure} Purser tries again every hour; until then its calls use the shared key.`
            : "This agent gets its own OpenRouter key when it first uses OpenRouter. Until then its calls use the shared key."}
        </p>
      ) : (
        <>
          <dl className="facts compact">
            <div>
              <dt>Key</dt>
              <dd className="mono">{key.label}</dd>
            </div>
            <div>
              <dt>OpenRouter enforces</dt>
              <dd>
                {limitWords(key)}
                {key.expiresAt
                  ? `, until ${formatDateTime(key.expiresAt)}`
                  : ""}
              </dd>
            </div>
            <div>
              <dt>At OpenRouter</dt>
              <dd>
                {key.disabled
                  ? "Disabled, because the agent is stopped"
                  : "Enabled"}
              </dd>
            </div>
            {key.usage && (
              <div>
                <dt>OpenRouter says it spent</dt>
                <dd>
                  {formatUsd(key.usage.today)} today,{" "}
                  {formatUsd(key.usage.month)} this month
                  {spentHere
                    ? ` (Purser metered ${formatUsd(spentHere.today)} and ${formatUsd(spentHere.month)})`
                    : ""}
                </dd>
              </div>
            )}
          </dl>
          {key.problem && (
            <p className="note note-error" role="alert">
              {key.problem}
            </p>
          )}
        </>
      )}
      {(key?.broken || (key && key.problem) || v.failure) && (
        <div className="row">
          <button
            type="button"
            className="button button-soft"
            disabled={replace.isPending}
            onClick={() => replace.mutate()}
          >
            {replace.isPending
              ? "Making a new key…"
              : key
                ? "Replace the key"
                : "Make the key now"}
          </button>
        </div>
      )}
      <ErrorNote error={replace.error} />
    </section>
  );
}
