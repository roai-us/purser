import { secretHint } from "./keys.js";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { upstreamProblem } from "./connectors.js";
import {
  bulk,
  createAgent,
  killAgent,
  MAX_GRACE_MINUTES,
  raiseLimit,
  removeService,
  resumeAgent,
  rotateKey,
  setService,
  toPublic,
  setLimits,
  updateAgent,
  type ControlDeps,
} from "./control.js";
import type { CallLog, LogSettings } from "./logs.js";
import type { PriceTable } from "./pricing.js";
import {
  agentUsage,
  auditPage,
  listAgents,
  MAX_PAGE_SIZE,
  overview,
  statusBoard,
} from "./queries.js";
import type { Registry } from "./registry.js";
import type { Org } from "./org.js";
import { orgAdminRoutes } from "./orgadmin.js";
import { securityRoutes } from "./security.js";
import type { Sessions } from "./sessions.js";
import {
  actorOf as actorName,
  authenticate,
  isAdmin,
  type Viewer,
} from "./viewer.js";
import { scanSubscriptions, type SubscriptionDirs } from "./subscriptions.js";
import type { Agent } from "./types.js";
import type { Vault } from "./vault.js";

export interface AdminDeps extends ControlDeps {
  prices: PriceTable;
  registry: Registry;
  vault: Vault;
  sessions: Sessions;
  /** People, departments, requests and the organisation's rules. */
  org: Org;
  /** The call log: request and response bodies, when an admin turns it on. */
  logs: CallLog;
  /** Where coding tools keep their logs. Without it, subscription usage is off. */
  subscriptionDirs?: SubscriptionDirs | undefined;
  demoSignIn?: boolean | undefined;
}

type Variables = { actor: string; viewer: Viewer };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Enough for repeated replacements; the oldest reminder goes first. */
const MAX_OLD_KEYS = 20;

const money = z.number().finite().min(0);

const limitsSchema = z
  .object({
    dailyUsd: money.optional(),
    monthlyUsd: money.optional(),
    models: z.array(z.string().min(1).max(200)).max(200).optional(),
  })
  .strict();

const name = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(
    /^[\w.-]+( [\w.-]+)*$/,
    "Use letters, numbers, single spaces, dots, dashes and underscores.",
  );
const label = (max: number) => z.string().trim().min(1).max(max);
const providerList = z.array(z.string().min(1).max(40)).max(50);
const rotationSchema = z
  .object({
    everyDays: z.number().int().min(1).max(730),
    graceDays: z.number().int().min(0).max(30),
  })
  .strict();
const isoDate = z.iso.datetime({ offset: true });

const newAgentSchema = z
  .object({
    name,
    owner: label(200),
    ownerEmail: z.email().max(200).optional(),
    team: label(100).optional(),
    purpose: z.string().max(500).optional(),
    providers: providerList.optional(),
    limits: limitsSchema.optional(),
    endsAt: isoDate.optional(),
    keyExpiresAt: isoDate.optional(),
    rotation: rotationSchema.optional(),
    logCalls: z.boolean().optional(),
  })
  .strict();

const patchSchema = z
  .object({
    owner: label(200).optional(),
    ownerEmail: z.email().max(200).nullable().optional(),
    team: label(100).nullable().optional(),
    purpose: z.string().max(500).nullable().optional(),
    providers: providerList.nullable().optional(),
    limits: limitsSchema.optional(),
    endsAt: isoDate.nullable().optional(),
    keyExpiresAt: isoDate.nullable().optional(),
    rotation: rotationSchema.nullable().optional(),
    logCalls: z.boolean().optional(),
  })
  .strict();

export const raiseSchema = z
  .object({
    window: z.enum(["day", "month"]),
    amountUsd: z.number().min(0.01).max(1_000_000),
    reason: z.string().trim().max(200).optional(),
  })
  .strict();

const serviceLimitSchema = z
  .object({
    dailyUsd: money.optional(),
    monthlyUsd: money.optional(),
    models: z.array(z.string().min(1).max(200)).max(200).optional(),
  })
  .strict();

const loggingSchema = z
  .object({
    mode: z.enum(["off", "all", "selected"]).optional(),
    retentionDays: z.number().int().min(1).max(365).optional(),
    maxKb: z.number().int().min(1).max(1024).optional(),
  })
  .strict();

const actorSchema = z
  .object({ by: z.string().min(1).max(200).optional() })
  .strict();

export const rotateSchema = z
  .object({
    graceMinutes: z.number().int().min(0).max(MAX_GRACE_MINUTES).optional(),
    keyExpiresAt: isoDate.optional(),
  })
  .strict();

const bulkSchema = z
  .object({
    action: z.enum(["kill", "resume", "rotate-key"]),
    ids: z.array(z.string().min(1).max(200)).min(1).max(1000),
    graceMinutes: z.number().int().min(0).max(MAX_GRACE_MINUTES).optional(),
    keyExpiresAt: isoDate.optional(),
  })
  .strict();

export const listSchema = z.object({
  q: z.string().max(200).optional(),
  in: z.enum(["all", "name", "owner", "team", "provider"]).optional(),
  state: z
    .enum([
      "running",
      "paused",
      "at_limit",
      "expired",
      "key_expired",
      "not_running",
    ])
    .optional(),
  light: z.enum(["green", "yellow", "red"]).optional(),
  keyState: z.enum(["ok", "expiring", "expired"]).optional(),
  awaitingKey: z
    .enum(["1"])
    .transform(() => true)
    .optional(),
  provider: z.string().max(40).optional(),
  owner: z.string().max(200).optional(),
  team: z.string().max(100).optional(),
  sort: z
    .enum([
      "name",
      "spend_today",
      "spend_month",
      "created",
      "last_used",
      "key_expires",
    ])
    .optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
});

const providerKeySchema = z
  .object({
    apiKey: z.string().trim().min(8).max(4096),
    upstream: z.string().max(500).optional(),
  })
  .strict();

/** The admin API's error shape: `{ error: { code, message } }`. */
export function apiError(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503,
  code: string,
  message: string,
  issues?: unknown,
): Response {
  const error: Record<string, unknown> = { code, message };
  if (issues !== undefined) error.issues = issues;
  return c.json({ error }, status);
}

class BadJson extends Error {}

/**
 * The admin API. It takes the admin token or a signed-in browser session,
 * never an agent key, so an agent cannot read, change or stop anything here,
 * including its own limits.
 */
export function adminApp(
  deps: AdminDeps,
  adminToken: string,
): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.use("*", async (c, next) => {
    const auth = authenticate(c, deps, adminToken);
    if (!auth.ok) return apiError(c, auth.status, auth.code, auth.message);
    if (!isAdmin(auth.viewer)) {
      return apiError(c, 403, "forbidden", "Only admins can do this.");
    }
    c.set("viewer", auth.viewer);
    c.set("actor", actorName(auth.viewer));
    return next();
  });

  app.onError((err, c) => {
    if (err instanceof BadJson) {
      return apiError(c, 400, "invalid_json", "The request body must be JSON.");
    }
    console.error(err);
    return apiError(c, 500, "internal", "Internal error.");
  });

  const now = () => deps.now();
  const present = (agent: Agent) => toPublic(agent, deps.store, now());

  const find = (c: Context): Agent | Response => {
    const agent = deps.store.resolve(c.req.param("ref") ?? "");
    return agent ?? apiError(c, 404, "not_found", "No such agent.");
  };

  const readJson = async (c: Context): Promise<unknown> => {
    const text = await c.req.text();
    if (text.trim() === "") return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new BadJson();
    }
  };

  const invalid = (c: Context, what: string, issues: unknown) =>
    apiError(c, 400, "invalid_request", `Invalid ${what}.`, issues);

  /** A key expiry must be in the future. */
  const pastExpiry = (c: Context, at: string | null | undefined) =>
    at !== undefined && at !== null && Date.parse(at) <= now().getTime()
      ? apiError(
          c,
          400,
          "invalid_request",
          "keyExpiresAt must be in the future.",
        )
      : null;

  const unknownProviders = (ids: string[] | null | undefined): string[] =>
    (ids ?? []).filter((id) => !deps.registry.has(id));

  const actorOf = (c: Context<{ Variables: Variables }>, body: unknown) => {
    const parsed = actorSchema.safeParse(body);
    return parsed.success && parsed.data.by ? parsed.data.by : c.get("actor");
  };

  // Agents

  app.get("/agents", (c) => {
    const parsed = listSchema.safeParse(c.req.query());
    if (!parsed.success) return invalid(c, "query", parsed.error.issues);
    const names = new Map(deps.registry.providers.map((p) => [p.id, p.name]));
    return c.json(listAgents(deps.store, now(), parsed.data, names));
  });

  app.post("/agents", async (c) => {
    const parsed = newAgentSchema.safeParse(await readJson(c));
    if (!parsed.success) return invalid(c, "agent", parsed.error.issues);
    const unknown = unknownProviders(parsed.data.providers);
    if (unknown.length > 0) {
      return apiError(
        c,
        400,
        "unknown_provider",
        `No connector ${unknown.join(", ")}.`,
      );
    }
    const past = pastExpiry(c, parsed.data.keyExpiresAt);
    if (past) return past;
    if (deps.store.findByName(parsed.data.name)) {
      return apiError(
        c,
        409,
        "name_taken",
        `An agent named "${parsed.data.name}" already exists.`,
      );
    }
    return c.json(createAgent(deps, parsed.data), 201);
  });

  app.post("/agents/bulk", async (c) => {
    const parsed = bulkSchema.safeParse(await readJson(c));
    if (!parsed.success) return invalid(c, "bulk action", parsed.error.issues);
    const { action, ids, graceMinutes, keyExpiresAt } = parsed.data;
    const past = pastExpiry(c, keyExpiresAt);
    if (past) return past;
    return c.json(
      bulk(deps, action, ids, c.get("actor"), { graceMinutes, keyExpiresAt }),
    );
  });

  app.get("/agents/:ref", (c) => {
    const agent = find(c);
    if (agent instanceof Response) return agent;
    return c.json(present(agent));
  });

  app.patch("/agents/:ref", async (c) => {
    const agent = find(c);
    if (agent instanceof Response) return agent;
    const parsed = patchSchema.safeParse(await readJson(c));
    if (!parsed.success) return invalid(c, "change", parsed.error.issues);
    const unknown = unknownProviders(parsed.data.providers);
    if (unknown.length > 0) {
      return apiError(
        c,
        400,
        "unknown_provider",
        `No connector ${unknown.join(", ")}.`,
      );
    }
    const past = pastExpiry(c, parsed.data.keyExpiresAt);
    if (past) return past;
    return c.json(updateAgent(deps, agent, parsed.data, c.get("actor")));
  });

  // Kept for the CLI: change only the limits.
  app.patch("/agents/:ref/limits", async (c) => {
    const agent = find(c);
    if (agent instanceof Response) return agent;
    const parsed = limitsSchema.safeParse(await readJson(c));
    if (!parsed.success) return invalid(c, "limits", parsed.error.issues);
    return c.json({
      agent: setLimits(deps, agent, parsed.data, c.get("actor")),
    });
  });

  app.post("/agents/:ref/kill", async (c) => {
    const agent = find(c);
    if (agent instanceof Response) return agent;
    return c.json(killAgent(deps, agent, actorOf(c, await readJson(c))));
  });

  app.post("/agents/:ref/resume", async (c) => {
    const agent = find(c);
    if (agent instanceof Response) return agent;
    return c.json({
      agent: resumeAgent(deps, agent, actorOf(c, await readJson(c))),
    });
  });

  app.post("/agents/:ref/rotate-key", async (c) => {
    const agent = find(c);
    if (agent instanceof Response) return agent;
    const parsed = rotateSchema.safeParse(await readJson(c));
    if (!parsed.success) return invalid(c, "rotation", parsed.error.issues);
    const past = pastExpiry(c, parsed.data.keyExpiresAt);
    if (past) return past;
    return c.json(rotateKey(deps, agent, c.get("actor"), parsed.data));
  });

  app.post("/agents/:ref/raise-limit", async (c) => {
    const agent = find(c);
    if (agent instanceof Response) return agent;
    const parsed = raiseSchema.safeParse(await readJson(c));
    if (!parsed.success) return invalid(c, "raise", parsed.error.issues);
    const base =
      parsed.data.window === "day"
        ? agent.limits.dailyUsd
        : agent.limits.monthlyUsd;
    if (base === undefined) {
      return apiError(
        c,
        400,
        "no_limit",
        `This agent has no ${parsed.data.window === "day" ? "daily" : "monthly"} limit to raise.`,
      );
    }
    const { reason, ...rest } = parsed.data;
    return c.json({
      agent: raiseLimit(
        deps,
        agent,
        reason ? { ...rest, reason } : rest,
        c.get("actor"),
      ),
    });
  });

  app.put("/agents/:ref/services/:provider", async (c) => {
    const agent = find(c);
    if (agent instanceof Response) return agent;
    const provider = c.req.param("provider");
    if (!deps.registry.has(provider)) {
      return apiError(
        c,
        400,
        "unknown_provider",
        `Purser has no provider called ${provider}.`,
      );
    }
    const parsed = serviceLimitSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return invalid(c, "service limit", parsed.error.issues);
    }
    return c.json(
      setService(deps, agent, provider, parsed.data, c.get("actor")),
    );
  });

  app.delete("/agents/:ref/services/:provider", (c) => {
    const agent = find(c);
    if (agent instanceof Response) return agent;
    const provider = c.req.param("provider");
    if (agent.providers?.length === 1 && agent.providers[0] === provider) {
      return apiError(
        c,
        409,
        "last_service",
        "This is the agent's only service. Stop the agent instead.",
      );
    }
    return c.json(removeService(deps, agent, provider, c.get("actor")));
  });

  app.get("/agents/:ref/usage", (c) => {
    const agent = find(c);
    if (agent instanceof Response) return agent;
    const days = Number(c.req.query("days") ?? 30);
    if (!Number.isFinite(days) || days < 1) {
      return apiError(c, 400, "invalid_request", "days must be 1 or more.");
    }
    return c.json(agentUsage(deps.store, agent.id, now(), days));
  });

  app.post("/kill-all", (c) => {
    const active = deps.store
      .listAgents()
      .filter((agent) => agent.status === "active");
    const result = bulk(
      deps,
      "kill",
      active.map((a) => a.id),
      `${c.get("actor")} (kill-all)`,
    );
    return c.json({
      paused: result.results.length,
      abortedRequests: result.abortedRequests ?? 0,
      elapsedMs: result.elapsedMs,
    });
  });

  app.get("/status", (c) => {
    const limit = Number(c.req.query("limit") ?? 100);
    return c.json(
      statusBoard(deps.store, now(), Number.isFinite(limit) ? limit : 100),
    );
  });

  app.get("/overview", (c) =>
    c.json(
      overview(deps.store, now(), {
        configured: deps.registry.configuredCount(),
        total: deps.registry.providers.length,
      }),
    ),
  );

  // Providers (connectors)

  app.get("/providers", (c) => c.json(deps.registry.views()));

  app.put("/providers/:id/key", async (c) => {
    const id = c.req.param("id");
    const provider = deps.registry.get(id);
    if (!provider) return apiError(c, 404, "not_found", "No such connector.");
    const parsed = providerKeySchema.safeParse(await readJson(c));
    if (!parsed.success) return invalid(c, "key", parsed.error.issues);
    const { apiKey, upstream } = parsed.data;
    if (upstream !== undefined) {
      if (!provider.manifest.needsUpstream) {
        return apiError(
          c,
          400,
          "upstream_not_allowed",
          `${provider.name} always uses its own address.`,
        );
      }
      const problem = upstreamProblem(upstream);
      if (problem) return apiError(c, 400, "invalid_upstream", problem);
    } else if (
      provider.manifest.needsUpstream &&
      deps.vault.get(id)?.upstream === undefined &&
      deps.registry.upstreamFor(id) === undefined
    ) {
      return apiError(
        c,
        400,
        "upstream_required",
        `${provider.name} needs your resource address as well as a key.`,
      );
    }
    const cleanUpstream = upstream?.replace(/\/+$/, "");
    const saved = {
      apiKey,
      ...(cleanUpstream === undefined ? {} : { upstream: cleanUpstream }),
      updatedAt: now().toISOString(),
    };
    const current = deps.registry.keyFor(id);
    if (current === undefined) {
      deps.vault.set(id, { ...saved, lastTest: undefined });
      deps.store.audit({
        at: now().toISOString(),
        type: "provider.key_set",
        detail: { provider: id, by: c.get("actor") },
      });
      await deps.registry.test(id);
      return c.json(deps.registry.view(id));
    }

    // Every agent on this provider runs on the current key, so a replacement
    // has to work before it takes over. A bad paste changes nothing.
    if (apiKey === current) {
      return apiError(
        c,
        400,
        "same_key",
        `That's the key already in use. Make a new one at ${provider.name}.`,
      );
    }
    const test = await deps.registry.tryKey(id, apiKey, cleanUpstream);
    if (!test.ok) {
      deps.store.audit({
        at: now().toISOString(),
        type: "provider.key_rejected",
        detail: { provider: id, by: c.get("actor") },
      });
      return apiError(
        c,
        422,
        "key_test_failed",
        `${test.error ?? "The test failed."} Nothing changed: Purser is still using your current key.`,
      );
    }
    // A key the provider turned down, such as a typo during setup, can't be
    // used by anyone, so it isn't worth a reminder.
    const entry = deps.vault.get(id);
    const oldKeys = [
      ...(entry?.oldKeys ?? []),
      ...(entry?.lastTest?.rejected
        ? []
        : [{ hint: secretHint(current), replacedAt: now().toISOString() }]),
    ].slice(-MAX_OLD_KEYS);
    deps.vault.set(id, { ...saved, lastTest: test, oldKeys });
    deps.store.audit({
      at: now().toISOString(),
      type: "provider.key_rotated",
      detail: {
        provider: id,
        by: c.get("actor"),
        oldKey: secretHint(current),
        newKey: secretHint(apiKey),
      },
    });
    return c.json(deps.registry.view(id));
  });

  // A person's word that they deleted them: Purser can't check at the provider.
  app.post("/providers/:id/old-keys/deleted", (c) => {
    const id = c.req.param("id");
    if (!deps.registry.has(id)) {
      return apiError(c, 404, "not_found", "No such connector.");
    }
    const oldKeys = deps.vault.get(id)?.oldKeys ?? [];
    if (oldKeys.length > 0) {
      deps.vault.set(id, { oldKeys: undefined });
      deps.store.audit({
        at: now().toISOString(),
        type: "provider.old_keys_deleted",
        detail: {
          provider: id,
          by: c.get("actor"),
          keys: oldKeys.map((k) => k.hint),
        },
      });
    }
    return c.json(deps.registry.view(id));
  });

  app.post("/providers/:id/test", async (c) => {
    const id = c.req.param("id");
    if (!deps.registry.has(id)) {
      return apiError(c, 404, "not_found", "No such connector.");
    }
    const { at: _at, ...result } = await deps.registry.test(id);
    return c.json(result);
  });

  app.delete("/providers/:id/key", (c) => {
    const id = c.req.param("id");
    if (!deps.registry.has(id)) {
      return apiError(c, 404, "not_found", "No such connector.");
    }
    deps.vault.removeKey(id);
    deps.store.audit({
      at: now().toISOString(),
      type: "provider.key_removed",
      detail: { provider: id, by: c.get("actor") },
    });
    return c.json(deps.registry.view(id));
  });

  // Activity

  app.get("/usage", (c) => {
    const ref = c.req.query("agent");
    const agent = ref === undefined ? undefined : deps.store.resolve(ref);
    if (ref !== undefined && !agent) {
      return apiError(c, 404, "not_found", "No such agent.");
    }
    const limit = Math.min(
      1000,
      Math.max(1, Number(c.req.query("limit") ?? 100) || 100),
    );
    return c.json({ usage: deps.store.recentUsage(limit, agent?.id) });
  });

  app.get("/audit", (c) => {
    const ref = c.req.query("agent");
    const agent = ref === undefined ? undefined : deps.store.resolve(ref);
    if (ref !== undefined && !agent) {
      return apiError(c, 404, "not_found", "No such agent.");
    }
    const limit = Number(c.req.query("limit") ?? 100);
    const options: { limit: number; before?: string; agentId?: string } = {
      limit: Number.isFinite(limit) ? limit : 100,
    };
    const before = c.req.query("before");
    if (before !== undefined) options.before = before;
    if (agent) options.agentId = agent.id;
    return c.json(auditPage(deps.store, options));
  });

  // Settings

  app.get("/settings", (c) => c.json({ logging: deps.logs.settings() }));

  app.put("/settings/logging", async (c) => {
    const parsed = loggingSchema.safeParse(await readJson(c));
    if (!parsed.success) return invalid(c, "logging", parsed.error.issues);
    const before = deps.logs.settings();
    const patch: Partial<LogSettings> = {};
    if (parsed.data.mode !== undefined) patch.mode = parsed.data.mode;
    if (parsed.data.retentionDays !== undefined) {
      patch.retentionDays = parsed.data.retentionDays;
    }
    if (parsed.data.maxKb !== undefined) patch.maxKb = parsed.data.maxKb;
    const after = deps.logs.update(patch);
    deps.store.audit({
      at: now().toISOString(),
      type: "settings.changed",
      detail: {
        by: c.get("actor"),
        setting: "logging",
        from: before,
        to: after,
      },
    });
    return c.json({ logging: after });
  });

  // Call log. Bodies can hold anything an agent sends, so every read of one
  // is recorded in the audit log.

  app.get("/logs", (c) => {
    const ref = c.req.query("agent");
    const agent = ref ? deps.store.resolve(ref) : undefined;
    if (ref && !agent) return apiError(c, 404, "not_found", "No such agent.");
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json({
      ...deps.logs.list({
        agentId: agent?.id,
        before: c.req.query("before"),
        limit: Number.isFinite(limit) ? limit : 50,
      }),
      settings: deps.logs.settings(),
    });
  });

  app.get("/logs/:id", (c) => {
    const entry = deps.logs.get(c.req.param("id"));
    if (!entry) {
      return apiError(
        c,
        404,
        "not_found",
        "No such call in the log. It may have passed its retention period.",
      );
    }
    deps.store.audit({
      at: now().toISOString(),
      type: "log.viewed",
      agentId: entry.agentId,
      detail: { by: c.get("actor"), call: entry.id },
    });
    return c.json(entry);
  });

  // Read-only: what the user's own coding tools logged on this machine, priced
  // at API rates. Purser cannot cap or stop subscription usage.
  app.get("/subscriptions", async (c) => {
    if (!deps.subscriptionDirs) {
      return apiError(
        c,
        404,
        "not_enabled",
        "Subscription usage is not enabled.",
      );
    }
    const since =
      c.req.query("since") ?? `${now().toISOString().slice(0, 7)}-01`;
    if (!DAY.test(since) || Number.isNaN(Date.parse(`${since}T00:00:00Z`))) {
      return apiError(
        c,
        400,
        "invalid_request",
        "since must be a day, like 2026-11-01.",
      );
    }
    return c.json(
      await scanSubscriptions(deps.subscriptionDirs, deps.prices, since),
    );
  });

  orgAdminRoutes(app, deps);
  securityRoutes(app, deps);

  app.notFound((c) => apiError(c, 404, "not_found", "Not found."));

  return app;
}
