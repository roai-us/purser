import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router";
import { api } from "../api/client";
import type { Labelled } from "../api/types";
import { ErrorNote, Loading } from "../components/Notice";
import {
  ATTRIBUTION_SENTENCES,
  ATTRIBUTION_WORDS,
  ConfidenceChip,
  formatMonths,
  formatPercent,
  LabelledValue,
  thresholdText,
  VERDICT_SENTENCES,
  VerdictBadge,
} from "../components/Roi";
import { formatDate, formatNumber, formatUsd } from "../lib/format";
import "../org.css";
import "../roi.css";

const pct = (n: number) => `${formatNumber(Math.round(n * 10) / 10)}%`;

function Row({
  label,
  value,
  format,
  sub,
  empty,
}: {
  label: string;
  value: Labelled;
  format?: (n: number) => string;
  sub?: string;
  /** What to say when the value can't be worked out. */
  empty?: string;
}) {
  return (
    <tr>
      <th scope="row">
        {label}
        {sub && <span className="cell-sub">{sub}</span>}
      </th>
      <td className="num">
        <LabelledValue
          value={value}
          {...(format ? { format } : {})}
          {...(empty ? { empty } : {})}
        />
      </td>
    </tr>
  );
}

/**
 * The one-page ROI report, in the five sections of the ROAI framework: the
 * workflow and its unit, the baseline, attribution, the full cost, and the
 * net return with its caveats. Laid out to print on one page.
 */
export function RoiReportPage() {
  const { ref = "" } = useParams();
  const [search, setSearch] = useSearchParams();
  const from = search.get("from") ?? undefined;
  const to = search.get("to") ?? undefined;
  const report = useQuery({
    queryKey: ["workflow-report", ref, from, to],
    queryFn: () =>
      api.workflowReport(ref, {
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      }),
  });
  const [draftFrom, setDraftFrom] = useState(from ?? "");
  const [draftTo, setDraftTo] = useState(to ?? "");

  function apply(event: FormEvent) {
    event.preventDefault();
    const next = new URLSearchParams();
    if (draftFrom) next.set("from", draftFrom);
    if (draftTo) next.set("to", draftTo);
    setSearch(next);
  }

  if (report.isPending) return <Loading label="Building the report" />;
  if (report.isError) {
    return (
      <div className="page">
        <ErrorNote error={report.error} />
        <p>
          <Link to={`/workflows/${encodeURIComponent(ref)}`}>Back</Link>
        </p>
      </div>
    );
  }
  const { workflow: w, agents, report: r } = report.data;
  const b = w.baseline;

  return (
    <div className="page report-page">
      <div className="row between no-print">
        <Link to={`/workflows/${encodeURIComponent(w.name)}`}>
          Back to {w.name}
        </Link>
        <form className="row bottom" onSubmit={apply} aria-label="Period">
          <label className="field">
            <span>From</span>
            <input
              type="date"
              value={draftFrom}
              onChange={(e) => setDraftFrom(e.target.value)}
            />
          </label>
          <label className="field">
            <span>To</span>
            <input
              type="date"
              value={draftTo}
              onChange={(e) => setDraftTo(e.target.value)}
            />
          </label>
          <button type="submit" className="button button-soft">
            Show
          </button>
          <button
            type="button"
            className="button"
            onClick={() => window.print()}
          >
            Print
          </button>
        </form>
      </div>

      <article className="report">
        <header className="report-head">
          <p className="eyebrow">ROI report</p>
          <h1>{w.name}</h1>
          <p className="muted">
            {formatDate(r.period.from)} to {formatDate(r.period.to)} (
            {formatNumber(r.period.days)} days). Made{" "}
            {formatDate(new Date().toISOString())} by ROAI Purser.
          </p>
          <div className={`verdict-card verdict-card-${r.verdict}`}>
            <VerdictBadge verdict={r.verdict} />
            <p>{VERDICT_SENTENCES[r.verdict]}</p>
          </div>
        </header>

        <div className="report-grid">
          <section className="report-section">
            <h2>1. The workflow and its unit</h2>
            <dl className="facts report-facts">
              <div>
                <dt>One unit</dt>
                <dd>{w.unit}</dd>
              </div>
              <div>
                <dt>Owner</dt>
                <dd>
                  {w.owner}
                  {w.team ? `, ${w.team}` : ""}
                </dd>
              </div>
              <div>
                <dt>Agents</dt>
                <dd>
                  {agents.length === 0
                    ? "None linked"
                    : agents.map((a) => a.name ?? a.id).join(", ")}
                </dd>
              </div>
              <div>
                <dt>Rules locked</dt>
                <dd>
                  {w.lockedAt
                    ? formatDate(w.lockedAt)
                    : "Not yet: no results have arrived"}
                </dd>
              </div>
            </dl>
          </section>

          <section className="report-section">
            <h2>2. The baseline</h2>
            <p>
              Before the AI, one unit took {formatNumber(b.minutesPerUnit)}{" "}
              minutes at {formatUsd(b.hourlyCostUsd)} an hour:{" "}
              <LabelledValue value={r.perUnit.baseline} /> a unit
              {b.unitsPerMonth !== undefined
                ? `, about ${formatNumber(b.unitsPerMonth)} units a month`
                : ""}
              . {b.source === "measured" ? "Measured" : "Estimated"} on{" "}
              {formatDate(b.measuredOn)}: {b.method}
            </p>
          </section>

          <section className="report-section">
            <h2>3. Attribution</h2>
            <p>
              <span className="strong">
                {ATTRIBUTION_WORDS[w.attribution]}.
              </span>{" "}
              {ATTRIBUTION_SENTENCES[w.attribution]}
            </p>
            <table className="table report-table">
              <tbody>
                <tr>
                  <th scope="row">Accepted</th>
                  <td className="num">{formatNumber(r.results.accepted)}</td>
                </tr>
                <tr>
                  <th scope="row">Reworked</th>
                  <td className="num">{formatNumber(r.results.reworked)}</td>
                </tr>
                <tr>
                  <th scope="row">Discarded</th>
                  <td className="num">{formatNumber(r.results.discarded)}</td>
                </tr>
                <tr>
                  <th scope="row">Acceptance rate</th>
                  <td className="num">
                    {r.results.acceptanceRate === null ? (
                      <span className="muted">No results</span>
                    ) : (
                      formatPercent(r.results.acceptanceRate)
                    )}{" "}
                    <ConfidenceChip label="measured" />
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          <section className="report-section">
            <h2>4. The full cost</h2>
            <table className="table report-table">
              <tbody>
                <Row
                  label="AI spend"
                  value={r.cost.inference}
                  sub={`${formatNumber(r.cost.calls)} metered calls`}
                />
                <Row
                  label="Review time"
                  value={r.cost.review}
                  sub={`${formatNumber(Math.round(r.cost.review.minutes))} minutes${r.cost.review.minutesDefaulted > 0 ? `, ${formatNumber(Math.round(r.cost.review.minutesDefaulted))} of them the default` : ""}`}
                />
                <Row
                  label="Maintenance and evaluation"
                  value={r.cost.upkeep}
                  sub="For the days in this period"
                />
                <Row label="Total" value={r.cost.total} />
                <Row
                  label="Cost per accepted unit"
                  value={r.perUnit.costPerAcceptedUnit}
                  sub={`Against ${formatUsd(r.perUnit.baseline.value ?? 0)} before the AI`}
                />
              </tbody>
            </table>
          </section>
        </div>

        <section className="report-section">
          <h2>5. Net return, with caveats</h2>
          <table className="table report-table">
            <tbody>
              <Row
                label="Value of accepted work"
                value={r.value}
                sub="Accepted units at the baseline cost"
              />
              <Row label="Net return" value={r.netReturn} />
              <Row label="Net return a month" value={r.netMonthlyReturn} />
              <Row
                label="Payback"
                value={r.projection.paybackMonths}
                format={formatMonths}
                empty="Never, at this rate"
                sub={`On ${formatUsd(w.costs.implementationUsd)} to implement`}
              />
              <Row
                label="First-year ROI"
                value={r.projection.year1RoiPercent}
                format={pct}
                empty="No implementation cost to compare"
              />
              <Row
                label="Three-year present value"
                value={r.projection.threeYearNpv}
                sub={`At ${pct(w.costs.discountRate * 100)} a year`}
              />
            </tbody>
          </table>
          {r.projection.mostSensitive && (
            <p>
              The result moves most with {r.projection.mostSensitive.words}: 30%
              less of it changes the net return by{" "}
              {formatUsd(r.projection.mostSensitive.delta)} a year.
            </p>
          )}
          <p className="stop-number">
            <span className="strong">
              The number that would stop this program:
            </span>{" "}
            {thresholdText("Stop", r.thresholds.stop)}.{" "}
            {r.thresholds.stop.met ? "It is crossed." : "It is not crossed."}
            {r.thresholds.scale && (
              <>
                {" "}
                {thresholdText("Scale up", r.thresholds.scale)}:{" "}
                {r.thresholds.scale.met ? "crossed." : "not crossed."}
              </>
            )}
          </p>
          {r.caveats.length > 0 ? (
            <ul className="caveats">
              {r.caveats.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">No caveats for this period.</p>
          )}
        </section>

        <footer className="report-foot small muted">
          Labels: <ConfidenceChip label="measured" /> counted by Purser or
          reported for each result. <ConfidenceChip label="attributed" />{" "}
          measured, then put down to the AI by a comparison.{" "}
          <ConfidenceChip label="modelled" /> rests on an estimate, a default or
          a projection. Projections use the roai.us calculator's math, version{" "}
          {r.projection.calculatorVersion}.
        </footer>
      </article>
    </div>
  );
}
