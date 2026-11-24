import type { Context, Hono } from "hono";
import { z } from "zod";
import { apiError } from "./admin.js";
import {
  ALERT_TYPE_WORDS,
  ALERT_TYPES,
  webhookProblem,
  type Alerts,
} from "./alerts.js";
import type { Store } from "./store.js";
import type { Viewer } from "./viewer.js";

const types = z.array(z.enum(ALERT_TYPES)).max(ALERT_TYPES.length);
const name = z.string().trim().min(1).max(80);
const url = z.string().trim().min(8).max(2000);

const newChannelSchema = z
  .object({
    name,
    kind: z.enum(["webhook", "slack", "discord"]),
    url,
    events: types.optional(),
  })
  .strict();

const patchChannelSchema = z
  .object({
    name: name.optional(),
    url: url.optional(),
    events: types.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const settingsSchema = z
  .object({
    nearLimitPercent: z.number().int().min(1).max(99).optional(),
    spikeMultiple: z.number().min(1.5).max(100).optional(),
    spikeMinUsd: z.number().min(0).max(1_000_000).optional(),
    keyExpiringDays: z.number().int().min(1).max(90).optional(),
  })
  .strict();

/**
 * Admin routes for alert channels, thresholds and history. Added to the
 * admin app, behind its admin check. Channel URLs are secrets: they are kept
 * in the vault and never returned, only a hint of them.
 */
export function alertRoutes(
  app: Hono<{ Variables: { actor: string; viewer: Viewer } }>,
  deps: { alerts: Alerts; store: Store; now: () => Date },
): void {
  const json = async (c: Context): Promise<unknown> => {
    const text = await c.req.text();
    if (text.trim() === "") return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  };
  const invalid = (c: Context, issues: unknown) =>
    apiError(c, 400, "invalid_request", "Invalid alert settings.", issues);
  const audit = (by: string, detail: Record<string, unknown>) =>
    deps.store.audit({
      at: deps.now().toISOString(),
      type: "alerts.changed",
      detail: { by, ...detail },
    });

  app.get("/alerts", (c) => {
    const limit = Math.min(
      Math.max(Number(c.req.query("limit") ?? 50) || 50, 1),
      200,
    );
    return c.json({
      settings: deps.alerts.settings(),
      channels: deps.alerts.channels(),
      types: ALERT_TYPES.map((type) => ({
        type,
        words: ALERT_TYPE_WORDS[type],
      })),
      recent: deps.alerts.recent(limit),
    });
  });

  app.put("/alerts/settings", async (c) => {
    const parsed = settingsSchema.safeParse(await json(c));
    if (!parsed.success) return invalid(c, parsed.error.issues);
    const patch = Object.fromEntries(
      Object.entries(parsed.data).filter(([, v]) => v !== undefined),
    );
    const settings = deps.alerts.setSettings(patch);
    audit(c.get("actor"), { settings: patch });
    return c.json({ settings });
  });

  app.post("/alerts/channels", async (c) => {
    const parsed = newChannelSchema.safeParse(await json(c));
    if (!parsed.success) return invalid(c, parsed.error.issues);
    const problem = webhookProblem(parsed.data.url);
    if (problem) return apiError(c, 400, "invalid_url", problem);
    const created = deps.alerts.addChannel({
      name: parsed.data.name,
      kind: parsed.data.kind,
      url: parsed.data.url,
      events: parsed.data.events ?? [],
    });
    audit(c.get("actor"), {
      channel: created.channel.name,
      kind: created.channel.kind,
      action: "added",
    });
    return c.json(created, 201);
  });

  const find = (c: Context) => {
    const id = c.req.param("id") ?? "";
    return deps.alerts.getChannel(id)
      ? id
      : apiError(c, 404, "not_found", "No such alert channel.");
  };

  app.patch("/alerts/channels/:id", async (c) => {
    const id = find(c);
    if (id instanceof Response) return id;
    const parsed = patchChannelSchema.safeParse(await json(c));
    if (!parsed.success) return invalid(c, parsed.error.issues);
    if (parsed.data.url !== undefined) {
      const problem = webhookProblem(parsed.data.url);
      if (problem) return apiError(c, 400, "invalid_url", problem);
    }
    const channel = deps.alerts.updateChannel(id, parsed.data);
    audit(c.get("actor"), {
      channel: channel.name,
      action: "changed",
      fields: Object.keys(parsed.data),
    });
    return c.json({ channel });
  });

  app.delete("/alerts/channels/:id", (c) => {
    const id = find(c);
    if (id instanceof Response) return id;
    const channel = deps.alerts.getChannel(id);
    deps.alerts.removeChannel(id);
    audit(c.get("actor"), { channel: channel?.name, action: "removed" });
    return c.json({ removed: id });
  });

  app.post("/alerts/channels/:id/test", async (c) => {
    const id = find(c);
    if (id instanceof Response) return id;
    return c.json({ delivery: await deps.alerts.test(id) });
  });
}
