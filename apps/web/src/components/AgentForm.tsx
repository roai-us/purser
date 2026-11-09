import { useState, type FormEvent } from "react";
import type { Connector, NewAgent } from "../api/types";
import {
  expiryFromPolicy,
  KeyPolicyFields,
  policyFromAgent,
  rotationFromPolicy,
} from "./KeyPolicyFields";
import { ErrorNote } from "./Notice";

export function parseMoney(text: string): number | undefined {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (!cleaned) return undefined;
  const value = Number(cleaned);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The fields for a new agent. */
export function AgentForm({
  connectors,
  busy,
  error,
  submitLabel = "Create agent",
  onSubmit,
}: {
  connectors: Connector[];
  busy: boolean;
  error: unknown;
  submitLabel?: string;
  onSubmit: (agent: NewAgent) => void;
}) {
  const configured = connectors.filter((c) => c.configured);
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [team, setTeam] = useState("");
  const [purpose, setPurpose] = useState("");
  const [daily, setDaily] = useState("");
  const [monthly, setMonthly] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [providers, setProviders] = useState<string[]>([]);
  const [keyPolicy, setKeyPolicy] = useState(policyFromAgent());
  const [problem, setProblem] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!/^[\w.-]+$/.test(name.trim())) {
      setProblem(
        "Use letters, numbers, dots, dashes or underscores in the name, with no spaces.",
      );
      return;
    }
    setProblem(null);
    const dailyUsd = parseMoney(daily);
    const monthlyUsd = parseMoney(monthly);
    const limits = {
      ...(dailyUsd !== undefined ? { dailyUsd } : {}),
      ...(monthlyUsd !== undefined ? { monthlyUsd } : {}),
    };
    const keyExpiresAt = expiryFromPolicy(keyPolicy);
    const rotation = rotationFromPolicy(keyPolicy);
    onSubmit({
      name: name.trim(),
      owner: owner.trim(),
      ...(ownerEmail.trim() ? { ownerEmail: ownerEmail.trim() } : {}),
      ...(team.trim() ? { team: team.trim() } : {}),
      ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
      ...(providers.length ? { providers } : {}),
      ...(Object.keys(limits).length ? { limits } : {}),
      ...(endsAt
        ? { endsAt: new Date(`${endsAt}T23:59:59Z`).toISOString() }
        : {}),
      ...(keyExpiresAt ? { keyExpiresAt } : {}),
      ...(rotation ? { rotation } : {}),
    });
  }

  return (
    <form className="stack" onSubmit={submit}>
      <div className="grid-2">
        <label className="field">
          <span>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="newsletter-writer"
            required
          />
        </label>
        <label className="field">
          <span>Who is responsible for it</span>
          <input
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>Their company email (optional)</span>
          <input
            type="email"
            value={ownerEmail}
            onChange={(e) => setOwnerEmail(e.target.value)}
          />
          <span className="hint">
            Lets them see this agent and collect its keys when they sign in.
          </span>
        </label>
        <label className="field">
          <span>Department (optional)</span>
          <input value={team} onChange={(e) => setTeam(e.target.value)} />
        </label>
        <label className="field">
          <span>Switch it off on (optional)</span>
          <input
            type="date"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
          />
        </label>
        <label className="field span-2">
          <span>What it does (optional)</span>
          <input value={purpose} onChange={(e) => setPurpose(e.target.value)} />
        </label>
        <label className="field">
          <span>Most it can spend in a day</span>
          <input
            inputMode="decimal"
            value={daily}
            placeholder="$5"
            onChange={(e) => setDaily(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Most it can spend in a month</span>
          <input
            inputMode="decimal"
            value={monthly}
            placeholder="$50"
            onChange={(e) => setMonthly(e.target.value)}
          />
        </label>
      </div>
      {configured.length > 1 && (
        <fieldset className="checks">
          <legend>Which providers it may use (none ticked means any)</legend>
          {configured.map((c) => (
            <label key={c.id} className="check">
              <input
                type="checkbox"
                checked={providers.includes(c.id)}
                onChange={(e) =>
                  setProviders((list) =>
                    e.target.checked
                      ? [...list, c.id]
                      : list.filter((id) => id !== c.id),
                  )
                }
              />
              {c.name}
            </label>
          ))}
        </fieldset>
      )}
      <KeyPolicyFields value={keyPolicy} onChange={setKeyPolicy} />
      <p className="hint">
        When it reaches a limit, Purser stops it until the next day or month.
      </p>
      {problem && (
        <p className="note note-error" role="alert">
          {problem}
        </p>
      )}
      <ErrorNote error={error} />
      <div className="row end">
        <button type="submit" className="button" disabled={busy}>
          {busy ? "Creating…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
