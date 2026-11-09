import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Connector, CreatedAgent } from "../api/types";
import { AgentForm } from "../components/AgentForm";
import { ConnectionValues } from "../components/ConnectionValues";
import { KeyReveal } from "../components/KeyReveal";
import { ErrorNote, Loading } from "../components/Notice";
import { ProviderKeyForm } from "../components/ProviderKeyForm";
import { TestRequest } from "../components/TestRequest";

const STEPS = ["Accounts", "First agent", "Connect a tool"];

/** OpenRouter first: one key reaches many models. */
export function setupOrder(connectors: Connector[]): Connector[] {
  return [...connectors].sort((a, b) => {
    const rank = (c: Connector) =>
      c.id === "openrouter" ? 0 : c.source === "builtin" ? 1 : 2;
    return rank(a) - rank(b);
  });
}

export function Setup({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: api.providers,
  });
  const [step, setStep] = useState(0);
  const [created, setCreated] = useState<CreatedAgent | null>(null);
  const create = useMutation({
    mutationFn: api.createAgent,
    onSuccess: (data) => {
      setCreated(data);
      void queryClient.invalidateQueries();
    },
  });

  if (providers.isPending) return <Loading />;
  if (providers.isError) return <ErrorNote error={providers.error} />;
  const connectors = providers.data;
  const configured = connectors.filter((c) => c.configured);
  const allowed = created?.agent.providers;
  const target =
    configured.find((c) => (allowed?.length ? allowed.includes(c.id) : true)) ??
    configured[0];

  return (
    <div className="page setup">
      <ol className="stepper" aria-label="Setup steps">
        {STEPS.map((label, i) => (
          <li
            key={label}
            className={
              i < step ? "step done" : i === step ? "step now" : "step"
            }
            aria-current={i === step ? "step" : undefined}
          >
            <span className="step-dot" aria-hidden="true">
              {i < step ? "✓" : i + 1}
            </span>
            {label}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <section className="stack">
          <header>
            <h1>Connect your AI accounts</h1>
            <p className="muted">
              Add the ones you use. You can add more later under Providers.
            </p>
          </header>
          <div className="provider-grid">
            {setupOrder(connectors).map((c) => (
              <div key={c.id} className="card">
                <div className="card-head">
                  <h2>{c.name}</h2>
                  {c.configured && (
                    <span className="badge badge-running">Connected</span>
                  )}
                </div>
                <ProviderKeyForm connector={c} />
              </div>
            ))}
          </div>
          <div className="row between">
            <span className="muted">
              {configured.length === 0
                ? "Connect at least one account to continue."
                : `${configured.length} connected`}
            </span>
            <button
              type="button"
              className="button"
              disabled={configured.length === 0}
              onClick={() => setStep(1)}
            >
              Continue
            </button>
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="stack">
          <header>
            <h1>Add your first agent</h1>
            <p className="muted">
              An agent is any app, script or assistant that uses AI for you.
              Each one gets its own key, so you can see what it spends and
              switch it off on its own.
            </p>
          </header>
          {created ? (
            <>
              <KeyReveal name={created.agent.name} agentKey={created.key} />
              <div className="row end">
                <button
                  type="button"
                  className="button"
                  onClick={() => setStep(2)}
                >
                  Continue
                </button>
              </div>
            </>
          ) : (
            <div className="card">
              <AgentForm
                connectors={connectors}
                busy={create.isPending}
                error={create.error}
                onSubmit={(agent) => create.mutate(agent)}
              />
            </div>
          )}
          <div>
            <button
              type="button"
              className="button button-ghost"
              onClick={() => setStep(0)}
            >
              Back
            </button>
          </div>
        </section>
      )}

      {step === 2 && created && target && (
        <section className="stack">
          <header>
            <h1>Connect {created.agent.name}</h1>
            <p className="muted">
              Open the settings of the tool this agent runs in and find where it
              asks for an API key. Paste these two values there.
            </p>
          </header>
          <div className="columns">
            <div className="card grow">
              <ConnectionValues connector={target} agentKey={created.key} />
              <p className="note note-info">
                Tool only asks for a key, with nowhere to put an address? Then
                Purser can't sit in front of it yet.
              </p>
            </div>
            <div className="card side">
              <h2 className="label">Check the connection</h2>
              <TestRequest connector={target} agentKey={created.key} />
            </div>
          </div>
          <div className="row between">
            <button
              type="button"
              className="button button-ghost"
              onClick={() => setStep(1)}
            >
              Back
            </button>
            <button type="button" className="button" onClick={onDone}>
              Finish
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
