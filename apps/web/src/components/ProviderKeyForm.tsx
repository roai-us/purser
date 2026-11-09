import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../api/client";
import type { Connector } from "../api/types";
import { ErrorNote } from "./Notice";

/**
 * Paste a provider key and save it to Purser's vault. A first key is saved and
 * then tested. A replacement is tested first and only takes over if it works.
 */
export function ProviderKeyForm({
  connector,
  onSaved,
}: {
  connector: Connector;
  onSaved?: (connector: Connector) => void;
}) {
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [upstream, setUpstream] = useState(connector.upstream ?? "");
  const save = useMutation({
    mutationFn: () =>
      api.saveProviderKey(
        connector.id,
        apiKey.trim(),
        connector.needsUpstream ? upstream.trim() : undefined,
      ),
    onSuccess: (saved) => {
      setApiKey("");
      queryClient.setQueryData<Connector[]>(["providers"], (list) =>
        list?.map((c) => (c.id === saved.id ? saved : c)),
      );
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      onSaved?.(saved);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!apiKey.trim()) return;
    save.mutate();
  }

  const saved = save.data;
  const failedTest = saved?.lastTest && !saved.lastTest.ok;

  return (
    <form className="key-form" onSubmit={submit}>
      {connector.needsUpstream && (
        <label className="field">
          <span>Your {connector.name} address</span>
          <input
            type="url"
            value={upstream}
            placeholder="https://"
            onChange={(e) => setUpstream(e.target.value)}
            required
          />
        </label>
      )}
      <div className="row bottom">
        <label className="field grow">
          <span>
            {connector.configured ? "Replace" : "Paste"} your {connector.name}{" "}
            key
          </span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="mono"
            value={apiKey}
            placeholder={connector.keyPlaceholder ?? ""}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
        <button
          type="submit"
          className="button"
          disabled={!apiKey.trim() || save.isPending}
        >
          {save.isPending
            ? "Testing…"
            : connector.configured
              ? "Test and switch"
              : "Save and test"}
        </button>
      </div>
      <ErrorNote error={save.error} />
      {failedTest && (
        <p className="note note-error" role="alert">
          Saved, but the test failed: {saved.lastTest?.error ?? "no answer"}
        </p>
      )}
      {saved?.lastTest?.ok &&
        (saved.oldKeys?.length ? (
          <p className="note note-ok" role="status">
            Works, and agents are using it now. Next, delete the old key at{" "}
            {connector.name}. <Link to="/security">Security</Link> keeps track
            of it.
          </p>
        ) : (
          <p className="note note-ok" role="status">
            Works. The key is locked away on this computer.
          </p>
        ))}
    </form>
  );
}
