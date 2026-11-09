import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { safeEqual } from "./keys.js";
import type { Org, Person, Role } from "./org.js";
import { SESSION_COOKIE, type Sessions } from "./sessions.js";
import type { Agent } from "./types.js";

/**
 * Who is asking. The owner signed in with the admin token or the link
 * `roai serve` prints, and can do anything. A person signed in with their
 * company account and can do what their role allows.
 */
export type Viewer =
  | { kind: "owner"; via: "token" | "session" }
  | { kind: "person"; person: Person };

export function roleOf(viewer: Viewer): Role {
  return viewer.kind === "owner" ? "admin" : viewer.person.role;
}

export const isAdmin = (viewer: Viewer) => roleOf(viewer) === "admin";

/** The name written into the audit log for what this viewer does. */
export function actorOf(viewer: Viewer): string {
  if (viewer.kind === "person") return viewer.person.email;
  return viewer.via === "token" ? "admin" : "web";
}

export type AuthResult =
  | { ok: true; viewer: Viewer }
  | { ok: false; status: 401 | 403; code: string; message: string };

/**
 * Checks the admin token or the session cookie. Cookie requests that change
 * something must carry `x-purser-csrf: 1`, which a cross-site form cannot send.
 */
export function authenticate(
  c: Context,
  deps: { sessions: Sessions; org: Org },
  adminToken: string,
): AuthResult {
  const header = c.req.header("authorization");
  if (header !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match?.[1] || !safeEqual(match[1].trim(), adminToken)) {
      return {
        ok: false,
        status: 401,
        code: "unauthorized",
        message: "Admin token required.",
      };
    }
    return { ok: true, viewer: { kind: "owner", via: "token" } };
  }
  const session = deps.sessions.get(getCookie(c, SESSION_COOKIE));
  if (!session) {
    return {
      ok: false,
      status: 401,
      code: "unauthorized",
      message: "Sign in to Purser first.",
    };
  }
  if (
    c.req.method !== "GET" &&
    c.req.method !== "HEAD" &&
    c.req.header("x-purser-csrf") !== "1"
  ) {
    return {
      ok: false,
      status: 403,
      code: "csrf_required",
      message: "Send the x-purser-csrf: 1 header with every change.",
    };
  }
  if (session.personId === undefined) {
    return { ok: true, viewer: { kind: "owner", via: "session" } };
  }
  const person = deps.org.getPerson(session.personId);
  if (!person || person.status !== "active") {
    deps.sessions.endAllFor(session.personId);
    return {
      ok: false,
      status: 401,
      code: "unauthorized",
      message: "Your Purser access has been turned off. Ask an admin.",
    };
  }
  return { ok: true, viewer: { kind: "person", person } };
}

/** Departments whose agents and requests this viewer looks after. Admins: every one. */
export function managedDepartments(viewer: Viewer): string[] | "all" {
  if (isAdmin(viewer)) return "all";
  if (viewer.kind === "person" && viewer.person.role === "manager") {
    return viewer.person.manages ?? [];
  }
  return [];
}

/** True when the viewer owns the agent. */
export function owns(viewer: Viewer, agent: Agent): boolean {
  return (
    viewer.kind === "person" &&
    agent.ownerEmail !== undefined &&
    agent.ownerEmail === viewer.person.email
  );
}

/** True when the viewer manages the agent's department, or is an admin. */
export function manages(viewer: Viewer, agent: Agent): boolean {
  const depts = managedDepartments(viewer);
  if (depts === "all") return true;
  return agent.team !== undefined && depts.includes(agent.team);
}

export const canSee = (viewer: Viewer, agent: Agent) =>
  owns(viewer, agent) || manages(viewer, agent);
