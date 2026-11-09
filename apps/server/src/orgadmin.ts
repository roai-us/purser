import type { Context, Hono } from "hono";
import { z } from "zod";
import { apiError } from "./admin.js";
import type { ControlDeps } from "./control.js";
import type { Org, Person } from "./org.js";
import { lightOf } from "./queries.js";
import { agentState } from "./control.js";
import type { Registry } from "./registry.js";
import { offboard } from "./selfservice.js";
import type { Sessions } from "./sessions.js";
import type { Vault } from "./vault.js";

export interface OrgAdminDeps extends ControlDeps {
  org: Org;
  registry: Registry;
  sessions: Sessions;
  vault: Vault;
}

/** The vault entry that holds the company sign-in's client secret. */
export const SIGN_IN_SECRET = "__sign_in";

const role = z.enum(["admin", "manager", "member"]);
const dept = z.string().trim().min(1).max(100);
const policySchema = z
  .object({
    autoApproveDailyUsd: z.number().min(0).max(100_000),
    maxDailyUsd: z.number().min(0.01).max(100_000),
    allowedProviders: z.array(z.string().min(1).max(40)).max(50).optional(),
  })
  .strict()
  .refine((p) => p.autoApproveDailyUsd <= p.maxDailyUsd, {
    message: "The auto-approve limit can't be above the maximum.",
  });

const newPersonSchema = z
  .object({
    email: z.email().max(200),
    name: z.string().trim().min(1).max(200),
    role: role.optional(),
    department: dept.optional(),
    manages: z.array(dept).max(200).optional(),
  })
  .strict();

const patchPersonSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    role: role.optional(),
    department: dept.nullable().optional(),
    manages: z.array(dept).max(200).optional(),
  })
  .strict();

const disableSchema = z
  .object({ reassignTo: z.string().min(1).max(200).optional() })
  .strict();

const departmentSchema = z
  .object({
    budgetMonthlyUsd: z.number().min(0).max(100_000_000).nullable().optional(),
    selfService: policySchema.nullable().optional(),
  })
  .strict();

const selfServiceSchema = z
  .object({
    selfService: z.boolean().optional(),
    defaults: policySchema.optional(),
  })
  .strict();

const signInSchema = z
  .object({
    issuer: z.url().max(500),
    clientId: z.string().trim().min(1).max(500),
    /** Absent: keep the stored secret. Empty string: remove it. */
    clientSecret: z.string().max(2000).optional(),
    allowedDomains: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Use a domain like example.com."),
      )
      .min(1)
      .max(50),
    adminEmails: z.array(z.email().max(200)).max(50).optional(),
    label: z.string().trim().max(60).optional(),
  })
  .strict();

/**
 * Admin routes for people, departments and the organisation's sign-in and
 * self-service rules. Added to the admin app, behind its admin check.
 */
export function orgAdminRoutes(
  app: Hono<{
    Variables: { actor: string; viewer: import("./viewer.js").Viewer };
  }>,
  deps: OrgAdminDeps,
): void {
  const now = () => deps.now();
  const json = async (c: Context) => {
    const text = await c.req.text();
    return text.trim() === "" ? {} : (JSON.parse(text) as unknown);
  };
  const audit = (
    type:
      | "person.added"
      | "person.updated"
      | "person.enabled"
      | "department.changed"
      | "settings.changed",
    detail: Record<string, unknown>,
  ) => deps.store.audit({ at: now().toISOString(), type, detail });

  /** Each person with how many agents they own and what those spent this month. */
  const withAgents = (people: Person[]) => {
    const stats = new Map<
      string,
      { agents: number; running: number; spendMonth: number }
    >();
    const at = now();
    for (const agent of deps.store.listAgents()) {
      if (!agent.ownerEmail) continue;
      const s = stats.get(agent.ownerEmail) ?? {
        agents: 0,
        running: 0,
        spendMonth: 0,
      };
      s.agents++;
      if (agentState(agent, deps.store, at) === "running") s.running++;
      s.spendMonth += deps.store.spend(agent.id, "month", at);
      stats.set(agent.ownerEmail, s);
    }
    return people.map((p) => ({
      ...p,
      ...(stats.get(p.email) ?? { agents: 0, running: 0, spendMonth: 0 }),
    }));
  };

  // People

  app.get("/people", (c) => {
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    const roleFilter = c.req.query("role");
    const department = c.req.query("department");
    const status = c.req.query("status");
    const people = deps.org
      .listPeople()
      .filter(
        (p) =>
          (!q ||
            `${p.name}\n${p.email}\n${p.department ?? ""}`
              .toLowerCase()
              .includes(q)) &&
          (!roleFilter || p.role === roleFilter) &&
          (!department || p.department === department) &&
          (!status || p.status === status),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
    const pageSize = Math.min(
      200,
      Math.max(1, Number(c.req.query("pageSize") ?? 50) || 50),
    );
    return c.json({
      items: withAgents(people.slice((page - 1) * pageSize, page * pageSize)),
      total: people.length,
      page,
      pageSize,
    });
  });

  app.post("/people", async (c) => {
    const parsed = newPersonSchema.safeParse(await json(c));
    if (!parsed.success) {
      return apiError(
        c,
        400,
        "invalid_request",
        "Check the person's details.",
        parsed.error.issues,
      );
    }
    if (deps.org.findByEmail(parsed.data.email)) {
      return apiError(
        c,
        409,
        "email_taken",
        `${parsed.data.email} is already in Purser.`,
      );
    }
    const person = deps.org.addPerson({ ...parsed.data, source: "admin" });
    audit("person.added", {
      by: c.get("actor"),
      person: person.email,
      role: person.role,
    });
    return c.json(person, 201);
  });

  const findPerson = (c: Context) =>
    deps.org.resolvePerson(decodeURIComponent(c.req.param("ref") ?? ""));

  app.patch("/people/:ref", async (c) => {
    const person = findPerson(c);
    if (!person) return apiError(c, 404, "not_found", "No such person.");
    const parsed = patchPersonSchema.safeParse(await json(c));
    if (!parsed.success) {
      return apiError(
        c,
        400,
        "invalid_request",
        "Check the person's details.",
        parsed.error.issues,
      );
    }
    const { department, name, role: newRole, manages } = parsed.data;
    const patch: Partial<Omit<Person, "id" | "email">> = {};
    if (name !== undefined) patch.name = name;
    if (newRole !== undefined) patch.role = newRole;
    if (manages !== undefined) patch.manages = manages;
    if (department !== undefined) patch.department = department ?? undefined;
    const updated = deps.org.updatePerson(person.id, patch);
    audit("person.updated", {
      by: c.get("actor"),
      person: person.email,
      changed: Object.keys(parsed.data),
    });
    return c.json(updated);
  });

  app.post("/people/:ref/disable", async (c) => {
    const person = findPerson(c);
    if (!person) return apiError(c, 404, "not_found", "No such person.");
    const parsed = disableSchema.safeParse(await json(c));
    if (!parsed.success)
      return apiError(c, 400, "invalid_request", "Invalid request.");
    let reassignTo: Person | undefined;
    if (parsed.data.reassignTo) {
      reassignTo = deps.org.resolvePerson(parsed.data.reassignTo);
      if (
        !reassignTo ||
        reassignTo.status !== "active" ||
        reassignTo.id === person.id
      ) {
        return apiError(
          c,
          400,
          "invalid_reassign",
          "Pick someone else who is still active.",
        );
      }
    }
    return c.json(
      offboard(
        { ...deps, endSessions: (id) => deps.sessions.endAllFor(id) },
        c.get("viewer"),
        person,
        reassignTo,
      ),
    );
  });

  app.post("/people/:ref/enable", (c) => {
    const person = findPerson(c);
    if (!person) return apiError(c, 404, "not_found", "No such person.");
    const updated = deps.org.updatePerson(person.id, {
      status: "active",
      disabledAt: undefined,
      disabledBy: undefined,
    });
    audit("person.enabled", { by: c.get("actor"), person: person.email });
    return c.json(updated);
  });

  // Departments

  app.get("/departments", (c) => {
    const at = now();
    const rows = new Map<
      string,
      {
        agents: number;
        green: number;
        yellow: number;
        red: number;
        spendMonth: number;
        spendToday: number;
      }
    >();
    for (const agent of deps.store.listAgents()) {
      if (!agent.team) continue;
      const row = rows.get(agent.team) ?? {
        agents: 0,
        green: 0,
        yellow: 0,
        red: 0,
        spendMonth: 0,
        spendToday: 0,
      };
      row.agents++;
      row[lightOf(agentState(agent, deps.store, at))]++;
      row.spendMonth += deps.store.spend(agent.id, "month", at);
      row.spendToday += deps.store.spend(agent.id, "day", at);
      rows.set(agent.team, row);
    }
    const people = deps.org.listPeople();
    const pending = deps.org
      .listRequests()
      .filter((r) => r.status === "pending");
    const settings = deps.org.settings();
    return c.json({
      defaults: settings.defaults,
      selfService: settings.selfService,
      items: deps.org.departmentNames(rows.keys()).map((name) => {
        const dept = deps.org.getDepartment(name);
        return {
          name,
          budgetMonthlyUsd: dept.budgetMonthlyUsd,
          selfService: dept.selfService,
          policy: deps.org.policyFor(name),
          people: people.filter(
            (p) => p.department === name && p.status === "active",
          ).length,
          managers: deps.org
            .managersOf(name)
            .map((p) => ({ name: p.name, email: p.email })),
          pending: pending.filter((r) => r.department === name).length,
          ...(rows.get(name) ?? {
            agents: 0,
            green: 0,
            yellow: 0,
            red: 0,
            spendMonth: 0,
            spendToday: 0,
          }),
        };
      }),
    });
  });

  app.put("/departments/:name", async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const parsed = departmentSchema.safeParse(await json(c));
    if (!parsed.success) {
      return apiError(
        c,
        400,
        "invalid_request",
        "Check the department's rules.",
        parsed.error.issues,
      );
    }
    const current = deps.org.getDepartment(name);
    const next = {
      ...current,
      ...(parsed.data.budgetMonthlyUsd !== undefined
        ? { budgetMonthlyUsd: parsed.data.budgetMonthlyUsd ?? undefined }
        : {}),
      ...(parsed.data.selfService !== undefined
        ? { selfService: parsed.data.selfService ?? undefined }
        : {}),
    };
    deps.org.setDepartment(next);
    audit("department.changed", {
      by: c.get("actor"),
      department: name,
      to: next,
    });
    return c.json(next);
  });

  // Organisation settings

  const signInView = () => {
    const s = deps.org.settings();
    return {
      selfService: s.selfService,
      defaults: s.defaults,
      mcp: { enabled: s.mcp !== false, url: `${deps.registry.baseUrl}/mcp` },
      signIn: s.signIn
        ? {
            ...s.signIn,
            hasSecret: Boolean(deps.vault.get(SIGN_IN_SECRET)?.apiKey),
            redirectUri: `${deps.registry.baseUrl}/auth/sso/callback`,
          }
        : null,
      redirectUri: `${deps.registry.baseUrl}/auth/sso/callback`,
    };
  };

  app.get("/settings/org", (c) => c.json(signInView()));

  app.put("/settings/self-service", async (c) => {
    const parsed = selfServiceSchema.safeParse(await json(c));
    if (!parsed.success) {
      return apiError(
        c,
        400,
        "invalid_request",
        "Check the rules.",
        parsed.error.issues,
      );
    }
    const patch: {
      selfService?: boolean;
      defaults?: import("./org.js").SelfServicePolicy;
    } = {};
    if (parsed.data.selfService !== undefined)
      patch.selfService = parsed.data.selfService;
    if (parsed.data.defaults) {
      const { allowedProviders, ...rest } = parsed.data.defaults;
      patch.defaults = allowedProviders ? { ...rest, allowedProviders } : rest;
    }
    deps.org.updateSettings(patch);
    audit("settings.changed", {
      by: c.get("actor"),
      setting: "self-service",
      to: patch,
    });
    return c.json(signInView());
  });

  app.put("/settings/mcp", async (c) => {
    const parsed = z
      .object({ enabled: z.boolean() })
      .strict()
      .safeParse(await json(c));
    if (!parsed.success) {
      return apiError(c, 400, "invalid_request", 'Send { "enabled": true }.');
    }
    deps.org.updateSettings({ mcp: parsed.data.enabled });
    audit("settings.changed", {
      by: c.get("actor"),
      setting: "mcp",
      to: parsed.data.enabled,
    });
    return c.json(signInView());
  });

  app.put("/settings/sign-in", async (c) => {
    const parsed = signInSchema.safeParse(await json(c));
    if (!parsed.success) {
      return apiError(
        c,
        400,
        "invalid_request",
        "Check the sign-in details.",
        parsed.error.issues,
      );
    }
    const { clientSecret, ...rest } = parsed.data;
    const issuer = rest.issuer.replace(/\/+$/, "");
    const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(
      issuer,
    );
    if (!issuer.startsWith("https://") && !local) {
      return apiError(
        c,
        400,
        "invalid_issuer",
        "The issuer must start with https://.",
      );
    }
    // A shared Microsoft issuer accepts any tenant, and Entra email claims can
    // be set by any tenant's admins, so only the company's own tenant is safe.
    if (/\/(common|organizations|consumers)(\/|$)/i.test(issuer)) {
      return apiError(
        c,
        400,
        "shared_issuer",
        "Use your own tenant's issuer, like https://login.microsoftonline.com/<tenant id>/v2.0, not common or organizations.",
      );
    }
    if (clientSecret !== undefined) {
      if (clientSecret === "") deps.vault.removeKey(SIGN_IN_SECRET);
      else
        deps.vault.set(SIGN_IN_SECRET, {
          apiKey: clientSecret,
          updatedAt: now().toISOString(),
        });
    }
    deps.org.updateSettings({
      signIn: {
        issuer,
        clientId: rest.clientId,
        allowedDomains: rest.allowedDomains,
        adminEmails: (rest.adminEmails ?? []).map((e) => e.toLowerCase()),
        ...(rest.label ? { label: rest.label } : {}),
      },
    });
    audit("settings.changed", {
      by: c.get("actor"),
      setting: "sign-in",
      issuer,
    });
    return c.json(signInView());
  });

  app.delete("/settings/sign-in", (c) => {
    deps.org.updateSettings({ signIn: undefined });
    deps.vault.removeKey(SIGN_IN_SECRET);
    audit("settings.changed", {
      by: c.get("actor"),
      setting: "sign-in",
      to: null,
    });
    return c.json(signInView());
  });
}
