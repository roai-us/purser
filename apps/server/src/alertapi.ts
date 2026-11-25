import type { Context, Hono } from "hono";
import { z } from "zod";
import { apiError } from "./admin.js";
import {
  ALERT_TYPE_WORDS,
  ALERT_TYPES,
  webhookProblem,
  type Alerts,
} from "./alerts.js";
import { SMTP_SECURITY, smtpProblem } from "./mail.js";
import type { Store } from "./store.js";
import type { Viewer } from "./viewer.js";

const types = z.array(z.enum(ALERT_TYPES)).max(ALERT_TYPES.length);
const name = z.string().trim().min(1).max(80);
const url = z.string().trim().min(8).max(2000);
const address = z.email().max(254);
const recipients = z.array(address).min(1).max(20);

const newChannelSchema = z.union([
  z
    .object({
      name,
      kind: z.enum(["webhook", "slack", "discord"]),
      url,
      events: types.optional(),
    })
    .strict(),
  z
    .object({
      name,
      kind: z.literal("email"),
      to: recipients,
      events: types.optional(),
    })
    .strict(),
]);

const patchChannelSchema = z
  .object({
    name: name.optional(),
    url: url.optional(),
    to: recipients.optional(),
    events: types.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const smtpSchema = z
  .object({
    host: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    security: z.enum(SMTP_SECURITY),
    username: z.string().trim().max(254).default(""),
    /** Left out keeps the saved password; empty forgets it. */
    password: z.string().max(1000).optional(),
    from: address,
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
      smtp: deps.alerts.smtp(),
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

  app.put("/alerts/smtp", async (c) => {
    const parsed = smtpSchema.safeParse(await json(c));
    if (!parsed.success) return invalid(c, parsed.error.issues);
    const hasPassword =
      parsed.data.password === undefined
        ? Boolean(deps.alerts.smtp()?.passwordSet)
        : parsed.data.password !== "";
    const problem = smtpProblem(parsed.data, hasPassword);
    if (problem) return apiError(c, 400, "invalid_smtp", problem);
    const smtp = deps.alerts.setSmtp(parsed.data);
    audit(c.get("actor"), {
      smtp: { host: smtp.host, port: smtp.port, security: smtp.security },
      action: "mail server set",
    });
    return c.json({ smtp });
  });

  app.delete("/alerts/smtp", (c) => {
    deps.alerts.removeSmtp();
    audit(c.get("actor"), { action: "mail server removed" });
    return c.json({ smtp: null });
  });

  app.post("/alerts/channels", async (c) => {
    const parsed = newChannelSchema.safeParse(await json(c));
    if (!parsed.success) return invalid(c, parsed.error.issues);
    const input = parsed.data;
    if (input.kind === "email") {
      if (!deps.alerts.smtp()) {
        return apiError(
          c,
          400,
          "no_mail_server",
          "Set up the mail server before adding an email channel.",
        );
      }
    } else {
      const problem = webhookProblem(input.url);
      if (problem) return apiError(c, 400, "invalid_url", problem);
    }
    const created = deps.alerts.addChannel({
      name: input.name,
      kind: input.kind,
      ...(input.kind === "email" ? { to: input.to } : { url: input.url }),
      events: input.events ?? [],
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
    const isEmail = deps.alerts.getChannel(id)?.kind === "email";
    if (isEmail && parsed.data.url !== undefined) {
      return apiError(
        c,
        400,
        "invalid_request",
        "An email channel has no URL.",
      );
    }
    if (!isEmail && parsed.data.to !== undefined) {
      return apiError(
        c,
        400,
        "invalid_request",
        "Only an email channel has addresses.",
      );
    }
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
