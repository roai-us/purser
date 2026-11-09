import { useState } from "react";
import type { Connector } from "../api/types";
import { CopyButton } from "./CopyButton";

/** The two values a tool needs: where to send requests, and which key. */
export function ConnectionValues({
  connector,
  agentKey,
}: {
  connector: Connector;
  agentKey: string;
}) {
  const [tab, setTab] = useState<"app" | "code">("app");
  const env = `${connector.envHint.baseUrlVar}=${connector.agentBaseUrl}\n${connector.envHint.apiKeyVar}=${agentKey}`;
  return (
    <div className="connection">
      <div
        className="tabs"
        role="tablist"
        aria-label={`${connector.name} setup`}
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "app"}
          className={tab === "app" ? "tab tab-on" : "tab"}
          onClick={() => setTab("app")}
        >
          In an app's settings
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "code"}
          className={tab === "code" ? "tab tab-on" : "tab"}
          onClick={() => setTab("code")}
        >
          In code or a terminal
        </button>
      </div>
      {tab === "app" ? (
        <div className="stack" role="tabpanel">
          <div className="value-row">
            <div>
              <div className="value-label">
                Address{" "}
                <span className="muted">
                  (may be called Base URL, API host or Endpoint)
                </span>
              </div>
              <code className="value">{connector.agentBaseUrl}</code>
            </div>
            <CopyButton text={connector.agentBaseUrl} what="address" />
          </div>
          <div className="value-row">
            <div>
              <div className="value-label">API key</div>
              <code className="value">{agentKey}</code>
            </div>
            <CopyButton text={agentKey} what="API key" />
          </div>
        </div>
      ) : (
        <div className="stack" role="tabpanel">
          <pre className="code-block">{env}</pre>
          <div className="row">
            <CopyButton text={env} label="Copy both lines" />
            <span className="hint">
              Most AI libraries and coding tools read these two settings.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
