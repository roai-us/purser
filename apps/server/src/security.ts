import type { Hono } from "hono";
import { z } from "zod";
import { apiError } from "./admin.js";
import { MAX_GRACE_MINUTES, rotateKey, type ControlDeps } from "./control.js";
import type { Org } from "./org.js";
import type { Registry } from "./registry.js";
import type { Agent } from "./types.js";

export interface SecurityDeps extends ControlDeps {
  org: Org;
  registry: Registry;
  demoSignIn?: boolean | undefined;
}

/** Typed by the admin, so rotating every key can't happen by accident. */
export const ROTATE_ALL_CONFIRM = "ROTATE ALL KEYS";

const rotateAllSchema = z
  .object({
    confirm: z.string(),
    reason: z.string().trim().min(3).max(500),
    department: z.string().trim().min(1).max(100).optional(),
    graceMinutes: z.number().int().min(0).max(MAX_GRACE_MINUTES).optional(),
  })
  .strict();

export interface RotateAllResult {
  rotated: number;
  /** New keys are waiting for these agents' owners, who collect them after signing in. */
  waitingForOwners: number;
  /** New keys for agents with nobody to collect them. Shown this once. */
  keys: {
    id: string;
    name: string;
    owner: string;
    team?: string;
    key: string;
  }[];
  /** Requests that were running on the old keys and were cut. */
  abortedRequests: number;
  /** When the old keys stop working, if they have an overlap. */
  oldKeysUntil?: string | undefined;
  elapsedMs: number;
}

/** Can people sign in here at all? If not, an owner has no way to collect a key. */
const peopleCanSignIn = (deps: SecurityDeps) =>
  deps.org.settings().signIn !== undefined || deps.demoSignIn === true;

/** Will this agent's owner collect the new key themselves? */
function ownerCollects(deps: SecurityDeps, agent: Agent): boolean {
  if (!agent.ownerEmail || !peopleCanSignIn(deps)) return false;
  return deps.org.findByEmail(agent.ownerEmail)?.status === "active";
}

/**
 * Replaces every agent key, or every key in one department, as when a key or
 * the server may have been exposed. Stopped agents get new keys too, since
 * an exposed key would work again the moment they were turned back on.
 *
 * With no overlap the old keys stop at once and their open requests are cut.
 * An agent whose owner can sign in gets a key nobody has seen, and the owner
 * collects a fresh one; for the rest the new key comes back in this result,
 * the only time it can be read.
 */
export function rotateAllKeys(
  deps: SecurityDeps,
  by: string,
  options: {
    reason: string;
    department?: string | undefined;
    graceMinutes?: number | undefined;
  },
): RotateAllResult {
  const started = performance.now();
  const graceMinutes = options.graceMinutes ?? 0;
  const targets = deps.store
    .listAgents()
    .filter(
      (a) => options.department === undefined || a.team === options.department,
    );
  const keys: RotateAllResult["keys"] = [];
  let waitingForOwners = 0;
  let abortedRequests = 0;
  let oldKeysUntil: string | undefined;
  deps.store.batch(() => {
    for (const agent of targets) {
      const rotated = rotateKey(deps, agent, `${by} (rotate all)`, {
        graceMinutes,
        cutOldKeys: graceMinutes === 0,
      });
      oldKeysUntil ??= rotated.previousKeyValidUntil;
      if (graceMinutes === 0) {
        abortedRequests += deps.inflight.abortAll(agent.id, "keys rotated");
      }
      if (ownerCollects(deps, agent)) {
        deps.store.updateAgent(agent.id, { awaitingKey: true });
        waitingForOwners++;
      } else {
        keys.push({
          id: agent.id,
          name: agent.name,
          owner: agent.owner,
          ...(agent.team ? { team: agent.team } : {}),
          key: rotated.key,
        });
      }
    }
  });
  const elapsedMs = performance.now() - started;
  deps.store.audit({
    at: deps.now().toISOString(),
    type: "keys.rotated_all",
    detail: {
      by,
      reason: options.reason,
      department: options.department,
      rotated: targets.length,
      waitingForOwners,
      deliveredToAdmin: keys.length,
      graceMinutes,
      abortedRequests,
    },
  });
  return {
    rotated: targets.length,
    waitingForOwners,
    keys,
    abortedRequests,
    oldKeysUntil,
    elapsedMs,
  };
}

/** Admin routes for security incidents. Added to the admin app, behind its admin check. */
export function securityRoutes(
  app: Hono<{
    Variables: { actor: string; viewer: import("./viewer.js").Viewer };
  }>,
  deps: SecurityDeps,
): void {
  app.get("/security", (c) => {
    const department = c.req.query("department") || undefined;
    const all = deps.store.listAgents();
    const scoped = all.filter(
      (a) => department === undefined || a.team === department,
    );
    const collects = scoped.filter((a) => ownerCollects(deps, a)).length;
    const history = deps.store
      .auditLog()
      .filter((e) => e.type === "keys.rotated_all")
      .slice(-5)
      .reverse()
      .map((e) => ({ at: e.at, ...e.detail }));
    return c.json({
      confirm: ROTATE_ALL_CONFIRM,
      peopleCanSignIn: peopleCanSignIn(deps),
      demoKeys: deps.demoSignIn === true,
      agents: {
        total: scoped.length,
        ownerCollects: collects,
        adminGets: scoped.length - collects,
        waiting: all.filter((a) => a.awaitingKey).length,
      },
      departments: [
        ...new Set(all.flatMap((a) => (a.team ? [a.team] : []))),
      ].sort(),
      providers: deps.registry
        .views()
        .filter((v) => v.configured)
        .map((v) => ({
          id: v.id,
          name: v.name,
          keyHint: v.keyHint,
          keySource: v.keySource,
        })),
      history,
    });
  });

  app.post("/security/rotate-all", async (c) => {
    const text = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(text || "{}");
    } catch {
      return apiError(c, 400, "invalid_json", "The request body must be JSON.");
    }
    const parsed = rotateAllSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(
        c,
        400,
        "invalid_request",
        "Say why you are rotating the keys.",
        parsed.error.issues,
      );
    }
    if (parsed.data.confirm !== ROTATE_ALL_CONFIRM) {
      return apiError(
        c,
        400,
        "confirm_required",
        `Send confirm: "${ROTATE_ALL_CONFIRM}" to rotate the keys.`,
      );
    }
    return c.json(rotateAllKeys(deps, c.get("actor"), parsed.data));
  });
}
