import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import type { Role } from "../api/types";
import { Logo } from "../components/Logo";
import { ErrorNote } from "../components/Notice";

/** Why the last sign-in didn't work, from the `login` code the server sends back. */
export const LOGIN_PROBLEMS: Record<string, string> = {
  failed: "That sign-in link has expired or was already used.",
  sso_off: "Company sign-in isn't set up yet. Ask an admin.",
  domain_not_allowed:
    "That account's email domain isn't allowed here. Sign in with your work account.",
  disabled: "Your Purser access has been turned off. Ask an admin.",
  invalid_state: "That sign-in took too long or was already used. Try again.",
  email_unverified:
    "Your company account didn't share a verified email address. Ask your IT team.",
  no_email:
    "Your company account didn't share an email address. Ask your IT team.",
  idp_error: "Your company sign-in turned the request down. Try again.",
};

const ROLE_LABELS: Record<Role, string> = {
  admin: "Admin",
  manager: "Manager",
  member: "Employee",
};

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const options = useQuery({
    queryKey: ["signin-options"],
    queryFn: api.signInOptions,
  });
  const code = new URLSearchParams(window.location.search).get("login");
  const problem = code
    ? (LOGIN_PROBLEMS[code] ??
      "Sign-in didn't work. Try again, or ask an admin.")
    : null;
  const sso = options.data?.sso;
  const demo = options.data?.demo;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(token.trim());
      onSignedIn();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? new Error("That token didn't match. Check it and try again.")
          : err,
      );
    } finally {
      setBusy(false);
    }
  }

  async function signInAs(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.demoSignIn(id);
      onSignedIn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const tokenForm = (
    <form onSubmit={submit} className="stack">
      <p>
        Open the link Purser printed when it started. It signs you in straight
        away.
      </p>
      <label className="field">
        <span>Or paste the admin token</span>
        <input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      <p className="hint">
        The token is in the file <code>admin-token</code> in Purser's data
        folder.
      </p>
      <button
        type="submit"
        className="button button-soft"
        disabled={busy || !token.trim()}
      >
        {busy ? "Signing in…" : "Sign in with the token"}
      </button>
    </form>
  );

  return (
    <div className="login">
      <div className="login-card">
        <div className="brand brand-dark">
          <Logo size={44} />
          <span className="eyebrow">ROAI PURSER</span>
        </div>
        <h1>Sign in to Purser</h1>
        {problem && (
          <p className="note note-error" role="alert">
            {problem}
          </p>
        )}
        {sso && (
          <a className="button button-wide" href="/auth/sso/start">
            {sso.label}
          </a>
        )}
        {demo && demo.length > 0 && (
          <section className="stack" aria-labelledby="demo-h">
            <h2 id="demo-h" className="small-heading">
              Demo: sign in as
            </h2>
            <p className="hint">
              This Purser runs with sample data. Pick a person to see what they
              see. No password, so never use this with real data.
            </p>
            <ul className="demo-people">
              {demo.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="demo-person"
                    disabled={busy}
                    onClick={() => void signInAs(p.id)}
                  >
                    <span className="demo-name">{p.name}</span>
                    <span className={`role-chip role-${p.role}`}>
                      {ROLE_LABELS[p.role]}
                    </span>
                    <span className="muted small">
                      {p.role === "manager" && p.manages?.length
                        ? `Manages ${p.manages.join(", ")}`
                        : (p.department ?? p.email)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <ErrorNote error={error} />
        {sso || (demo && demo.length > 0) ? (
          <details className="admin-signin">
            <summary>Purser admin? Sign in with the admin token</summary>
            {tokenForm}
          </details>
        ) : (
          tokenForm
        )}
      </div>
    </div>
  );
}
