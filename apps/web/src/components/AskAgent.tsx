import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { meApi } from "../api/client";
import type { AskResult, Me } from "../api/types";
import { formatUsd } from "../lib/format";
import { parseMoney } from "./AgentForm";
import { ConnectAgent } from "./ConnectAgent";
import { ConnectionValues } from "./ConnectionValues";
import { Dialog } from "./Dialog";
import { KeyReveal } from "./KeyReveal";
import { ErrorNote } from "./Notice";

/**
 * An employee asks for an agent. Within their department's auto-approve
 * limit it is ready at once and they see its key; above it, the request goes
 * to their department's managers.
 */
export function AskAgentDialog({
  me,
  onClose,
}: {
  me: Me;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { policy } = me;
  const providers = me.providers.filter(
    (p) => !policy.allowedProviders || policy.allowedProviders.includes(p.id),
  );
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [provider, setProvider] = useState(
    providers.length === 1 ? (providers[0]?.id ?? "") : "",
  );
  const [daily, setDaily] = useState(
    String(policy.autoApproveDailyUsd > 0 ? policy.autoApproveDailyUsd : 1),
  );
  const [monthly, setMonthly] = useState("");
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<AskResult | null>(null);

  const dailyUsd = parseMoney(daily);
  const monthlyUsd = parseMoney(monthly);
  const overMax = dailyUsd !== undefined && dailyUsd > policy.maxDailyUsd;
  const needsOk =
    dailyUsd !== undefined && dailyUsd > policy.autoApproveDailyUsd;
  const valid =
    name.trim() !== "" &&
    purpose.trim().length >= 3 &&
    dailyUsd !== undefined &&
    dailyUsd >= 0.01 &&
    !overMax;

  const ask = useMutation({
    mutationFn: () =>
      meApi.ask({
        name: name.trim(),
        purpose: purpose.trim(),
        dailyUsd: dailyUsd ?? 0,
        ...(provider ? { providers: [provider] } : {}),
        ...(monthlyUsd !== undefined ? { monthlyUsd } : {}),
        ...(needsOk && reason.trim() ? { reason: reason.trim() } : {}),
      }),
    onSuccess: (r) => {
      setResult(r);
      void queryClient.invalidateQueries();
    },
  });

  if (result?.status === "ready") {
    const targets = me.providers.filter(
      (c) =>
        !result.agent.providers?.length ||
        result.agent.providers.includes(c.id),
    );
    return (
      <Dialog title={`${result.agent.name} is ready`} onClose={onClose} wide>
        <div className="stack">
          <KeyReveal name={result.agent.name} agentKey={result.key} />
          {targets.map((c) => (
            <section key={c.id} className="stack">
              <h3>Connect through {c.name}</h3>
              <ConnectionValues connector={c} agentKey={result.key} />
            </section>
          ))}
          <section className="stack">
            <h3>Connect over MCP</h3>
            <ConnectAgent agentKey={result.key} />
          </section>
          <div className="row end">
            <button type="button" className="button" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </Dialog>
    );
  }

  if (result?.status === "pending") {
    return (
      <Dialog title="Request sent" onClose={onClose}>
        <div className="stack" role="status">
          <p>
            Your request for <strong>{result.request.agent?.name}</strong> went
            to {me.viewer.department ?? "your department"}'s managers. You'll
            see their answer under My requests, and once it's approved you can
            get the agent's key there.
          </p>
          <div className="row end">
            <button type="button" className="button" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="Ask for an agent" onClose={onClose} wide>
      <form
        className="stack"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (valid) ask.mutate();
        }}
      >
        <p className="muted">
          Each agent gets its own Purser account: a key, a spending limit and
          the services it may use, so you can see what it costs and stop it any
          time. It can be an agent you already run, such as a coding agent that
          needs a second model to check its work.
        </p>
        <label className="field">
          <span>Name</span>
          <input
            value={name}
            placeholder="invoice-summariser"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field">
          <span>What it does</span>
          <input
            value={purpose}
            placeholder="Summarises supplier invoices for the weekly report"
            onChange={(e) => setPurpose(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Provider</span>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="">
              {providers.length > 1 ? "Any my department allows" : "Any"}
            </option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="grid-2">
          <label className="field">
            <span>Daily limit in US dollars</span>
            <input
              inputMode="decimal"
              value={daily}
              onChange={(e) => setDaily(e.target.value)}
              aria-invalid={overMax}
            />
          </label>
          <label className="field">
            <span>Monthly limit (optional)</span>
            <input
              inputMode="decimal"
              value={monthly}
              onChange={(e) => setMonthly(e.target.value)}
            />
          </label>
        </div>
        <p className={overMax ? "note note-error" : "hint"}>
          {overMax
            ? `The most anyone in ${me.viewer.department ?? "your department"} can ask for is ${formatUsd(policy.maxDailyUsd)} a day.`
            : policy.autoApproveDailyUsd > 0
              ? `Up to ${formatUsd(policy.autoApproveDailyUsd)} a day is ready straight away. Above that, a manager decides. The most is ${formatUsd(policy.maxDailyUsd)} a day.`
              : `Every new agent needs a manager's OK. The most is ${formatUsd(policy.maxDailyUsd)} a day.`}
        </p>
        {needsOk && !overMax && (
          <label className="field">
            <span>Why it needs this much (your manager sees this)</span>
            <textarea
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        )}
        <ErrorNote error={ask.error} />
        <div className="row end">
          <button
            type="button"
            className="button button-ghost"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="button"
            disabled={!valid || ask.isPending}
          >
            {ask.isPending
              ? "Sending…"
              : needsOk
                ? "Send for approval"
                : "Create agent"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
