import type { KeyState } from "../api/types";
import { formatDateTime, formatRelative } from "../lib/format";

/** When the key expires, styled by how soon. */
export function KeyExpiry({
  expiresAt,
  state,
}: {
  expiresAt?: string | undefined;
  state: KeyState;
}) {
  if (!expiresAt) return <span className="muted">Never</span>;
  const text =
    state === "expired"
      ? `Expired ${formatRelative(expiresAt)}`
      : formatRelative(expiresAt);
  return (
    <span
      className={`key-expiry key-${state}`}
      title={formatDateTime(expiresAt)}
    >
      {state === "expiring" && (
        <span className="visually-hidden">Expiring soon: </span>
      )}
      {text}
    </span>
  );
}
