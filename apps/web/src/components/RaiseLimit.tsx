import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Agent } from "../api/types";
import { useAgentApi } from "../lib/agentApi";
import { formatUsd } from "../lib/format";
import { parseMoney } from "./AgentForm";
import { Dialog } from "./Dialog";
import { ErrorNote } from "./Notice";

type Window = "day" | "month";

/** The cap in force right now: the limit plus any one-time raise. */
export function capNow(agent: Agent, window: Window): number | undefined {
  const base =
    window === "day" ? agent.limits.dailyUsd : agent.limits.monthlyUsd;
  if (base === undefined) return undefined;
  const raised =
    window === "day" ? agent.raised?.dailyUsd : agent.raised?.monthlyUsd;
  return base + (raised ?? 0);
}

/** True when the agent has spent all of this window's cap. */
export function isAtCap(agent: Agent, window: Window): boolean {
  const cap = capNow(agent, window);
  const spent = window === "day" ? agent.spend.today : agent.spend.month;
  return cap !== undefined && spent >= cap;
}

/**
 * Gives an agent that hit its limit a set amount more, for today or this
 * month only. The normal limit is back when the UTC day or month ends.
 */
export function RaiseLimitDialog({
  agent,
  onDone,
  onClose,
}: {
  agent: Agent;
  onDone: (agent: Agent, message: string) => void;
  onClose: () => void;
}) {
  const agentApi = useAgentApi();
  const direct = agentApi.canRaise(agent);
  const name = useId();
  const windows = (["day", "month"] as const).filter(
    (w) => capNow(agent, w) !== undefined,
  );
  const [window, setWindow] = useState<Window>(
    windows.find((w) => isAtCap(agent, w)) ?? windows[0] ?? "day",
  );
  const base =
    (window === "day" ? agent.limits.dailyUsd : agent.limits.monthlyUsd) ?? 0;
  const presets = [0.5, 1, 2].map((x) => Math.max(0.01, round2(base * x)));
  const [amountText, setAmountText] = useState(String(presets[1]));
  const [reason, setReason] = useState("");
  const amount = parseMoney(amountText);
  const valid = amount !== undefined && amount >= 0.01;
  const period = window === "day" ? "today" : "this month";
  const until =
    window === "day" ? "midnight UTC tonight" : "the end of the month (UTC)";

  const raise = useMutation({
    mutationFn: () =>
      agentApi.raiseLimit(agent.id, {
        window,
        amountUsd: amount ?? 0,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      }),
    onSuccess: (r) =>
      r.status === "raised"
        ? onDone(
            r.agent,
            `Raised. ${agent.name} can spend ${formatUsd(amount ?? 0)} more ${period}.`,
          )
        : onDone(
            agent,
            `Asked for ${formatUsd(amount ?? 0)} more ${period}. Your department's managers will decide, and you'll see the answer under Requests.`,
          ),
  });

  if (windows.length === 0) {
    return (
      <Dialog title="Raise limit once" onClose={onClose}>
        <p>This agent has no spending limit to raise.</p>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={
        direct
          ? `Raise ${agent.name}'s limit once`
          : `Ask for more budget for ${agent.name}`
      }
      onClose={onClose}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) raise.mutate();
        }}
      >
        {windows.length > 1 && (
          <fieldset>
            <legend>Which limit?</legend>
            {windows.map((w) => (
              <label key={w} className="radio">
                <input
                  type="radio"
                  name={name}
                  checked={window === w}
                  onChange={() => setWindow(w)}
                />
                {w === "day" ? "Today's" : "This month's"} (
                {formatUsd(capNow(agent, w) ?? 0)})
              </label>
            ))}
          </fieldset>
        )}
        <fieldset>
          <legend>How much more?</legend>
          <div className="row">
            {presets.map((p) => (
              <button
                key={p}
                type="button"
                className={
                  parseMoney(amountText) === p
                    ? "button button-soft chosen"
                    : "button button-ghost"
                }
                aria-pressed={parseMoney(amountText) === p}
                onClick={() => setAmountText(String(p))}
              >
                +{formatUsd(p)}
              </button>
            ))}
          </div>
          <label className="field">
            <span>Amount in US dollars</span>
            <input
              inputMode="decimal"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              aria-invalid={!valid}
            />
          </label>
        </fieldset>
        <label className="field">
          <span>Why (optional, kept in Activity)</span>
          <input
            value={reason}
            maxLength={200}
            placeholder="Quarter-end close"
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <p className="hint">
          {valid
            ? `${agent.name} can spend ${formatUsd(amount ?? 0)} more ${period}. `
            : "Enter an amount of at least $0.01. "}
          The usual {formatUsd(base)} limit comes back at {until}.
        </p>
        <ErrorNote error={raise.error} />
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
            disabled={!valid || raise.isPending}
          >
            {raise.isPending
              ? "Sending…"
              : direct
                ? "Raise limit"
                : "Send request"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

const round2 = (n: number) => Math.round(n * 100) / 100;
