import { useState } from "react";
import { sendTestRequest, type TestRequestResult } from "../api/client";
import type { Connector } from "../api/types";
import { formatUsd } from "../lib/format";

/** Sends one tiny request through Purser with the agent's own key. */
export function TestRequest({
  connector,
  agentKey,
}: {
  connector: Connector;
  agentKey: string;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestRequestResult | null>(null);

  if (result?.ok) {
    return (
      <div className="test-ok" role="status">
        <p className="ok-line">Connected</p>
        <dl className="mini-stats">
          {result.model && (
            <div>
              <dt>Model</dt>
              <dd>{result.model}</dd>
            </div>
          )}
          {result.costUsd !== undefined && (
            <div>
              <dt>Cost</dt>
              <dd>{formatUsd(result.costUsd)}</dd>
            </div>
          )}
        </dl>
        <p className="muted small">It counts against this agent's limits.</p>
      </div>
    );
  }

  return (
    <div className="stack">
      <p className="waiting">Waiting for the first request…</p>
      <p className="muted">
        Use the tool once as you normally would, or send a tiny test request
        yourself. It costs less than a cent.
      </p>
      {result?.error && (
        <p className="note note-error" role="alert">
          {result.error}
        </p>
      )}
      <div>
        <button
          type="button"
          className="button"
          disabled={busy || !connector.testModel}
          onClick={async () => {
            setBusy(true);
            setResult(await sendTestRequest(connector, agentKey));
            setBusy(false);
          }}
        >
          {busy ? "Sending…" : "Send a test request"}
        </button>
      </div>
    </div>
  );
}
