import type { Context, Hono } from "hono";
import { z } from "zod";
import { apiError } from "./admin.js";
import { KeyApiError, type OpenRouterKeys } from "./openrouter-keys.js";
import type { Store } from "./store.js";
import type { Viewer } from "./viewer.js";

const managementKeySchema = z
  .object({ key: z.string().trim().min(10).max(500) })
  .strict();
const enabledSchema = z.object({ enabled: z.boolean() }).strict();

/**
 * Admin routes for per-agent OpenRouter keys, behind the admin check. The
 * management key and agents' keys are never returned, only hints of them.
 */
export function openRouterKeyRoutes(
  app: Hono<{ Variables: { actor: string; viewer: Viewer } }>,
  deps: { openRouterKeys: OpenRouterKeys; store: Store; now: () => Date },
): void {
  const keys = deps.openRouterKeys;
  const json = async (c: Context): Promise<unknown> => {
    try {
      return (await c.req.json()) as unknown;
    } catch {
      return undefined;
    }
  };
  const fail = (c: Context, err: unknown) => {
    if (err instanceof KeyApiError) {
      const status =
        err.status === 409 || err.status === 400 ? err.status : 503;
      return apiError(
        c,
        status,
        status === 409
          ? "conflict"
          : status === 400
            ? "invalid_key"
            : "openrouter_error",
        err.message,
      );
    }
    throw err;
  };
  const audit = (by: string, detail: Record<string, unknown>) =>
    deps.store.audit({
      at: deps.now().toISOString(),
      type: "openrouter.changed",
      detail: { by, ...detail },
    });

  app.get("/openrouter/agent-keys", (c) => c.json(keys.view()));

  app.put("/openrouter/management-key", async (c) => {
    const parsed = managementKeySchema.safeParse(await json(c));
    if (!parsed.success) {
      return apiError(
        c,
        400,
        "invalid_request",
        "Paste an OpenRouter management key.",
        parsed.error.issues,
      );
    }
    try {
      await keys.setManagementKey(parsed.data.key);
    } catch (err) {
      return fail(c, err);
    }
    audit(c.get("actor"), { action: "management key set" });
    return c.json(keys.view());
  });

  app.delete("/openrouter/management-key", (c) => {
    try {
      keys.removeManagementKey();
    } catch (err) {
      return fail(c, err);
    }
    audit(c.get("actor"), { action: "management key removed" });
    return c.json(keys.view());
  });

  app.put("/openrouter/agent-keys", async (c) => {
    const parsed = enabledSchema.safeParse(await json(c));
    if (!parsed.success) {
      return apiError(
        c,
        400,
        "invalid_request",
        "Send { enabled: true } or { enabled: false }.",
        parsed.error.issues,
      );
    }
    try {
      keys.setEnabled(parsed.data.enabled);
    } catch (err) {
      return fail(c, err);
    }
    audit(c.get("actor"), {
      action: parsed.data.enabled ? "per-agent keys on" : "per-agent keys off",
    });
    // Keys are made and deleted in the background; the view shows progress.
    return c.json(keys.view());
  });

  app.get("/agents/:ref/openrouter-key", (c) => {
    const agent = deps.store.resolve(c.req.param("ref") ?? "");
    if (!agent) return apiError(c, 404, "not_found", "No such agent.");
    return c.json({
      enabled: keys.enabled(),
      key: keys.forAgent(agent.id) ?? null,
      failure: keys.failureFor(agent.id) ?? null,
    });
  });

  app.post("/agents/:ref/openrouter-key", async (c) => {
    const agent = deps.store.resolve(c.req.param("ref") ?? "");
    if (!agent) return apiError(c, 404, "not_found", "No such agent.");
    try {
      const key = await keys.replace(agent.id);
      audit(c.get("actor"), {
        action: "agent key replaced",
        agent: agent.name,
      });
      return c.json({ enabled: true, key, failure: null });
    } catch (err) {
      return fail(c, err);
    }
  });
}
