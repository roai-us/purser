import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { LogMode, LogSettings } from "../api/types";
import { ErrorNote, Loading } from "../components/Notice";
import { SelfServiceSettings, SignInSettings } from "../components/OrgSettings";

const MODES: { value: LogMode; label: string; hint: string }[] = [
  {
    value: "off",
    label: "Off",
    hint: "Keep cost, tokens and model for every call, but not what was said.",
  },
  {
    value: "selected",
    label: "Only agents I choose",
    hint: "Turn it on per agent, in the agent's details.",
  },
  { value: "all", label: "Every agent", hint: "Keep every call in full." },
];
export const RETENTION_DAYS = [7, 14, 30, 90, 180, 365];
export const SIZE_KB = [16, 64, 256, 1024];

export function SettingsPage() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">
            Call records, how agents connect, who can ask for agents, and how
            people sign in.
          </p>
        </div>
      </header>
      {settings.isPending ? (
        <Loading />
      ) : settings.isError ? (
        <ErrorNote error={settings.error} />
      ) : (
        <LoggingForm saved={settings.data.logging} />
      )}
      <McpSettings />
      <SelfServiceSettings />
      <SignInSettings />
    </div>
  );
}

/** Whether agents can connect to Purser's MCP server with their keys. */
function McpSettings() {
  const queryClient = useQueryClient();
  const org = useQuery({
    queryKey: ["org-settings"],
    queryFn: api.orgSettings,
  });
  const save = useMutation({
    mutationFn: api.saveMcp,
    onSuccess: (data) => {
      queryClient.setQueryData(["org-settings"], data);
      void queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });
  if (!org.data?.mcp) return null;
  return (
    <section className="card stack" aria-labelledby="mcp-h">
      <h2 id="mcp-h">Agent connections (MCP)</h2>
      <p>
        Agents can connect to Purser as an MCP server, using their own keys.
        Each one sees only itself: its services, limits and spending. It can ask
        another model through its services, and ask a person for more. It can't
        change anything itself.
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={org.data.mcp.enabled}
          disabled={save.isPending}
          onChange={(e) => save.mutate(e.target.checked)}
        />
        Let agents connect over MCP
      </label>
      <p className="hint">
        Address: <code>{org.data.mcp.url}</code>
      </p>
      <ErrorNote error={save.error} />
    </section>
  );
}

function LoggingForm({ saved }: { saved: LogSettings }) {
  const queryClient = useQueryClient();
  const name = useId();
  const [form, setForm] = useState(saved);
  const [done, setDone] = useState(false);
  useEffect(() => setForm(saved), [saved]);
  const save = useMutation({
    mutationFn: () => api.saveLogging(form),
    onSuccess: (data) => {
      queryClient.setQueryData(["settings"], data);
      void queryClient.invalidateQueries({ queryKey: ["logs"] });
      setDone(true);
    },
  });
  const changed =
    form.mode !== saved.mode ||
    form.retentionDays !== saved.retentionDays ||
    form.maxKb !== saved.maxKb;
  const shorter = form.retentionDays < saved.retentionDays;

  return (
    <form
      className="card stack"
      aria-labelledby="logging-h"
      onSubmit={(e) => {
        e.preventDefault();
        setDone(false);
        save.mutate();
      }}
    >
      <h2 id="logging-h">Call log</h2>
      <p>
        Purser can keep the full request and response of each agent call, so you
        can see what an agent was asked and what it answered. Calls can hold
        customer data, code and documents, so only admins can read them, and
        every read is recorded in Activity. Provider and agent keys are never
        kept.
      </p>
      <fieldset className="radio-list">
        <legend>Keep requests and responses for</legend>
        {MODES.map((m) => (
          <label key={m.value} className="radio radio-block">
            <input
              type="radio"
              name={name}
              checked={form.mode === m.value}
              onChange={() => setForm({ ...form, mode: m.value })}
            />
            <span>
              {m.label}
              <span className="hint block">{m.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="row wrap">
        <label className="field">
          <span>Delete calls after</span>
          <select
            value={form.retentionDays}
            onChange={(e) =>
              setForm({ ...form, retentionDays: Number(e.target.value) })
            }
          >
            {[...new Set([...RETENTION_DAYS, form.retentionDays])]
              .sort((a, b) => a - b)
              .map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span>Keep at most, per request and per response</span>
          <select
            value={form.maxKb}
            onChange={(e) =>
              setForm({ ...form, maxKb: Number(e.target.value) })
            }
          >
            {[...new Set([...SIZE_KB, form.maxKb])]
              .sort((a, b) => a - b)
              .map((kb) => (
                <option key={kb} value={kb}>
                  {kb >= 1024 ? `${kb / 1024} MB` : `${kb} KB`}
                </option>
              ))}
          </select>
        </label>
      </div>
      {shorter && (
        <p className="note note-warn">
          Saving deletes calls older than {form.retentionDays} days straight
          away.
        </p>
      )}
      <p className="hint">
        Calls are stored on this computer in Purser's data folder, one file per
        day, readable only by Purser.
      </p>
      <ErrorNote error={save.error} />
      {done && !changed && (
        <p className="note note-ok" role="status">
          Saved.
        </p>
      )}
      <div className="row end">
        <button
          type="submit"
          className="button"
          disabled={!changed || save.isPending}
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
