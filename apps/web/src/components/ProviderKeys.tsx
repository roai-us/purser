import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../api/client";
import type { Connector } from "../api/types";
import { formatNumber, formatRelative } from "../lib/format";
import { ErrorNote, Loading } from "./Notice";
import { ProviderKeyForm } from "./ProviderKeyForm";

/** Past this age a key is flagged as worth replacing. */
const DUE_AFTER_DAYS = 90;
const DAY_MS = 86_400_000;

const isDue = (keySetAt: string | undefined): boolean =>
  keySetAt !== undefined &&
  Date.now() - Date.parse(keySetAt) > DUE_AFTER_DAYS * DAY_MS;

/** The environment variable that holds a connector's key. */
const envVar = (id: string): string =>
  `PURSER_${id.toUpperCase().replace(/-/g, "_")}_API_KEY`;

/** The provider's name, linked to where its keys are made when we know that. */
function KeysLink({ connector: c }: { connector: Connector }) {
  return c.keysUrl ? (
    <a href={c.keysUrl} target="_blank" rel="noreferrer">
      {c.name}
    </a>
  ) : (
    <>{c.name}</>
  );
}

/**
 * Replacing the keys Purser holds for each provider, one provider at a time.
 * The key is tested before it takes over, and the old one is tracked until
 * someone has deleted it at the provider, since Purser can't do that for them.
 */
export function ProviderKeys({ demoKeys }: { demoKeys: boolean }) {
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: api.providers,
  });
  const connected = providers.data?.filter((c) => c.configured) ?? [];
  const toDelete = connected.reduce(
    (sum, c) => sum + (c.oldKeys?.length ?? 0),
    0,
  );

  return (
    <section className="card stack" aria-labelledby="provider-keys-h">
      <h2 id="provider-keys-h">Provider keys</h2>
      <p>
        Purser holds one key for each provider. Your agents only have their
        Purser keys, so replacing one of these needs no change to any agent. The
        next call simply uses the new key.
      </p>
      {providers.isPending ? (
        <Loading />
      ) : providers.isError ? (
        <ErrorNote error={providers.error} />
      ) : connected.length === 0 ? (
        <p className="hint">
          No providers are connected yet. Add them under{" "}
          <Link to="/providers">Providers</Link>.
        </p>
      ) : (
        <>
          {toDelete > 0 && (
            <p className="note note-warn" role="status">
              {toDelete === 1
                ? "1 old key still needs deleting. It keeps working for anyone who has it until you do."
                : `${formatNumber(toDelete)} old keys still need deleting. They keep working for anyone who has them until you do.`}
            </p>
          )}
          {demoKeys && (
            <p className="hint">
              In the demo, any key starting with <code>demo-</code> passes the
              test. A real key goes to the real provider.
            </p>
          )}
          <ul className="rotation-list">
            {connected.map((c) => (
              <ProviderKeyRow key={c.id} connector={c} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function ProviderKeyRow({ connector: c }: { connector: Connector }) {
  const queryClient = useQueryClient();
  const [replacing, setReplacing] = useState(false);
  const confirm = useMutation({
    mutationFn: () => api.confirmOldKeysDeleted(c.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["providers"] }),
  });
  const oldKeys = c.oldKeys ?? [];
  const oneOld = oldKeys.length === 1;

  return (
    <li className="stack rotation-row">
      <div className="row between wrap">
        <div>
          <strong>{c.name}</strong> <span className="mono">{c.keyHint}</span>
          <p className="hint">
            {c.keySource === "env"
              ? "Set by an environment variable"
              : c.keySetAt
                ? `Saved ${formatRelative(c.keySetAt)}`
                : "Date saved isn't recorded"}{" "}
            {isDue(c.keySetAt) && (
              <span className="badge badge-paused">
                Over {DUE_AFTER_DAYS} days old
              </span>
            )}
          </p>
        </div>
        {c.keySource !== "env" && !replacing && (
          <button
            type="button"
            className="button button-soft"
            onClick={() => setReplacing(true)}
          >
            Replace key
          </button>
        )}
      </div>

      {c.keySource === "env" && (
        <p className="hint">
          To replace it, make a new key at <KeysLink connector={c} />, change{" "}
          <code>{envVar(c.id)}</code> and restart Purser.
        </p>
      )}

      {replacing && (
        <div className="stack">
          <ol className="steps">
            <li>
              Make a new key at <KeysLink connector={c} />, and copy it.
            </li>
            <li>
              <div className="stack">
                <span>
                  Paste it here. Purser tests it first. If it doesn't work,
                  nothing changes.
                </span>
                <ProviderKeyForm
                  connector={c}
                  onSaved={() => setReplacing(false)}
                />
              </div>
            </li>
          </ol>
          <div>
            <button
              type="button"
              className="link-button"
              onClick={() => setReplacing(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {oldKeys.length > 0 && (
        <div className="note note-warn stack" role="status">
          <p>
            Now delete the old {oneOld ? "key" : "keys"} at{" "}
            <KeysLink connector={c} />:{" "}
            <span className="mono">
              {oldKeys.map((k) => k.hint).join(", ")}
            </span>
            . Purser can't do this for you, and {oneOld ? "it" : "they"} still{" "}
            {oneOld ? "works" : "work"} for anyone who has{" "}
            {oneOld ? "it" : "them"} until you do.
          </p>
          <div>
            <button
              type="button"
              className="button button-soft"
              disabled={confirm.isPending}
              onClick={() => confirm.mutate()}
            >
              I've deleted {oneOld ? "it" : "them"}
            </button>
          </div>
          <ErrorNote error={confirm.error} />
        </div>
      )}
    </li>
  );
}
