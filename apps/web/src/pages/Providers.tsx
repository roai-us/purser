import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Connector } from "../api/types";
import { CopyButton } from "../components/CopyButton";
import { ErrorNote, Loading } from "../components/Notice";
import { ProviderKeyForm } from "../components/ProviderKeyForm";
import { formatDateTime } from "../lib/format";

export const CONNECTORS_DOC =
  "https://github.com/roai-us/purser/blob/main/docs/connectors.md";

export function ProvidersPage() {
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: api.providers,
  });

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Providers</h1>
          <p className="muted">
            The AI accounts Purser holds keys for. Your tools never see these
            keys. They get their own agent keys instead.
          </p>
        </div>
      </header>
      {providers.isPending ? (
        <Loading />
      ) : providers.isError ? (
        <ErrorNote error={providers.error} />
      ) : (
        <div className="provider-grid">
          {providers.data.map((c) => (
            <ProviderCard key={c.id} connector={c} />
          ))}
        </div>
      )}
      <p className="note note-info">
        Need a provider that isn't listed?{" "}
        <a href={CONNECTORS_DOC} target="_blank" rel="noreferrer">
          Custom connectors
        </a>{" "}
        explains how to add your own.
      </p>
    </div>
  );
}

function ProviderCard({ connector: c }: { connector: Connector }) {
  const queryClient = useQueryClient();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const test = useMutation({
    mutationFn: () => api.testProvider(c.id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["providers"] }),
  });
  const remove = useMutation({
    mutationFn: () => api.removeProviderKey(c.id),
    onSuccess: () => {
      setConfirmRemove(false);
      void queryClient.invalidateQueries();
    },
  });
  const last = test.data
    ? { ...test.data, at: test.data.at ?? new Date().toISOString() }
    : c.lastTest;

  return (
    <section className="card provider" aria-labelledby={`p-${c.id}`}>
      <div className="card-head">
        <h2 id={`p-${c.id}`}>{c.name}</h2>
        <div className="row">
          <span className="badge badge-plain">
            {c.source === "custom" ? "Custom" : "Built in"}
          </span>
          {c.configured ? (
            <span className="badge badge-running">Connected</span>
          ) : (
            <span className="badge badge-paused">Not connected</span>
          )}
        </div>
      </div>

      {c.configured && (
        <dl className="facts compact">
          <div>
            <dt>Key</dt>
            <dd className="mono">{c.keyHint ?? "Saved"}</dd>
          </div>
          <div>
            <dt>Kept in</dt>
            <dd>
              {c.keySource === "env"
                ? "An environment variable"
                : "Purser's vault on this computer"}
            </dd>
          </div>
          <div>
            <dt>Last test</dt>
            <dd>
              {last
                ? `${last.ok ? "Worked" : `Failed: ${last.error ?? "no answer"}`}${last.at ? `, ${formatDateTime(last.at)}` : ""}${last.latencyMs !== undefined ? ` (${Math.round(last.latencyMs)} ms)` : ""}`
                : "Not tested yet"}
            </dd>
          </div>
          <div>
            <dt>Cost comes from</dt>
            <dd>
              {c.costSource === "provider"
                ? "The provider's own bill"
                : "Purser's price table"}
            </dd>
          </div>
        </dl>
      )}

      {c.keySource !== "env" && <ProviderKeyForm connector={c} />}

      {c.configured && (
        <div className="row">
          <button
            type="button"
            className="button button-soft"
            disabled={test.isPending}
            onClick={() => test.mutate()}
          >
            {test.isPending ? "Testing…" : "Test again"}
          </button>
          {c.keySource !== "env" &&
            (confirmRemove ? (
              <>
                <button
                  type="button"
                  className="button button-dark"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  Remove the key
                </button>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setConfirmRemove(false)}
                >
                  Keep it
                </button>
              </>
            ) : (
              <button
                type="button"
                className="link-button"
                onClick={() => setConfirmRemove(true)}
              >
                Remove key
              </button>
            ))}
        </div>
      )}
      {confirmRemove && (
        <p className="note note-error">
          Every agent using {c.name} stops working until you add a key again.
        </p>
      )}
      <ErrorNote error={test.error ?? remove.error} />

      <details className="connect-info">
        <summary>How tools connect</summary>
        <div className="stack">
          <div className="value-row">
            <div>
              <div className="value-label">Address for your tools</div>
              <code className="value">{c.agentBaseUrl}</code>
            </div>
            <CopyButton text={c.agentBaseUrl} what={`${c.name} address`} />
          </div>
          <p className="hint">
            In code, set <code>{c.envHint.baseUrlVar}</code> to this address and{" "}
            <code>{c.envHint.apiKeyVar}</code> to the agent's own key.
          </p>
          {c.docsUrl && (
            <a href={c.docsUrl} target="_blank" rel="noreferrer">
              {c.name} documentation
            </a>
          )}
        </div>
      </details>
    </section>
  );
}
