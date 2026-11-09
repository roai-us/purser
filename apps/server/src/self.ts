import { Hono, type Context } from "hono";
import { z } from "zod";
import { apiError, listSchema, raiseSchema, rotateSchema } from "./admin.js";
import {
  killAgent,
  raiseLimit,
  removeService,
  resumeAgent,
  rotateKey,
  setService,
  toPublic,
} from "./control.js";
import type { Org } from "./org.js";
import { agentUsage, listAgents, statusBoard } from "./queries.js";
import type { Registry } from "./registry.js";
import {
  approve,
  askForAgent,
  askForRaise,
  askForService,
  cancel,
  decidable,
  deny,
  newestPendingFirst,
  Refusal,
  type SelfServiceDeps,
} from "./selfservice.js";
import type { Sessions } from "./sessions.js";
import type { Agent } from "./types.js";
import {
  actorOf,
  authenticate,
  canSee,
  manages,
  owns,
  roleOf,
  type Viewer,
} from "./viewer.js";

export interface SelfDeps extends SelfServiceDeps {
  sessions: Sessions;
  org: Org;
  registry: Registry;
}

type Env = { Variables: { viewer: Viewer } };

const name = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(
    /^[\w.-]+( [\w.-]+)*$/,
    "Use letters, numbers, single spaces, dots, dashes and underscores.",
  );

const askSchema = z
  .object({
    name,
    purpose: z.string().trim().min(3).max(500),
    providers: z.array(z.string().min(1).max(40)).max(20).optional(),
    dailyUsd: z.number().min(0.01).max(100_000),
    monthlyUsd: z.number().min(0.01).max(1_000_000).optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

const serviceAskSchema = z
  .object({
    provider: z.string().min(1).max(40),
    dailyUsd: z.number().min(0.01).max(100_000),
    monthlyUsd: z.number().min(0.01).max(1_000_000).optional(),
    models: z.array(z.string().min(1).max(200)).max(50).optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

const decisionSchema = z
  .object({ note: z.string().trim().max(500).optional() })
  .strict();

/**
 * The API for everyone who signs in: their own agents, the agents of the
 * departments they manage, their requests, and the requests they decide.
 * Admins can use it too; their admin pages use /admin.
 */
export function selfApp(deps: SelfDeps, adminToken: string): Hono<Env> {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    const auth = authenticate(c, deps, adminToken);
    if (!auth.ok) return apiError(c, auth.status, auth.code, auth.message);
    c.set("viewer", auth.viewer);
    return next();
  });

  app.onError((err, c) => {
    if (err instanceof Refusal) {
      return apiError(c, err.status, err.code, err.message);
    }
    if (err instanceof SyntaxError) {
      return apiError(c, 400, "invalid_json", "The request body must be JSON.");
    }
    console.error(err);
    return apiError(c, 500, "internal", "Internal error.");
  });

  const now = () => deps.now();
  const viewerOf = (c: Context<Env>) => c.get("viewer");
  const body = async (c: Context) => {
    const text = await c.req.text();
    return text.trim() === "" ? {} : (JSON.parse(text) as unknown);
  };
  /** The agent named in the path, if this viewer may see it. */
  const visibleAgent = (c: Context<Env>): Agent => {
    const agent = deps.store.resolve(c.req.param("ref") ?? "");
    if (!agent || !canSee(viewerOf(c), agent)) {
      throw new Refusal(404, "not_found", "No such agent.");
    }
    return agent;
  };
  const personOnly = (viewer: Viewer) => {
    if (viewer.kind !== "person") {
      throw new Refusal(
        403,
        "person_only",
        "Sign in with a company account to do this, or use the admin pages.",
      );
    }
    return viewer.person;
  };

  app.get("/", (c) => {
    const viewer = viewerOf(c);
    const person = viewer.kind === "person" ? viewer.person : undefined;
    const settings = deps.org.settings();
    return c.json({
      viewer: {
        kind: viewer.kind,
        role: roleOf(viewer),
        name: person?.name ?? "Purser admin",
        email: person?.email,
        department: person?.department,
        manages: person?.manages,
      },
      selfService: settings.selfService,
      policy: deps.org.policyFor(person?.department),
      providers: deps.registry
        .views()
        .filter((v) => v.configured)
        .map((v) => ({
          id: v.id,
          name: v.name,
          kind: v.kind,
          agentBaseUrl: v.agentBaseUrl,
          envHint: v.envHint,
          configured: v.configured,
          testModel: v.testModel,
          docsUrl: v.docsUrl,
          source: v.source,
          costSource: v.costSource,
        })),
      mcp: {
        enabled: settings.mcp !== false,
        url: `${deps.registry.baseUrl}/mcp`,
      },
      keysWaiting: deps.store
        .listAgents()
        .filter((a) => a.awaitingKey && owns(viewer, a)).length,
      pending: {
        mine: deps.org
          .listRequests()
          .filter((r) => r.by === person?.email && r.status === "pending")
          .length,
        toDecide: decidable(deps.org, viewer).filter(
          (r) => r.status === "pending",
        ).length,
      },
    });
  });

  // Agents

  const scoped = (c: Context<Env>) => {
    const viewer = viewerOf(c);
    const scope = c.req.query("scope") === "team" ? "team" : "mine";
    return (agent: Agent) =>
      scope === "mine" ? owns(viewer, agent) : canSee(viewer, agent);
  };

  app.get("/agents", (c) => {
    const parsed = listSchema.safeParse(c.req.query());
    if (!parsed.success) {
      return apiError(c, 400, "invalid_request", "Invalid query.");
    }
    const names = new Map(deps.registry.providers.map((p) => [p.id, p.name]));
    return c.json(listAgents(deps.store, now(), parsed.data, names, scoped(c)));
  });

  app.get("/status", (c) =>
    c.json(statusBoard(deps.store, now(), 60, scoped(c))),
  );

  app.post("/agents", async (c) => {
    const person = personOnly(viewerOf(c));
    const parsed = askSchema.safeParse(await body(c));
    if (!parsed.success) {
      return apiError(
        c,
        400,
        "invalid_request",
        "Check the agent's details.",
        parsed.error.issues,
      );
    }
    const result = askForAgent(deps, person, parsed.data);
    return c.json(result, result.status === "ready" ? 201 : 202);
  });

  app.get("/agents/:ref", (c) =>
    c.json(toPublic(visibleAgent(c), deps.store, now())),
  );

  app.get("/agents/:ref/usage", (c) => {
    const agent = visibleAgent(c);
    const days = Math.max(
      1,
      Math.min(366, Number(c.req.query("days") ?? 30) || 30),
    );
    return c.json(agentUsage(deps.store, agent.id, now(), days));
  });

  app.post("/agents/:ref/kill", (c) => {
    const agent = visibleAgent(c);
    return c.json(killAgent(deps, agent, actorOf(viewerOf(c))));
  });

  app.post("/agents/:ref/resume", (c) => {
    const viewer = viewerOf(c);
    const agent = visibleAgent(c);
    // An owner can turn on what they stopped; something a manager or admin
    // stopped stays off until one of them says otherwise.
    if (
      !manages(viewer, agent) &&
      agent.pausedBy !== undefined &&
      agent.pausedBy !== actorOf(viewer)
    ) {
      throw new Refusal(
        403,
        "stopped_by_other",
        `${agent.pausedBy} stopped this agent, so only a manager or admin can turn it back on.`,
      );
    }
    return c.json({ agent: resumeAgent(deps, agent, actorOf(viewer)) });
  });

  app.post("/agents/:ref/rotate-key", async (c) => {
    const agent = visibleAgent(c);
    const parsed = rotateSchema.safeParse(await body(c));
    if (!parsed.success) {
      return apiError(c, 400, "invalid_request", "Invalid rotation.");
    }
    return c.json(
      rotateKey(deps, agent, actorOf(viewerOf(c)), {
        graceMinutes: parsed.data.graceMinutes,
      }),
    );
  });

  app.post("/agents/:ref/raise-limit", async (c) => {
    const viewer = viewerOf(c);
    const agent = visibleAgent(c);
    const parsed = raiseSchema.safeParse(await body(c));
    if (!parsed.success) {
      return apiError(c, 400, "invalid_request", "Invalid raise.");
    }
    const base =
      parsed.data.window === "day"
        ? agent.limits.dailyUsd
        : agent.limits.monthlyUsd;
    if (base === undefined) {
      throw new Refusal(400, "no_limit", "This agent has no such limit.");
    }
    if (manages(viewer, agent)) {
      const { reason, ...rest } = parsed.data;
      return c.json({
        status: "raised",
        agent: raiseLimit(
          deps,
          agent,
          reason ? { ...rest, reason } : rest,
          actorOf(viewer),
        ),
      });
    }
    const request = askForRaise(
      deps,
      personOnly(viewer),
      agent.id,
      parsed.data,
    );
    return c.json({ status: "pending", request }, 202);
  });

  // Services

  app.post("/agents/:ref/services", async (c) => {
    const viewer = viewerOf(c);
    const agent = visibleAgent(c);
    const parsed = serviceAskSchema.safeParse(await body(c));
    if (!parsed.success) {
      return apiError(
        c,
        400,
        "invalid_request",
        "Check the service and its limits.",
        parsed.error.issues,
      );
    }
    if (manages(viewer, agent)) {
      const { provider, dailyUsd, monthlyUsd, models } = parsed.data;
      if (!deps.registry.has(provider)) {
        throw new Refusal(
          400,
          "unknown_provider",
          `Unknown provider ${provider}.`,
        );
      }
      return c.json({
        status: "granted",
        agent: setService(
          deps,
          agent,
          provider,
          {
            dailyUsd,
            ...(monthlyUsd !== undefined ? { monthlyUsd } : {}),
            ...(models?.length ? { models } : {}),
          },
          actorOf(viewer),
        ),
      });
    }
    const result = askForService(deps, personOnly(viewer), agent, parsed.data);
    return c.json(result, result.status === "granted" ? 200 : 202);
  });

  app.delete("/agents/:ref/services/:provider", (c) => {
    const viewer = viewerOf(c);
    const agent = visibleAgent(c);
    const provider = c.req.param("provider");
    if (agent.providers?.length === 1 && agent.providers[0] === provider) {
      throw new Refusal(
        409,
        "last_service",
        "This is the agent's only service. Stop the agent instead.",
      );
    }
    // Taking a service off a list only narrows what the agent can do. On an
    // agent allowed any provider it would just lift a limit, which an owner
    // can't do.
    if (!agent.providers && !manages(viewer, agent)) {
      throw new Refusal(
        403,
        "manager_only",
        "Only a manager or admin can lift a limit on this agent.",
      );
    }
    return c.json(removeService(deps, agent, provider, actorOf(viewer)));
  });

  // Requests

  app.get("/requests", (c) => {
    const viewer = viewerOf(c);
    const email = viewer.kind === "person" ? viewer.person.email : null;
    return c.json({
      items: deps.org
        .listRequests()
        .filter((r) => r.by === email)
        .sort(newestPendingFirst),
    });
  });

  app.post("/requests/:id/cancel", (c) => {
    const request = deps.org.getRequest(c.req.param("id"));
    if (!request) throw new Refusal(404, "not_found", "No such request.");
    return c.json(cancel(deps, personOnly(viewerOf(c)), request));
  });

  app.get("/approvals", (c) => {
    const viewer = viewerOf(c);
    if (roleOf(viewer) === "member") return c.json({ items: [] });
    const status = c.req.query("status");
    return c.json({
      items: decidable(deps.org, viewer).filter(
        (r) => !status || r.status === status,
      ),
    });
  });

  const decide = (kind: "approve" | "deny") =>
    app.post(`/approvals/:id/${kind}`, async (c) => {
      const request = deps.org.getRequest(c.req.param("id"));
      if (!request) throw new Refusal(404, "not_found", "No such request.");
      const parsed = decisionSchema.safeParse(await body(c));
      if (!parsed.success) {
        return apiError(c, 400, "invalid_request", "Invalid note.");
      }
      const fn = kind === "approve" ? approve : deny;
      return c.json(fn(deps, viewerOf(c), request, parsed.data.note));
    });
  decide("approve");
  decide("deny");

  app.notFound((c) => apiError(c, 404, "not_found", "Not found."));
  return app;
}
