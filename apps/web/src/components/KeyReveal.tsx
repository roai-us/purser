import { CopyButton } from "./CopyButton";

/** Shows an agent key once. Purser keeps only a fingerprint of it. */
export function KeyReveal({
  name,
  agentKey,
}: {
  name: string;
  agentKey: string;
}) {
  return (
    <div className="key-reveal">
      <div className="label">{name} · agent key</div>
      <code className="key-text" data-testid="agent-key">
        {agentKey}
      </code>
      <div className="row">
        <CopyButton text={agentKey} label="Copy key" />
        <span className="key-note">
          Shown once. Purser keeps only a fingerprint of it.
        </span>
      </div>
    </div>
  );
}
