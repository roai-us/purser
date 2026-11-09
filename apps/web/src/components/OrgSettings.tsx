import {
  cloneElement,
  useEffect,
  useId,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../api/client";
import type {
  Connector,
  OrgSettingsView,
  SelfServicePolicy,
  SignInConfig,
} from "../api/types";
import { formatNumber, formatUsd } from "../lib/format";
import { parseMoney } from "./AgentForm";
import { CopyButton } from "./CopyButton";
import { Dialog } from "./Dialog";
import { ErrorNote, Loading } from "./Notice";
import "../org.css";

const MAX_DAILY = 100_000;
const DEFAULT_LABEL = "Sign in with your company account";

/**
 * A labelled form control with a hint under it. The hint sits outside the
 * label, so the label stays short, and screen readers hear it as a description.
 */
export function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: ReactNode;
  className?: string;
  children: ReactElement<{ id?: string; "aria-describedby"?: string }>;
}) {
  const id = useId();
  const hintId = useId();
  return (
    <div className={className ? `field ${className}` : "field"}>
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, {
        id,
        ...(hint ? { "aria-describedby": hintId } : {}),
      })}
      {hint && (
        <span id={hintId} className="hint block">
          {hint}
        </span>
      )}
    </div>
  );
}

/** Whole dollars read as "$2", anything else as "$2.50". */
export function shortUsd(amount: number): string {
  return Number.isInteger(amount)
    ? `$${formatNumber(amount)}`
    : formatUsd(amount);
}

/** Self-service rules in a few words: "Ready up to $2/day, max $25/day". */
export function policySummary(policy: SelfServicePolicy): string {
  const max = `max ${shortUsd(policy.maxDailyUsd)}/day`;
  return policy.autoApproveDailyUsd > 0
    ? `Ready up to ${shortUsd(policy.autoApproveDailyUsd)}/day, ${max}`
    : `Always needs a manager, ${max}`;
}

/** The self-service rules as typed into a form. */
export interface PolicyDraft {
  auto: string;
  max: string;
  providers: string[];
}

export function draftFromPolicy(policy: SelfServicePolicy): PolicyDraft {
  return {
    auto: String(policy.autoApproveDailyUsd),
    max: String(policy.maxDailyUsd),
    providers: policy.allowedProviders ?? [],
  };
}

/** Checks a rules form. Gives the rules, or a sentence saying what to fix. */
export function readPolicy(
  draft: PolicyDraft,
): { policy: SelfServicePolicy } | { problem: string } {
  const auto = parseMoney(draft.auto);
  const max = parseMoney(draft.max);
  if (auto === undefined) {
    return {
      problem:
        "Enter how much is ready straight away, in dollars. Use 0 if a manager should always decide.",
    };
  }
  if (max === undefined || max < 0.01) {
    return {
      problem: "Enter the most anyone can ask for per day, above $0.",
    };
  }
  if (auto > MAX_DAILY || max > MAX_DAILY) {
    return { problem: "Keep each amount at $100,000 a day or less." };
  }
  if (auto > max) {
    return {
      problem:
        "The amount that is ready straight away can't be more than the most anyone can ask for.",
    };
  }
  return {
    policy: {
      autoApproveDailyUsd: auto,
      maxDailyUsd: max,
      ...(draft.providers.length ? { allowedProviders: draft.providers } : {}),
    },
  };
}

/** The two daily amounts and the allowed providers. */
export function PolicyFields({
  value,
  onChange,
  connectors,
}: {
  value: PolicyDraft;
  onChange: (next: PolicyDraft) => void;
  connectors: Connector[];
}) {
  // Configured providers, plus any the rules already name.
  const shown = connectors.filter(
    (c) => c.configured || value.providers.includes(c.id),
  );
  return (
    <div className="policy-fields">
      <div className="grid-2">
        <Field
          label="Ready straight away up to ($ per agent per day)"
          hint="0 means a manager always decides."
        >
          <input
            inputMode="decimal"
            value={value.auto}
            onChange={(e) => onChange({ ...value, auto: e.target.value })}
          />
        </Field>
        <label className="field">
          <span>Nobody can ask for more than ($ per agent per day)</span>
          <input
            inputMode="decimal"
            value={value.max}
            onChange={(e) => onChange({ ...value, max: e.target.value })}
          />
        </label>
      </div>
      {shown.length > 0 && (
        <fieldset>
          <legend>Allowed providers (none ticked means any)</legend>
          {shown.map((c) => (
            <label key={c.id} className="check">
              <input
                type="checkbox"
                checked={value.providers.includes(c.id)}
                onChange={(e) =>
                  onChange({
                    ...value,
                    providers: e.target.checked
                      ? [...value.providers, c.id]
                      : value.providers.filter((id) => id !== c.id),
                  })
                }
              />
              {c.name}
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}

function useOrgSettings() {
  return useQuery({ queryKey: ["org-settings"], queryFn: api.orgSettings });
}

/** A card's heading with a loading or error state, until the settings arrive. */
function CardShell({
  title,
  query,
  children,
}: {
  title: string;
  query: ReturnType<typeof useOrgSettings>;
  children: (data: OrgSettingsView) => ReactNode;
}) {
  if (query.data) return <>{children(query.data)}</>;
  return (
    <section className="card stack" aria-label={title}>
      <h2>{title}</h2>
      {query.isError ? <ErrorNote error={query.error} /> : <Loading />}
    </section>
  );
}

/** Card for the Settings page: whether people can ask for agents, and the default rules. */
export function SelfServiceSettings() {
  const settings = useOrgSettings();
  return (
    <CardShell title="Asking for agents" query={settings}>
      {(data) => <SelfServiceForm saved={data} />}
    </CardShell>
  );
}

function SelfServiceForm({ saved }: { saved: OrgSettingsView }) {
  const queryClient = useQueryClient();
  const headingId = useId();
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: api.providers,
  });
  const [enabled, setEnabled] = useState(saved.selfService);
  const [draft, setDraft] = useState(() => draftFromPolicy(saved.defaults));
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setEnabled(saved.selfService);
    setDraft(draftFromPolicy(saved.defaults));
  }, [saved]);

  const save = useMutation({
    mutationFn: api.saveSelfService,
    onSuccess: (data) => {
      queryClient.setQueryData(["org-settings"], data);
      void queryClient.invalidateQueries();
      setDone(true);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setDone(false);
    const read = readPolicy(draft);
    if ("problem" in read) {
      setProblem(read.problem);
      return;
    }
    setProblem(null);
    save.mutate({ selfService: enabled, defaults: read.policy });
  }

  return (
    <form className="card stack" aria-labelledby={headingId} onSubmit={submit}>
      <h2 id={headingId}>Asking for agents</h2>
      <p>
        People can ask for an agent of their own. Within the first limit below,
        the agent is ready at once and the person gets its key straight away.
        Above it, the managers of their department decide. Departments can have
        their own rules on the <Link to="/departments">Departments</Link> page.
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Let people ask for agents themselves
      </label>
      {!enabled && (
        <p className="hint">
          While this is off, only admins can add agents. You can still set the
          rules now.
        </p>
      )}
      <h3 className="subhead">Organisation defaults</h3>
      <PolicyFields
        value={draft}
        onChange={setDraft}
        connectors={providers.data ?? []}
      />
      {problem && (
        <p className="note note-error" role="alert">
          {problem}
        </p>
      )}
      <ErrorNote error={save.error} />
      {done && (
        <p className="note note-ok" role="status">
          Saved.
        </p>
      )}
      <div className="row end">
        <button type="submit" className="button" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

/** Splits "a.com, b.com c.com" into a list. */
export function splitList(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

interface SignInDraft {
  issuer: string;
  clientId: string;
  secret: string;
  removeSecret: boolean;
  domains: string;
  admins: string;
  label: string;
}

function draftFromSignIn(config: SignInConfig | null): SignInDraft {
  return {
    issuer: config?.issuer ?? "",
    clientId: config?.clientId ?? "",
    secret: "",
    removeSecret: false,
    domains: config?.allowedDomains.join(", ") ?? "",
    admins: config?.adminEmails.join(", ") ?? "",
    label: config?.label ?? "",
  };
}

/** What is wrong with the sign-in form, if anything. */
function signInProblem(draft: SignInDraft): string | null {
  const issuer = draft.issuer.trim();
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(issuer);
  if (!/^https:\/\/\S+$/.test(issuer) && !local)
    return "Enter the issuer URL. It starts with https://.";
  if (/\/(common|organizations|consumers)(\/|$)/i.test(issuer))
    return "Use your own tenant id in the issuer, not common or organizations.";
  if (!draft.clientId.trim()) return "Enter the client ID.";
  if (splitList(draft.domains).length === 0)
    return "Add at least one email domain, like example.com.";
  return null;
}

/** Card for the Settings page: signing in with a company identity provider. */
export function SignInSettings() {
  const settings = useOrgSettings();
  return (
    <CardShell title="Company sign-in" query={settings}>
      {(data) => <SignInForm saved={data} />}
    </CardShell>
  );
}

function SignInForm({ saved }: { saved: OrgSettingsView }) {
  const queryClient = useQueryClient();
  const headingId = useId();
  const config = saved.signIn;
  const [draft, setDraft] = useState(() => draftFromSignIn(config));
  const [problem, setProblem] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => setDraft(draftFromSignIn(config)), [config]);

  const set = (patch: Partial<SignInDraft>) =>
    setDraft((d) => ({ ...d, ...patch }));

  const onSaved = (data: OrgSettingsView, text: string) => {
    queryClient.setQueryData(["org-settings"], data);
    void queryClient.invalidateQueries();
    // Clear the secret box even when the saved settings look the same.
    setDraft(draftFromSignIn(data.signIn));
    setMessage(text);
  };

  const save = useMutation({
    mutationFn: api.saveSignIn,
    onSuccess: (data) => onSaved(data, "Saved. Company sign-in is on."),
  });
  const remove = useMutation({
    mutationFn: api.removeSignIn,
    onSuccess: (data) => {
      setConfirming(false);
      onSaved(data, "Company sign-in is off.");
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    const issue = signInProblem(draft);
    setProblem(issue);
    if (issue) return;
    const label = draft.label.trim();
    save.mutate({
      issuer: draft.issuer.trim(),
      clientId: draft.clientId.trim(),
      ...(draft.secret
        ? { clientSecret: draft.secret }
        : draft.removeSecret
          ? { clientSecret: "" }
          : {}),
      allowedDomains: splitList(draft.domains).map((d) => d.toLowerCase()),
      adminEmails: splitList(draft.admins),
      ...(label ? { label } : {}),
    });
  }

  return (
    <>
      <form
        className="card stack"
        aria-labelledby={headingId}
        onSubmit={submit}
      >
        <h2 id={headingId}>Company sign-in</h2>
        <p>
          People sign in to Purser with their work account, through Microsoft
          Entra ID, Okta, Google Workspace or any OpenID Connect provider. Their
          password stays with that provider, so Purser never sees it.
        </p>
        {config && (
          <p className="note note-ok">
            People sign in at {window.location.origin}/ using the button on the
            sign-in page.
          </p>
        )}

        <div className="stack">
          <span className="subhead">Redirect URI</span>
          <div className="uri-row">
            <code className="mono">{saved.redirectUri}</code>
            <CopyButton text={saved.redirectUri} what="redirect URI" />
          </div>
          <p className="hint">
            Register this address in your identity provider, in the app you
            create for Purser. Some providers call it a callback or reply URL.
          </p>
        </div>

        <Field
          label="Issuer URL"
          hint={
            <>
              Entra ID: https://login.microsoftonline.com/&lt;tenant id&gt;/v2.0
              (use your own tenant id, not common). Okta: https://&lt;your
              org&gt;.okta.com. Google: https://accounts.google.com.
            </>
          }
        >
          <input
            className="mono"
            inputMode="url"
            autoComplete="off"
            value={draft.issuer}
            placeholder="https://"
            onChange={(e) => set({ issuer: e.target.value })}
          />
        </Field>
        <div className="grid-2">
          <label className="field">
            <span>Client ID</span>
            <input
              className="mono"
              autoComplete="off"
              value={draft.clientId}
              onChange={(e) => set({ clientId: e.target.value })}
            />
          </label>
          <Field
            label="Client secret"
            hint={
              config?.hasSecret
                ? "A secret is saved. Leave blank to keep it."
                : undefined
            }
          >
            <input
              type="password"
              className="mono"
              autoComplete="new-password"
              value={draft.secret}
              onChange={(e) => set({ secret: e.target.value })}
            />
          </Field>
        </div>
        {config?.hasSecret && (
          <label className="check">
            <input
              type="checkbox"
              checked={draft.removeSecret}
              disabled={draft.secret !== ""}
              onChange={(e) => set({ removeSecret: e.target.checked })}
            />
            Remove the saved secret
          </label>
        )}
        <Field
          label="Allowed email domains"
          hint="Only people with these email addresses can sign in. Separate them with commas or spaces."
        >
          <input
            value={draft.domains}
            placeholder="example.com"
            onChange={(e) => set({ domains: e.target.value })}
          />
        </Field>
        <Field
          label="Admin emails"
          hint="These people are made admins the first time they sign in. Everyone else starts as a member."
        >
          <input
            value={draft.admins}
            onChange={(e) => set({ admins: e.target.value })}
          />
        </Field>
        <label className="field">
          <span>Button label (optional)</span>
          <input
            value={draft.label}
            placeholder={DEFAULT_LABEL}
            maxLength={60}
            onChange={(e) => set({ label: e.target.value })}
          />
        </label>

        {problem && (
          <p className="note note-error" role="alert">
            {problem}
          </p>
        )}
        <ErrorNote error={save.error} />
        {message && (
          <p className="note note-ok" role="status">
            {message}
          </p>
        )}
        <div className="row end">
          {config && (
            <button
              type="button"
              className="button button-ghost"
              onClick={() => {
                remove.reset();
                setConfirming(true);
              }}
            >
              Turn off company sign-in
            </button>
          )}
          <button type="submit" className="button" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>

      {confirming && (
        <Dialog
          title="Turn off company sign-in?"
          onClose={() => setConfirming(false)}
        >
          <div className="stack">
            <p>
              People will no longer be able to sign in with their work account,
              and the saved client secret is deleted. You can set it up again at
              any time.
            </p>
            <ErrorNote error={remove.error} />
            <div className="row end">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button button-dark"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                {remove.isPending ? "Turning off…" : "Turn off"}
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
