import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { meApi } from "../api/client";
import type { Agent, Connector } from "../api/types";
import { useAgentApi } from "../lib/agentApi";
import { formatUsd } from "../lib/format";
import { parseMoney } from "./AgentForm";
import { Dialog } from "./Dialog";
import { ErrorNote } from "./Notice";
import { SpendBar } from "./SpendBar";

/**
 * The AI services an agent's account can reach, each with its own limit. A
 * coding agent can have a second model here to check its work, without being
 * able to spend more on it than this says.
 */
export function AgentServices({
  agent,
  connectors,
}: {
  agent: Agent;
  connectors: Connector[];
}) {
  const agentApi = useAgentApi();
  const queryClient = useQueryClient();
  const direct = agentApi.canRaise(agent);
  const [dialog, setDialog] = useState<string | "new" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const nameOf = (id: string) =>
    connectors.find((c) => c.id === id)?.name ?? id;
  const listed = agent.providers ?? Object.keys(agent.serviceLimits ?? {});
  const remove = useMutation({
    mutationFn: (provider: string) =>
      agentApi.removeService(agent.id, provider),
    onSuccess: (updated, provider) => {
      setMessage(
        agent.providers
          ? `${agent.name} can't use ${nameOf(provider)} any more.`
          : `${agent.name} has no separate limit on ${nameOf(provider)} now.`,
      );
      queryClient.setQueryData(["agent", updated.id], updated);
      void queryClient.invalidateQueries();
    },
  });
  // An owner can narrow a list, but lifting a limit takes a manager.
  const canRemove = (id: string) =>
    agent.providers
      ? agent.providers.length > 1
      : direct && agent.serviceLimits?.[id] !== undefined;

  return (
    <section className="stack" aria-labelledby="services-h">
      <div className="row between">
        <h3 id="services-h">Services</h3>
        <button
          type="button"
          className="button button-soft"
          onClick={() => {
            setMessage(null);
            setDialog("new");
          }}
        >
          {direct ? "Add a service" : "Ask for a service"}
        </button>
      </div>
      {!agent.providers && (
        <p className="muted">
          This agent can use any connected provider through its one key.
        </p>
      )}
      {listed.length > 0 && (
        <ul className="service-list">
          {listed.map((id) => {
            const limit = agent.serviceLimits?.[id];
            const spent = agent.serviceSpend?.[id];
            return (
              <li key={id} className="service-item">
                <div className="row between">
                  <strong>{nameOf(id)}</strong>
                  <span className="row">
                    <button
                      type="button"
                      className="link-button"
                      aria-label={`Change limits on ${nameOf(id)}`}
                      onClick={() => {
                        setMessage(null);
                        setDialog(id);
                      }}
                    >
                      Change
                    </button>
                    {canRemove(id) && (
                      <button
                        type="button"
                        className="link-button"
                        aria-label={`Remove ${nameOf(id)}`}
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(id)}
                      >
                        Remove
                      </button>
                    )}
                  </span>
                </div>
                {limit?.dailyUsd !== undefined ? (
                  <SpendBar spent={spent?.today ?? 0} limit={limit.dailyUsd} />
                ) : (
                  <span className="muted small">
                    {formatUsd(spent?.today ?? 0)} today, under the agent's
                    overall limit
                  </span>
                )}
                {limit?.monthlyUsd !== undefined && (
                  <span className="muted small">
                    {formatUsd(spent?.month ?? 0)} of{" "}
                    {formatUsd(limit.monthlyUsd)} this month
                  </span>
                )}
                {limit?.models?.length ? (
                  <span className="muted small">
                    Models: {limit.models.join(", ")}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {message && (
        <p className="note note-info" role="status">
          {message}
        </p>
      )}
      <ErrorNote error={remove.error} />
      {dialog && (
        <ServiceDialog
          agent={agent}
          connectors={connectors}
          provider={dialog === "new" ? undefined : dialog}
          nameOf={nameOf}
          direct={direct}
          onClose={() => setDialog(null)}
          onDone={(text) => {
            setDialog(null);
            setMessage(text);
          }}
        />
      )}
    </section>
  );
}

function ServiceDialog({
  agent,
  connectors,
  provider,
  nameOf,
  direct,
  onClose,
  onDone,
}: {
  agent: Agent;
  connectors: Connector[];
  /** The service being changed. Absent: adding one. */
  provider: string | undefined;
  nameOf: (id: string) => string;
  direct: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const agentApi = useAgentApi();
  const admin = agentApi.scope === "admin";
  const queryClient = useQueryClient();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: meApi.me,
    enabled: !admin,
  });
  const policy = me.data?.policy;
  const current = provider ? agent.serviceLimits?.[provider] : undefined;
  const choices = connectors.filter(
    (c) =>
      c.configured &&
      !(agent.providers ?? []).includes(c.id) &&
      (direct ||
        !policy?.allowedProviders ||
        policy.allowedProviders.includes(c.id)),
  );
  const [chosen, setChosen] = useState(provider ?? "");
  const [daily, setDaily] = useState(
    current?.dailyUsd === undefined ? "" : String(current.dailyUsd),
  );
  const [monthly, setMonthly] = useState(
    current?.monthlyUsd === undefined ? "" : String(current.monthlyUsd),
  );
  const [models, setModels] = useState((current?.models ?? []).join(", "));
  const [reason, setReason] = useState("");

  const dailyUsd = parseMoney(daily);
  const monthlyUsd = parseMoney(monthly);
  const overMax =
    !direct &&
    policy !== undefined &&
    dailyUsd !== undefined &&
    dailyUsd > policy.maxDailyUsd;
  const needsOk =
    !direct &&
    policy !== undefined &&
    dailyUsd !== undefined &&
    dailyUsd > policy.autoApproveDailyUsd;
  // Only an admin may leave a service with no daily limit of its own.
  const valid =
    chosen !== "" &&
    !overMax &&
    (admin || (dailyUsd !== undefined && dailyUsd >= 0.01));

  const save = useMutation({
    mutationFn: () => {
      const list = models
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
      return agentApi.setService(agent.id, {
        provider: chosen,
        ...(dailyUsd !== undefined ? { dailyUsd } : {}),
        ...(monthlyUsd !== undefined ? { monthlyUsd } : {}),
        ...(list.length ? { models: list } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
    },
    onSuccess: (result) => {
      if (result.status === "granted") {
        queryClient.setQueryData(["agent", agent.id], result.agent);
      }
      void queryClient.invalidateQueries();
      onDone(
        result.status === "granted"
          ? `${agent.name} can use ${nameOf(chosen)}${dailyUsd !== undefined ? `, up to ${formatUsd(dailyUsd)} a day` : ""}.`
          : `Your request went to ${agent.team ?? "your department"}'s managers. You'll see their answer under My requests.`,
      );
    },
  });

  return (
    <Dialog
      title={
        provider
          ? `Limits on ${nameOf(provider)}`
          : direct
            ? "Add a service"
            : "Ask for a service"
      }
      onClose={onClose}
      wide
    >
      <form
        className="stack"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (valid) save.mutate();
        }}
      >
        <p className="muted">
          {agent.name} keeps its one key and reaches this service through
          Purser. It uses your company's account with the provider, not anyone's
          personal subscription.
        </p>
        {!provider && (
          <label className="field">
            <span>Service</span>
            <select value={chosen} onChange={(e) => setChosen(e.target.value)}>
              <option value="">Choose one</option>
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {!provider && choices.length === 0 && (
          <p className="note note-warn">
            There are no other connected services to add. An admin connects them
            under Providers.
          </p>
        )}
        <div className="grid-2">
          <label className="field">
            <span>Most it can spend here in a day</span>
            <input
              inputMode="decimal"
              value={daily}
              placeholder="$2"
              onChange={(e) => setDaily(e.target.value)}
              aria-invalid={overMax}
            />
          </label>
          <label className="field">
            <span>In a month (optional)</span>
            <input
              inputMode="decimal"
              value={monthly}
              onChange={(e) => setMonthly(e.target.value)}
            />
          </label>
          <label className="field span-2">
            <span>Only these models, separated by commas (optional)</span>
            <input
              className="mono"
              value={models}
              onChange={(e) => setModels(e.target.value)}
            />
          </label>
        </div>
        <p className={overMax ? "note note-error" : "hint"}>
          {overMax
            ? `The most anyone in ${agent.team ?? "this department"} can ask for is ${formatUsd(policy?.maxDailyUsd ?? 0)} a day.`
            : [
                agent.limits.dailyUsd !== undefined
                  ? `The agent's overall limit of ${formatUsd(agent.limits.dailyUsd)} a day still applies.`
                  : "",
                !direct && policy
                  ? `Up to ${formatUsd(policy.autoApproveDailyUsd)} a day is ready straight away. Above that, a manager decides.`
                  : "",
              ]
                .filter(Boolean)
                .join(" ")}
        </p>
        {needsOk && !overMax && (
          <label className="field">
            <span>Why it needs this (your manager sees this)</span>
            <textarea
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        )}
        <ErrorNote error={save.error} />
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
            disabled={!valid || save.isPending}
          >
            {save.isPending
              ? "Saving…"
              : needsOk
                ? "Send for approval"
                : "Save"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
