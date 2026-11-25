import { useId, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../api/client";
import type {
  AlertChannel,
  AlertDelivery,
  AlertRecord,
  AlertSettings,
  AlertType,
  AlertsView,
  ChannelKind,
  SmtpSecurity,
  SmtpSettings,
} from "../api/types";
import { CopyButton } from "../components/CopyButton";
import { Dialog } from "../components/Dialog";
import { ErrorNote, Loading } from "../components/Notice";
import { Field } from "../components/OrgSettings";
import { formatDateTime, formatRelative } from "../lib/format";
import "../org.css";
import "../alerts.css";

const KIND_WORDS: Record<ChannelKind, string> = {
  slack: "Slack",
  discord: "Discord",
  webhook: "Webhook",
  email: "Email",
};

const KIND_HINTS: Record<ChannelKind, string> = {
  slack:
    "A Slack incoming webhook URL, from your Slack app's Incoming Webhooks page. It starts https://hooks.slack.com/.",
  discord:
    "A Discord webhook URL, from the channel's Integrations settings. It starts https://discord.com/api/webhooks/.",
  webhook:
    "Any https address. Purser sends JSON and signs it, so your receiver can check it came from here.",
  email: "Up to 20 addresses, separated by commas.",
};

/** Splits "a@x.com, b@y.com" into addresses. */
export function splitAddresses(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((a) => a.trim())
    .filter(Boolean);
}

export function AlertsPage() {
  const view = useQuery({ queryKey: ["alerts"], queryFn: api.alerts });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AlertChannel | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(
    null,
  );

  if (view.isPending) return <Loading label="Loading alerts" />;
  if (view.isError) {
    return (
      <div className="page">
        <ErrorNote error={view.error} />
      </div>
    );
  }
  const data = view.data;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Alerts</h1>
          <p className="muted">
            Where Purser tells someone that an agent needs a person: at its
            limit, spending far more than usual, stopped, or with a key about to
            expire, and when a workflow crosses its stop line.
          </p>
        </div>
        <button
          type="button"
          className="button"
          onClick={() => {
            setNotice(null);
            setAdding(true);
          }}
        >
          Add a channel
        </button>
      </header>

      {notice && (
        <p className="note note-ok" role="status">
          {notice}
        </p>
      )}
      {secret && (
        <div className="key-reveal">
          <div className="label">{secret.name} · signing secret</div>
          <code className="key-text">{secret.value}</code>
          <div className="row">
            <CopyButton text={secret.value} label="Copy secret" />
            <span className="key-note">
              Shown once. Your receiver uses it to check each alert&apos;s
              signature; the docs show how.
            </span>
          </div>
        </div>
      )}

      <Channels
        view={data}
        onAdd={() => setAdding(true)}
        onEdit={(c) => {
          setNotice(null);
          setEditing(c);
        }}
        onNotice={setNotice}
      />
      <MailServer smtp={data.smtp} onSaved={setNotice} />
      <Thresholds settings={data.settings} onSaved={setNotice} />
      <Recent records={data.recent} />

      {adding && (
        <ChannelDialog
          types={data.types}
          hasMailServer={data.smtp !== null}
          onClose={() => setAdding(false)}
          onSaved={(text, signing) => {
            setAdding(false);
            setNotice(text);
            setSecret(signing ?? null);
          }}
        />
      )}
      {editing && (
        <ChannelDialog
          types={data.types}
          hasMailServer={data.smtp !== null}
          channel={editing}
          onClose={() => setEditing(null)}
          onSaved={(text) => {
            setEditing(null);
            setNotice(text);
          }}
        />
      )}
    </div>
  );
}

function deliveryWords(d: { ok: boolean; error?: string | undefined }) {
  return d.ok ? "Delivered" : (d.error ?? "Not delivered");
}

function Channels({
  view,
  onAdd,
  onEdit,
  onNotice,
}: {
  view: AlertsView;
  onAdd: () => void;
  onEdit: (c: AlertChannel) => void;
  onNotice: (text: string) => void;
}) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["alerts"] });
  const test = useMutation({
    mutationFn: (c: AlertChannel) => api.testChannel(c.id),
    onSuccess: ({ delivery }, c) => {
      void refresh();
      onNotice(
        delivery.ok
          ? `Sent a test to ${c.name}. Check that it arrived.`
          : `The test to ${c.name} failed: ${deliveryWords(delivery)}`,
      );
    },
  });
  const toggle = useMutation({
    mutationFn: (c: AlertChannel) =>
      api.updateChannel(c.id, { enabled: !c.enabled }),
    onSuccess: ({ channel }) => {
      void refresh();
      onNotice(
        channel.enabled
          ? `${channel.name} gets alerts again.`
          : `${channel.name} is paused.`,
      );
    },
  });
  const [removing, setRemoving] = useState<AlertChannel | null>(null);
  const remove = useMutation({
    mutationFn: (c: AlertChannel) => api.removeChannel(c.id),
    onSuccess: (_r, c) => {
      setRemoving(null);
      void refresh();
      onNotice(`Removed ${c.name}.`);
    },
  });
  const words = new Map(view.types.map((t) => [t.type, t.words]));

  return (
    <section className="card flush">
      <div className="card-head">
        <h2>Channels</h2>
      </div>
      {view.channels.length === 0 ? (
        <div className="empty stack">
          <p>
            No channels yet, so alerts are only listed below. Add a Slack or
            Discord channel, email addresses, or a webhook to have them sent.
          </p>
          <p>
            <button type="button" className="button" onClick={onAdd}>
              Add a channel
            </button>
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table channels-table">
            <thead>
              <tr>
                <th scope="col">Channel</th>
                <th scope="col">Sends</th>
                <th scope="col">Last delivery</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {view.channels.map((c) => (
                <tr key={c.id} className={c.enabled ? undefined : "paused"}>
                  <th scope="row">
                    {c.name}
                    <span className="cell-sub">
                      {KIND_WORDS[c.kind]} ·{" "}
                      {c.kind === "email" ? (
                        (c.to ?? []).join(", ")
                      ) : (
                        <span className="mono">{c.urlHint}</span>
                      )}
                      {c.enabled ? "" : " · paused"}
                    </span>
                  </th>
                  <td>
                    {c.events.length === 0 ? (
                      "Every alert"
                    ) : (
                      <ul className="plain-list">
                        {c.events.map((e) => (
                          <li key={e}>{words.get(e) ?? e}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td>
                    {c.lastDelivery ? (
                      <>
                        <span
                          className={
                            c.lastDelivery.ok
                              ? "delivery ok"
                              : "delivery failed"
                          }
                        >
                          {deliveryWords(c.lastDelivery)}
                        </span>
                        <span className="cell-sub">
                          {formatRelative(c.lastDelivery.at)}
                        </span>
                      </>
                    ) : (
                      <span className="muted">Nothing sent yet</span>
                    )}
                  </td>
                  <td>
                    <div className="row end">
                      <button
                        type="button"
                        className="button button-soft"
                        disabled={test.isPending}
                        aria-label={`Send a test to ${c.name}`}
                        onClick={() => test.mutate(c)}
                      >
                        Test
                      </button>
                      <button
                        type="button"
                        className="button button-ghost"
                        aria-label={`${c.enabled ? "Pause" : "Resume"} ${c.name}`}
                        onClick={() => toggle.mutate(c)}
                      >
                        {c.enabled ? "Pause" : "Resume"}
                      </button>
                      <button
                        type="button"
                        className="button button-ghost"
                        aria-label={`Edit ${c.name}`}
                        onClick={() => onEdit(c)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="button button-ghost"
                        aria-label={`Remove ${c.name}`}
                        onClick={() => setRemoving(c)}
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ErrorNote error={test.error ?? toggle.error} />
      {removing && (
        <Dialog
          title={`Remove ${removing.name}?`}
          onClose={() => setRemoving(null)}
        >
          <div className="stack">
            <p>
              Alerts stop going to {removing.name}, and Purser forgets its
              address. You can add it again later.
            </p>
            <ErrorNote error={remove.error} />
            <div className="row end">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setRemoving(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button button-danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate(removing)}
              >
                Remove
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}

function ChannelDialog({
  types,
  hasMailServer,
  channel,
  onClose,
  onSaved,
}: {
  types: AlertsView["types"];
  hasMailServer: boolean;
  channel?: AlertChannel;
  onClose: () => void;
  onSaved: (text: string, secret?: { name: string; value: string }) => void;
}) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<ChannelKind>(channel?.kind ?? "slack");
  const [name, setName] = useState(channel?.name ?? "");
  const [url, setUrl] = useState("");
  const [to, setTo] = useState((channel?.to ?? []).join(", "));
  const [every, setEvery] = useState((channel?.events.length ?? 0) === 0);
  const [events, setEvents] = useState<AlertType[]>(channel?.events ?? []);
  const [problem, setProblem] = useState<string | null>(null);
  const radio = useId();

  const save = useMutation({
    mutationFn: async () => {
      const chosen = every ? [] : events;
      const target =
        kind === "email"
          ? { to: splitAddresses(to) }
          : url.trim()
            ? { url: url.trim() }
            : {};
      if (channel) {
        return api.updateChannel(channel.id, {
          name: name.trim(),
          events: chosen,
          ...target,
        });
      }
      return api.addChannel({
        name: name.trim(),
        kind,
        ...target,
        events: chosen,
      });
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["alerts"] });
      const saved = result.channel;
      const secret =
        "signingSecret" in result && typeof result.signingSecret === "string"
          ? result.signingSecret
          : undefined;
      const signing = secret ? { name: saved.name, value: secret } : undefined;
      onSaved(
        channel
          ? `Saved ${saved.name}.`
          : `Added ${saved.name}. Send a test to check it arrives.`,
        signing,
      );
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return setProblem("Give the channel a name.");
    if (kind === "email") {
      const addresses = splitAddresses(to);
      if (addresses.length === 0) {
        return setProblem("Add at least one email address.");
      }
      if (addresses.length > 20) return setProblem("Up to 20 addresses.");
      const bad = addresses.find((a) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a));
      if (bad) return setProblem(`${bad} is not an email address.`);
    } else {
      if (!channel && !url.trim()) {
        return setProblem("Paste the channel's URL.");
      }
      if (url.trim() && !/^https?:\/\//i.test(url.trim())) {
        return setProblem("The URL starts with https://.");
      }
    }
    if (!every && events.length === 0) {
      return setProblem(
        "Choose at least one kind of alert, or send every alert.",
      );
    }
    setProblem(null);
    save.mutate();
  }

  return (
    <Dialog
      title={channel ? `Edit ${channel.name}` : "Add a channel"}
      onClose={onClose}
      wide
    >
      <form className="stack" onSubmit={submit}>
        {!channel && (
          <fieldset className="radio-list">
            <legend>Where alerts go</legend>
            <div
              className="segmented"
              role="group"
              aria-label="Kind of channel"
            >
              {(["slack", "discord", "email", "webhook"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={kind === k}
                  onClick={() => setKind(k)}
                >
                  {KIND_WORDS[k]}
                </button>
              ))}
            </div>
          </fieldset>
        )}
        <Field label="Name" hint='For you: "Ops in Slack", "Finance on-call".'>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {kind === "email" ? (
          <>
            {!hasMailServer && (
              <p className="note note-error" role="alert">
                Set up the mail server on this page first, so Purser can send
                email.
              </p>
            )}
            <Field label="Send to" hint={KIND_HINTS.email}>
              <input
                type="text"
                inputMode="email"
                autoComplete="off"
                spellCheck={false}
                placeholder="ops@example.com, finance@example.com"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>
          </>
        ) : (
          <Field
            label={channel ? "New URL (optional)" : "URL"}
            hint={
              channel
                ? `Purser keeps the saved URL secret (${channel.urlHint}). Paste a new one only to replace it.`
                : KIND_HINTS[kind]
            }
          >
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </Field>
        )}
        <fieldset className="radio-list">
          <legend>What to send</legend>
          <label className="radio radio-block">
            <input
              type="radio"
              name={radio}
              checked={every}
              onChange={() => setEvery(true)}
            />
            <span>Every alert</span>
          </label>
          <label className="radio radio-block">
            <input
              type="radio"
              name={radio}
              checked={!every}
              onChange={() => setEvery(false)}
            />
            <span>Only these</span>
          </label>
          {!every && (
            <div className="event-checks">
              {types.map((t) => (
                <label key={t.type} className="check">
                  <input
                    type="checkbox"
                    checked={events.includes(t.type)}
                    onChange={(e) =>
                      setEvents((prev) =>
                        e.target.checked
                          ? [...prev, t.type]
                          : prev.filter((x) => x !== t.type),
                      )
                    }
                  />
                  <span>{t.words}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        {problem && (
          <p className="note note-error" role="alert">
            {problem}
          </p>
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
            disabled={
              save.isPending || (kind === "email" && !channel && !hasMailServer)
            }
          >
            {save.isPending ? "Saving…" : channel ? "Save" : "Add channel"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

const SECURITY_WORDS: Record<SmtpSecurity, string> = {
  starttls: "STARTTLS (usually port 587)",
  tls: "TLS (usually port 465)",
  none: "None: only for a relay on this computer or private network",
};
const SECURITY_PORT: Record<SmtpSecurity, number> = {
  starttls: 587,
  tls: 465,
  none: 25,
};

const isLocalHost = (host: string) =>
  ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host.toLowerCase());

function MailServer({
  smtp,
  onSaved,
}: {
  smtp: SmtpSettings | null;
  onSaved: (text: string) => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({
    host: smtp?.host ?? "",
    port: String(smtp?.port ?? 587),
    security: smtp?.security ?? ("starttls" as SmtpSecurity),
    username: smtp?.username ?? "",
    password: "",
    from: smtp?.from ?? "",
  });
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["alerts"] });
  const save = useMutation({
    mutationFn: api.saveSmtp,
    onSuccess: () => {
      void refresh();
      setOpen(false);
      setDraft((d) => ({ ...d, password: "" }));
      onSaved(
        "Saved the mail server. Send a test to an email channel to check it.",
      );
    },
  });
  const remove = useMutation({
    mutationFn: api.removeSmtp,
    onSuccess: () => {
      void refresh();
      setRemoving(false);
      setDraft({
        host: "",
        port: "587",
        security: "starttls",
        username: "",
        password: "",
        from: "",
      });
      onSaved("Removed the mail server. Email channels stop until it is back.");
    },
  });

  const set = (key: keyof typeof draft) => (value: string) =>
    setDraft((d) => ({ ...d, [key]: value }));

  function chooseSecurity(security: SmtpSecurity) {
    setDraft((d) => ({
      ...d,
      security,
      // Follow the usual port, unless someone typed their own.
      port:
        d.port === String(SECURITY_PORT[d.security]) || d.port === ""
          ? String(SECURITY_PORT[security])
          : d.port,
    }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const host = draft.host.trim();
    const port = Number(draft.port);
    const from = draft.from.trim();
    const username = draft.username.trim();
    if (!host) return setProblem("Enter the mail server's address.");
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return setProblem("The port is a whole number from 1 to 65535.");
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from)) {
      return setProblem("Enter the address alerts come from.");
    }
    const sendsPassword =
      draft.password !== "" || (draft.password === "" && smtp?.passwordSet);
    if (
      draft.security === "none" &&
      username &&
      sendsPassword &&
      !isLocalHost(host)
    ) {
      return setProblem(
        "Choose TLS or STARTTLS to send a password to a mail server on another computer.",
      );
    }
    setProblem(null);
    save.mutate({
      host,
      port,
      security: draft.security,
      username,
      // Without a username there is nothing to sign in with.
      ...(username
        ? draft.password
          ? { password: draft.password }
          : {}
        : { password: "" }),
      from,
    });
  }

  const radio = useId();

  return (
    <section className="card stack">
      <div className="row between">
        <h2>Mail server</h2>
        {smtp && !open && (
          <div className="row">
            <button
              type="button"
              className="button button-ghost"
              onClick={() => setOpen(true)}
            >
              Change
            </button>
            <button
              type="button"
              className="button button-ghost"
              onClick={() => setRemoving(true)}
            >
              Remove
            </button>
          </div>
        )}
      </div>
      {smtp && !open ? (
        <p className="mail-summary">
          Email alerts go out through{" "}
          <span className="mono">
            {smtp.host}:{smtp.port}
          </span>{" "}
          with{" "}
          {smtp.security === "none"
            ? "no encryption"
            : smtp.security.toUpperCase()}
          , from <span className="mono">{smtp.from}</span>
          {smtp.username
            ? `, signing in as ${smtp.username}${smtp.passwordSet ? "" : " (no password saved)"}`
            : ", without signing in"}
          .
        </p>
      ) : !smtp && !open ? (
        <div className="stack">
          <p className="muted">
            To send alerts by email, tell Purser which mail server to send
            through: your company&apos;s, or a sending service such as Amazon
            SES, Postmark or SendGrid. Their SMTP settings page lists the
            address, port and sign-in.
          </p>
          <p>
            <button
              type="button"
              className="button button-soft"
              onClick={() => setOpen(true)}
            >
              Set up email
            </button>
          </p>
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          <div className="grid-2">
            <Field label="Server address" hint="Such as smtp.example.com.">
              <input
                autoComplete="off"
                spellCheck={false}
                value={draft.host}
                onChange={(e) => set("host")(e.target.value)}
              />
            </Field>
            <Field label="Port">
              <input
                inputMode="numeric"
                value={draft.port}
                onChange={(e) => set("port")(e.target.value)}
              />
            </Field>
          </div>
          <fieldset className="radio-list">
            <legend>Encryption</legend>
            {(["starttls", "tls", "none"] as const).map((s) => (
              <label key={s} className="radio radio-block">
                <input
                  type="radio"
                  name={radio}
                  checked={draft.security === s}
                  onChange={() => chooseSecurity(s)}
                />
                <span>{SECURITY_WORDS[s]}</span>
              </label>
            ))}
          </fieldset>
          <div className="grid-2">
            <Field
              label="Username"
              hint="Leave empty if the server takes mail without signing in."
            >
              <input
                autoComplete="off"
                spellCheck={false}
                value={draft.username}
                onChange={(e) => set("username")(e.target.value)}
              />
            </Field>
            <Field
              label="Password"
              hint={
                smtp?.passwordSet
                  ? "A password is saved. Type a new one only to replace it."
                  : "Kept with the provider keys, never shown again."
              }
            >
              <input
                type="password"
                autoComplete="new-password"
                value={draft.password}
                onChange={(e) => set("password")(e.target.value)}
              />
            </Field>
          </div>
          <Field
            label="Send from"
            hint="An address the mail server lets you send from, such as alerts@example.com."
          >
            <input
              type="email"
              autoComplete="off"
              value={draft.from}
              onChange={(e) => set("from")(e.target.value)}
            />
          </Field>
          {problem && (
            <p className="note note-error" role="alert">
              {problem}
            </p>
          )}
          <ErrorNote error={save.error} />
          <div className="row end">
            <button
              type="button"
              className="button button-ghost"
              onClick={() => {
                setOpen(false);
                setProblem(null);
              }}
            >
              Cancel
            </button>
            <button type="submit" className="button" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save mail server"}
            </button>
          </div>
        </form>
      )}
      {removing && (
        <Dialog
          title="Remove the mail server?"
          onClose={() => setRemoving(false)}
        >
          <div className="stack">
            <p>
              Purser forgets the server and its password. Email channels stay,
              but nothing is sent to them until a mail server is set up again.
            </p>
            <ErrorNote error={remove.error} />
            <div className="row end">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setRemoving(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button button-danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Remove
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}

function Thresholds({
  settings,
  onSaved,
}: {
  settings: AlertSettings;
  onSaved: (text: string) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState({
    nearLimitPercent: String(settings.nearLimitPercent),
    spikeMultiple: String(settings.spikeMultiple),
    spikeMinUsd: String(settings.spikeMinUsd),
    keyExpiringDays: String(settings.keyExpiringDays),
  });
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: api.saveAlertSettings,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["alerts"] });
      onSaved("Saved when to alert.");
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const n = (s: string) => Number(s.replace(/[$,%\s]/g, ""));
    const patch = {
      nearLimitPercent: n(draft.nearLimitPercent),
      spikeMultiple: n(draft.spikeMultiple),
      spikeMinUsd: n(draft.spikeMinUsd),
      keyExpiringDays: n(draft.keyExpiringDays),
    };
    if (
      !Number.isInteger(patch.nearLimitPercent) ||
      patch.nearLimitPercent < 1 ||
      patch.nearLimitPercent > 99
    ) {
      return setProblem("The warning share is a whole percent from 1 to 99.");
    }
    if (!(patch.spikeMultiple >= 1.5 && patch.spikeMultiple <= 100)) {
      return setProblem("A spike is from 1.5 to 100 times the usual rate.");
    }
    if (!(patch.spikeMinUsd >= 0)) {
      return setProblem("The smallest spike is a dollar amount, 0 or more.");
    }
    if (
      !Number.isInteger(patch.keyExpiringDays) ||
      patch.keyExpiringDays < 1 ||
      patch.keyExpiringDays > 90
    ) {
      return setProblem("Warn about keys 1 to 90 days ahead.");
    }
    setProblem(null);
    save.mutate(patch);
  }

  const set = (key: keyof typeof draft) => (value: string) =>
    setDraft((d) => ({ ...d, [key]: value }));

  return (
    <section className="card stack">
      <h2>When to alert</h2>
      <form className="stack" onSubmit={submit}>
        <div className="grid-2">
          <Field
            label="Warn at this share of a limit (%)"
            hint="Also alerts when the limit is reached."
          >
            <input
              inputMode="numeric"
              value={draft.nearLimitPercent}
              onChange={(e) => set("nearLimitPercent")(e.target.value)}
            />
          </Field>
          <Field
            label="Warn about keys this many days ahead"
            hint="Also alerts when a key expires."
          >
            <input
              inputMode="numeric"
              value={draft.keyExpiringDays}
              onChange={(e) => set("keyExpiringDays")(e.target.value)}
            />
          </Field>
          <Field
            label="A spike is this many times the usual rate"
            hint="Against the agent's own 7-day average."
          >
            <input
              inputMode="decimal"
              value={draft.spikeMultiple}
              onChange={(e) => set("spikeMultiple")(e.target.value)}
            />
          </Field>
          <Field
            label="...and at least this much in a day ($)"
            hint="So a few cents never counts as a spike."
          >
            <input
              inputMode="decimal"
              value={draft.spikeMinUsd}
              onChange={(e) => set("spikeMinUsd")(e.target.value)}
            />
          </Field>
        </div>
        {problem && (
          <p className="note note-error" role="alert">
            {problem}
          </p>
        )}
        <ErrorNote error={save.error} />
        <div className="row end">
          <button type="submit" className="button" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </section>
  );
}

/** The page an alert points at, inside this app whatever its address. */
export function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/";
  }
}

const SEVERITY_WORDS = {
  info: "Info",
  warning: "Warning",
  critical: "Critical",
};

function Recent({ records }: { records: AlertRecord[] }) {
  return (
    <section className="card flush">
      <div className="card-head">
        <h2>Recent alerts</h2>
      </div>
      {records.length === 0 ? (
        <p className="empty">No alerts yet.</p>
      ) : (
        <ul className="alert-list">
          {records.map((r) => (
            <li key={r.id} className="alert-item">
              <div className="row between">
                <span className={`severity severity-${r.severity}`}>
                  {SEVERITY_WORDS[r.severity]}
                </span>
                <span className="small muted">{formatDateTime(r.at)}</span>
              </div>
              <p className="strong">
                <Link to={pathOf(r.url)}>{r.title}</Link>
              </p>
              <p className="small">{r.text}</p>
              <p className="small">
                {r.deliveries.length === 0 ? (
                  <span className="muted">No channel takes this alert.</span>
                ) : (
                  r.deliveries.map((d: AlertDelivery) => (
                    <span
                      key={d.channelId}
                      className={d.ok ? "delivery ok" : "delivery failed"}
                      title={d.error}
                    >
                      {d.channelName}: {d.ok ? "sent" : "failed"}
                    </span>
                  ))
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
