import { createApp } from "../app.js";
import { createAgent } from "../control.js";
import { InFlight } from "../inflight.js";
import { DEFAULT_PRICES } from "../prices.js";
import { Store } from "../store.js";
import type { ConnectorManifest } from "../connectors.js";
import { Org, type Person } from "../org.js";
import { SESSION_COOKIE, Sessions } from "../sessions.js";
import type { SubscriptionDirs } from "../subscriptions.js";
import type { AgentLimits } from "../types.js";
import { Vault } from "../vault.js";
import { Workflows } from "../workflows.js";
import { Alerts } from "../alerts.js";
import {
  mockUpstream,
  REAL_ANTHROPIC_KEY,
  REAL_OPENAI_KEY,
  REAL_OPENROUTER_KEY,
} from "./mock-upstream.js";

export const ADMIN_TOKEN = "purser_admin_test";

export interface Harness {
  app: ReturnType<typeof createApp>;
  store: Store;
  inflight: InFlight;
  vault: Vault;
  sessions: Sessions;
  org: Org;
  workflows: Workflows;
  alerts: Alerts;
  /** What alert channels received at https://hooks.test/..., and how to answer. */
  hooks: HookRecorder;
  upstream: ReturnType<typeof mockUpstream>;
  clock: { now: Date };
  addAgent(
    name?: string,
    limits?: AgentLimits,
    extra?: {
      endsAt?: string;
      providers?: string[];
      team?: string;
      ownerEmail?: string;
    },
  ): { id: string; key: string };
  /** A request to the /me API as this person, signed in with a session cookie. */
  as(
    person: Person,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response>;
  call(path: string, init?: RequestInit & { key?: string }): Promise<Response>;
  admin(method: string, path: string, body?: unknown): Promise<Response>;
}

export interface HookCall {
  url: string;
  headers: Record<string, string>;
  body: string;
  json: Record<string, unknown>;
}

export interface HookRecorder {
  calls: HookCall[];
  /** Answers for the next calls, in order; then 200. A string throws that error. */
  replies: (number | "timeout" | "network")[];
}

export function harness(
  options: {
    providerKeys?: Partial<Record<string, string>>;
    upstreams?: Partial<Record<string, string>>;
    fetch?: typeof fetch;
    subscriptionDirs?: SubscriptionDirs;
    customConnectors?: ConnectorManifest[];
    webDir?: string;
    store?: Store;
    vault?: Vault;
    org?: Org;
    demoSignIn?: boolean;
    baseUrl?: string;
  } = {},
): Harness {
  const store = options.store ?? new Store();
  const inflight = new InFlight();
  const upstream = mockUpstream();
  const clock = { now: new Date("2026-11-07T12:00:00Z") };
  const vault = options.vault ?? new Vault();
  const sessions = new Sessions(() => clock.now);
  const org = options.org ?? new Org(null, () => clock.now);
  const workflows = new Workflows();
  const hooks: HookRecorder = { calls: [], replies: [] };
  const upstreamFetch: typeof fetch =
    options.fetch ??
    ((input, init) =>
      Promise.resolve(upstream.app.fetch(new Request(input, init))));
  const alertFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith("https://hooks.test/"))
      return upstreamFetch(input, init);
    const body = String(init?.body ?? "");
    hooks.calls.push({
      url,
      headers: { ...(init?.headers as Record<string, string>) },
      body,
      json: JSON.parse(body) as Record<string, unknown>,
    });
    const reply = hooks.replies.shift() ?? 200;
    if (reply === "timeout") {
      const err = new Error("timed out");
      err.name = "TimeoutError";
      throw err;
    }
    if (reply === "network") throw new TypeError("fetch failed");
    return new Response("ok", { status: reply });
  };
  const alerts = new Alerts({
    store,
    vault,
    fetch: alertFetch,
    now: () => clock.now,
    baseUrl: "http://127.0.0.1:4141",
    retryDelaysMs: [0, 0, 0],
    batchMs: 60_000,
  });
  const app = createApp({
    store,
    inflight,
    prices: DEFAULT_PRICES,
    providerKeys: options.providerKeys ?? {
      openai: REAL_OPENAI_KEY,
      anthropic: REAL_ANTHROPIC_KEY,
      openrouter: REAL_OPENROUTER_KEY,
    },
    upstreams: {
      openai: "http://mock/openai/v1",
      anthropic: "http://mock/anthropic/v1",
      openrouter: "http://mock/openrouter/api/v1",
      ...options.upstreams,
    },
    vault,
    sessions,
    org,
    workflows,
    alerts,
    demoSignIn: options.demoSignIn,
    baseUrl: options.baseUrl,
    customConnectors: options.customConnectors,
    webDir: options.webDir,
    fetch: upstreamFetch,
    now: () => clock.now,
    adminToken: ADMIN_TOKEN,
    subscriptionDirs: options.subscriptionDirs,
  });
  const deps = { store, inflight, now: () => clock.now };

  return {
    app,
    store,
    inflight,
    vault,
    sessions,
    org,
    workflows,
    alerts,
    hooks,
    upstream,
    clock,
    addAgent(name = "support-bot", limits = {}, extra = {}) {
      const { agent, key } = createAgent(deps, {
        name,
        owner: "Dana Ortiz",
        limits,
        endsAt: extra.endsAt,
        providers: extra.providers,
        team: extra.team,
        ownerEmail: extra.ownerEmail,
      });
      return { id: agent.id, key };
    },
    call(path, init = {}) {
      const { key, ...rest } = init;
      const headers = new Headers(rest.headers);
      if (key !== undefined) {
        if (path.startsWith("/anthropic")) headers.set("x-api-key", key);
        else headers.set("authorization", `Bearer ${key}`);
      }
      if (rest.body !== undefined && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      return Promise.resolve(app.request(path, { ...rest, headers }));
    },
    as(person, method, path, body) {
      const id = sessions.signIn(person.id);
      const headers: Record<string, string> = {
        cookie: `${SESSION_COOKIE}=${id}`,
        "content-type": "application/json",
        "x-purser-csrf": "1",
      };
      const init: RequestInit = { method, headers };
      if (body !== undefined) init.body = JSON.stringify(body);
      return Promise.resolve(app.request(path, init));
    },
    admin(method, path, body) {
      const init: RequestInit = {
        method,
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      return Promise.resolve(app.request(`/admin${path}`, init));
    },
  };
}

export const chatBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  });

export const routerBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  });

export const messagesBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    model: "claude-sonnet-4-5",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  });

/** Reads a streamed body to the end and returns the text. */
export async function readAll(response: Response): Promise<string> {
  return await response.text();
}
