import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../api/client";
import type { OpenRouterKeysView } from "../api/types";
import { ErrorNote } from "./Notice";

export const OPENROUTER_KEYS_DOC =
  "https://github.com/roai-us/purser/blob/main/docs/openrouter-keys.md";

/**
 * Per-agent OpenRouter keys, on OpenRouter's card on the Providers page: the
 * management key, the switch, and any keys that need a person.
 */
export function OpenRouterAgentKeys({ connected }: { connected: boolean }) {
  const queryClient = useQueryClient();
  const view = useQuery({
    queryKey: ["openrouter-keys"],
    queryFn: api.openRouterKeys,
  });
  const [key, setKey] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);
  const settle = (next: OpenRouterKeysView) => {
    queryClient.setQueryData(["openrouter-keys"], next);
    // Keys are made and deleted in the background; look again shortly.
    setTimeout(
      () =>
        void queryClient.invalidateQueries({ queryKey: ["openrouter-keys"] }),
      1500,
    );
  };
  const saveKey = useMutation({
    mutationFn: () => api.saveOpenRouterManagementKey(key.trim()),
    onSuccess: (next) => {
      setKey("");
      settle(next);
    },
  });
  const removeKey = useMutation({
    mutationFn: api.removeOpenRouterManagementKey,
    onSuccess: settle,
  });
  const toggle = useMutation({
    mutationFn: api.setOpenRouterAgentKeys,
    onSuccess: (next) => {
      setConfirmOff(false);
      settle(next);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (key.trim()) saveKey.mutate();
  }

  if (!view.data) {
    return <ErrorNote error={view.error} />;
  }
  const v = view.data;

  return (
    <details className="connect-info" open={v.enabled || undefined}>
      <summary>
        Per-agent keys{" "}
        <span
          className={v.enabled ? "badge badge-running" : "badge badge-plain"}
        >
          {v.enabled ? "On" : "Off"}
        </span>
      </summary>
      <div className="stack">
        <p className="hint">
          Give each agent its own OpenRouter key, with its cap and end date set
          at OpenRouter too. Stopping an agent then also disables its key there,
          a second layer of stop. Agents keep calling Purser as before.{" "}
          <a href={OPENROUTER_KEYS_DOC} target="_blank" rel="noreferrer">
            How it works
          </a>
        </p>

        {!v.managementKey.set ? (
          <form className="key-form" onSubmit={submit}>
            <div className="row bottom">
              <label className="field grow">
                <span>Paste an OpenRouter management key</span>
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  className="mono"
                  value={key}
                  placeholder="sk-or-v1-"
                  onChange={(e) => setKey(e.target.value)}
                />
              </label>
              <button
                type="submit"
                className="button"
                disabled={saveKey.isPending || !key.trim()}
              >
                {saveKey.isPending ? "Checking…" : "Save"}
              </button>
            </div>
            <p className="hint">
              Make one at OpenRouter under Settings, Management keys. It can
              make and change keys but can&apos;t call models. Purser checks it
              first, keeps it in the vault and never shows it again.
            </p>
            <ErrorNote error={saveKey.error} />
          </form>
        ) : (
          <>
            <dl className="facts compact">
              <div>
                <dt>Management key</dt>
                <dd className="mono">{v.managementKey.hint ?? "Saved"}</dd>
              </div>
              <div>
                <dt>Agents with their own key</dt>
                <dd>{v.keys}</dd>
              </div>
            </dl>
            {v.problems.length > 0 && (
              <div className="note note-error" role="alert">
                <p className="strong">
                  {v.problems.length === 1
                    ? "One agent's key needs a look"
                    : `${v.problems.length} agents' keys need a look`}
                </p>
                <ul className="plain-list">
                  {v.problems.map((p) => (
                    <li key={p.agentId}>
                      <Link
                        to={`/agents?agent=${encodeURIComponent(p.agentId)}`}
                      >
                        {p.agentName}
                      </Link>
                      : {p.problem}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="row">
              {!v.enabled ? (
                <>
                  <button
                    type="button"
                    className="button"
                    disabled={toggle.isPending || !connected}
                    onClick={() => toggle.mutate(true)}
                  >
                    Turn on per-agent keys
                  </button>
                  <button
                    type="button"
                    className="link-button"
                    disabled={removeKey.isPending}
                    onClick={() => removeKey.mutate()}
                  >
                    Remove management key
                  </button>
                </>
              ) : confirmOff ? (
                <>
                  <button
                    type="button"
                    className="button button-dark"
                    disabled={toggle.isPending}
                    onClick={() => toggle.mutate(false)}
                  >
                    Turn off and delete the keys
                  </button>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setConfirmOff(false)}
                  >
                    Keep them
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="button button-soft"
                  onClick={() => setConfirmOff(true)}
                >
                  Turn off
                </button>
              )}
            </div>
            {!connected && !v.enabled && (
              <p className="hint">Connect OpenRouter above first.</p>
            )}
            {confirmOff && (
              <p className="note note-error">
                Purser deletes every key it made at OpenRouter, and agents go
                back to the shared key.
              </p>
            )}
            <ErrorNote error={toggle.error ?? removeKey.error} />
          </>
        )}
      </div>
    </details>
  );
}
