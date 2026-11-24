import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { adminApp, apiError } from "./admin.js";
import type { ConnectorManifest } from "./connectors.js";
import { proxy } from "./gateway.js";
import { OpenRouterPrices } from "./live-prices.js";
import { CallLog } from "./logs.js";
import { mcpApp } from "./mcp.js";
import { OidcClient, OidcError } from "./oidc.js";
import { Org } from "./org.js";
import { SIGN_IN_SECRET } from "./orgadmin.js";
import { selfApp } from "./self.js";
import type { InFlight } from "./inflight.js";
import type { PriceTable } from "./pricing.js";
import { Registry } from "./registry.js";
import { SESSION_COOKIE, SESSION_TTL_MS, Sessions } from "./sessions.js";
import { serveUi } from "./static.js";
import type { Store } from "./store.js";
import type { SubscriptionDirs } from "./subscriptions.js";
import { Vault } from "./vault.js";
import { outcomesApp } from "./workflowapi.js";
import { Workflows } from "./workflows.js";

export const VERSION = "0.0.1";

/** A sign-in Purser itself turns away, such as a person whose access was turned off. */
class SignInRefused extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AppDeps {
  store: Store;
  inflight: InFlight;
  prices: PriceTable;
  /** Provider keys from the environment, by connector id. Keys set in the UI (the vault) win. */
  providerKeys?: Partial<Record<string, string>> | undefined;
  /** Upstream overrides from the environment, by connector id. */
  upstreams?: Partial<Record<string, string>> | undefined;
  vault?: Vault | undefined;
  customConnectors?: ConnectorManifest[] | undefined;
  sessions?: Sessions | undefined;
  /** The call log. Without one, bodies are kept in memory only. */
  logs?: CallLog | undefined;
  /** People, departments and requests. Without one, they live in memory only. */
  org?: Org | undefined;
  /** Workflows and their results. Without one, they live in memory only. */
  workflows?: Workflows | undefined;
  /**
   * Lets anyone pick a demo person on the sign-in page, with no password.
   * Only for the demo on this computer: never turn it on for real data.
   */
  demoSignIn?: boolean | undefined;
  /** The address agents and browsers use to reach this server. */
  baseUrl?: string | undefined;
  /** The built web UI. Without it, only the APIs are served. */
  webDir?: string | undefined;
  fetch: typeof fetch;
  now: () => Date;
  adminToken: string;
  subscriptionDirs?: SubscriptionDirs | undefined;
}

/** Paths the web UI never answers, so a typo there is a clear 404, not the app. */
const API_PREFIXES = [
  "/admin",
  "/me",
  "/auth",
  "/login",
  "/health",
  "/mcp",
  "/v1",
];

/**
 * One process, two surfaces: the gateway that agents call, and the admin API
 * and web UI that people use. They share the store but not credentials.
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const vault = deps.vault ?? new Vault();
  const sessions = deps.sessions ?? new Sessions(deps.now);
  const logs = deps.logs ?? new CallLog(null, deps.now);
  const org = deps.org ?? new Org(null, deps.now);
  const workflows = deps.workflows ?? new Workflows();
  const registry = new Registry({
    envKeys: deps.providerKeys ?? {},
    envUpstreams: deps.upstreams ?? {},
    vault,
    custom: deps.customConnectors ?? [],
    baseUrl: deps.baseUrl ?? "http://127.0.0.1:4141",
    fetch: deps.fetch,
    now: deps.now,
  });
  const gateway = {
    ...deps,
    registry,
    logs,
    openRouterPrices: new OpenRouterPrices(deps.fetch, deps.now),
  };

  app.get("/health", (c) =>
    c.json({ ok: true, name: "ROAI Purser", version: VERSION }),
  );

  const startSession = (c: Context, id: string) => {
    setCookie(c, SESSION_COOKIE, id, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
      // Behind a proxy that ends HTTPS, the request itself arrives as http.
      secure:
        registry.baseUrl.startsWith("https:") ||
        new URL(c.req.url).protocol === "https:",
    });
  };

  // The one-time link `roai serve` prints and opens.
  app.get("/login", (c) => {
    const id = sessions.redeemLoginCode(c.req.query("code") ?? "");
    if (!id) return c.redirect("/?login=failed", 302);
    startSession(c, id);
    return c.redirect("/", 302);
  });

  app.get("/auth/session", (c) => {
    const session = sessions.get(getCookie(c, SESSION_COOKIE));
    if (!session) return c.json({ authenticated: false });
    if (session.personId === undefined) {
      return c.json({
        authenticated: true,
        viewer: { kind: "owner", role: "admin", name: "Purser admin" },
      });
    }
    const person = org.getPerson(session.personId);
    if (!person || person.status !== "active") {
      sessions.endAllFor(session.personId);
      return c.json({ authenticated: false });
    }
    return c.json({
      authenticated: true,
      viewer: {
        kind: "person",
        role: person.role,
        name: person.name,
        email: person.email,
        department: person.department,
        manages: person.manages,
      },
    });
  });

  /** How people can sign in here: the company button, demo people, or neither. */
  app.get("/auth/options", (c) => {
    const signIn = org.settings().signIn;
    return c.json({
      sso: signIn
        ? { label: signIn.label ?? "Sign in with your company account" }
        : null,
      demo: deps.demoSignIn ? demoPeople() : null,
    });
  });

  /** A few people of each role for the demo picker. */
  const demoPeople = () => {
    const active = org.listPeople().filter((p) => p.status === "active");
    const pick = (role: string, n: number) =>
      active.filter((p) => p.role === role).slice(0, n);
    return [
      ...pick("admin", 1),
      ...pick("manager", 3),
      ...pick("member", 4),
    ].map((p) => ({
      id: p.id,
      name: p.name,
      email: p.email,
      role: p.role,
      department: p.department,
      manages: p.manages,
    }));
  };

  app.post("/auth/demo", async (c) => {
    if (!deps.demoSignIn) {
      return apiError(c, 404, "not_found", "Not found.");
    }
    let id = "";
    try {
      const body = (await c.req.json()) as { personId?: unknown };
      if (typeof body.personId === "string") id = body.personId;
    } catch {
      return apiError(c, 400, "invalid_json", 'Send { "personId": "..." }.');
    }
    const person = org.getPerson(id);
    if (!person || person.status !== "active") {
      return apiError(c, 404, "not_found", "No such demo person.");
    }
    startSession(c, sessions.signIn(person.id));
    return c.json({ authenticated: true });
  });

  // Company sign-in (OpenID Connect). The client is rebuilt when the settings change.
  let sso: { key: string; client: OidcClient } | null = null;
  const ssoClient = (): OidcClient | null => {
    const signIn = org.settings().signIn;
    if (!signIn) return null;
    const secret = vault.get(SIGN_IN_SECRET)?.apiKey;
    const key = JSON.stringify([signIn, secret ?? ""]);
    if (sso?.key !== key) {
      sso = {
        key,
        client: new OidcClient({
          config: {
            issuer: signIn.issuer,
            clientId: signIn.clientId,
            clientSecret: secret,
            allowedDomains: signIn.allowedDomains,
          },
          redirectUri: `${registry.baseUrl}/auth/sso/callback`,
          fetch: deps.fetch,
          now: deps.now,
        }),
      };
    }
    return sso.client;
  };

  app.get("/auth/sso/start", async (c) => {
    const client = ssoClient();
    if (!client) return c.redirect("/?login=sso_off", 302);
    try {
      const { url } = await client.start();
      return c.redirect(url, 302);
    } catch (err) {
      return refuseSignIn(c, err, undefined);
    }
  });

  app.get("/auth/sso/callback", async (c) => {
    const client = ssoClient();
    if (!client) return c.redirect("/?login=sso_off", 302);
    let email: string | undefined;
    try {
      const identity = await client.finish(c.req.query());
      email = identity.email;
      const signIn = org.settings().signIn;
      let person = org.findByEmail(identity.email);
      if (person && person.status !== "active") {
        throw new SignInRefused(
          "disabled",
          "Your Purser access has been turned off. Ask an admin.",
        );
      }
      if (!person) {
        person = org.addPerson({
          email: identity.email,
          name: identity.name ?? identity.email,
          role: signIn?.adminEmails.includes(identity.email)
            ? "admin"
            : "member",
          source: "sso",
        });
        deps.store.audit({
          at: deps.now().toISOString(),
          type: "person.added",
          detail: { by: "sign-in", person: person.email, role: person.role },
        });
      }
      person = org.updatePerson(person.id, {
        lastSignInAt: deps.now().toISOString(),
        ...(identity.name && identity.name !== person.name
          ? { name: identity.name }
          : {}),
      });
      deps.store.audit({
        at: deps.now().toISOString(),
        type: "person.signed_in",
        detail: { person: person.email, via: "sso" },
      });
      startSession(c, sessions.signIn(person.id));
      return c.redirect("/", 302);
    } catch (err) {
      return refuseSignIn(c, err, email);
    }
  });

  const refuseSignIn = (
    c: Context,
    err: unknown,
    email: string | undefined,
  ) => {
    const known = err instanceof OidcError || err instanceof SignInRefused;
    const code = known ? err.code : "sso_error";
    if (!known) console.error(err);
    deps.store.audit({
      at: deps.now().toISOString(),
      type: "signin.refused",
      detail: {
        code,
        email,
        message: err instanceof Error ? err.message : undefined,
      },
    });
    return c.redirect(`/?login=${encodeURIComponent(code)}`, 302);
  };

  app.post("/auth/session", async (c) => {
    let candidate = "";
    try {
      const body = (await c.req.json()) as { token?: unknown };
      if (typeof body.token === "string") candidate = body.token.trim();
    } catch {
      return apiError(c, 400, "invalid_json", 'Send { "token": "..." }.');
    }
    const result = sessions.loginWithToken(candidate, deps.adminToken);
    if (result === "rate_limited") {
      return apiError(
        c,
        429,
        "rate_limited",
        "Too many attempts. Wait a minute.",
      );
    }
    if (result === "invalid") {
      return apiError(c, 401, "invalid_token", "That is not the admin token.");
    }
    startSession(c, result);
    return c.json({ authenticated: true });
  });

  app.delete("/auth/session", (c) => {
    sessions.end(getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ authenticated: false });
  });

  app.route(
    "/admin",
    adminApp(
      { ...deps, registry, vault, sessions, logs, org, workflows },
      deps.adminToken,
    ),
  );
  app.route(
    "/me",
    selfApp({ ...deps, registry, sessions, org }, deps.adminToken),
  );

  app.route("/mcp", mcpApp({ ...gateway, org, workflows, version: VERSION }));
  app.route("/v1", outcomesApp({ ...deps, workflows }));

  for (const provider of registry.providers) {
    app.all(`${provider.mount}/*`, (c) =>
      proxy(
        gateway,
        provider,
        c.req.raw,
        c.req.path.slice(provider.mount.length),
      ),
    );
  }

  app.get("*", (c) => {
    const path = c.req.path;
    const isApi = API_PREFIXES.some(
      (p) => path === p || path.startsWith(`${p}/`),
    );
    if (isApi || deps.webDir === undefined) {
      return apiError(c, 404, "not_found", "Not found.");
    }
    return serveUi(deps.webDir, path);
  });

  app.notFound((c) => apiError(c, 404, "not_found", "Not found."));
  app.onError((err, c) => {
    console.error(err);
    return apiError(c, 500, "internal", "Internal error.");
  });

  return app;
}
