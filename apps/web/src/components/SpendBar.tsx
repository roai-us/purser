import { formatUsd } from "../lib/format";

/** Spend against a limit. Drawn with SVG so it needs no inline styles. */
export function SpendBar({
  spent,
  limit,
}: {
  spent: number;
  limit?: number | undefined;
}) {
  if (!limit) {
    return (
      <span className="spend">
        {formatUsd(spent)} <span className="muted">no daily limit</span>
      </span>
    );
  }
  const pct = Math.max(0, Math.min(100, (spent / limit) * 100));
  const tone = pct >= 100 ? "full" : pct >= 80 ? "high" : "ok";
  return (
    <span className="spend">
      <span className="spend-text">
        {formatUsd(spent)} <span className="muted">of {formatUsd(limit)}</span>
      </span>
      <svg
        className="spend-bar"
        viewBox="0 0 100 8"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <rect width="100" height="8" rx="4" className="spend-track" />
        <rect width={pct} height="8" rx="4" className={`spend-fill ${tone}`} />
      </svg>
    </span>
  );
}
