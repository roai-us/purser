import type { DailyUsage } from "../api/types";
import { formatDate, formatUsd } from "../lib/format";

/** Daily spend as bars, with the same numbers in a table for screen readers. */
export function SpendChart({ daily }: { daily: DailyUsage[] }) {
  if (daily.length === 0) {
    return <p className="muted">No spending in the last 30 days.</p>;
  }
  const max = Math.max(...daily.map((d) => d.costUsd), 0.0001);
  const width = 100 / daily.length;
  const total = daily.reduce((sum, d) => sum + d.costUsd, 0);
  return (
    <figure className="chart">
      <svg
        viewBox="0 0 100 40"
        preserveAspectRatio="none"
        className="chart-svg"
        aria-hidden="true"
      >
        {daily.map((d, i) => {
          const h = (d.costUsd / max) * 38;
          return (
            <rect
              key={d.date}
              x={i * width + width * 0.15}
              y={40 - h}
              width={width * 0.7}
              height={h}
              className="chart-bar"
            />
          );
        })}
      </svg>
      <figcaption className="muted">
        {formatUsd(total)} over {daily.length} days
      </figcaption>
      <details className="chart-table">
        <summary>Show as a table</summary>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Spent</th>
              <th scope="col">Requests</th>
            </tr>
          </thead>
          <tbody>
            {daily.map((d) => (
              <tr key={d.date}>
                <td>{formatDate(d.date)}</td>
                <td>{formatUsd(d.costUsd)}</td>
                <td>{d.requests}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
