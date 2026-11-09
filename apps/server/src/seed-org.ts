import type { Department, OrgSettings, Person, Request } from "./org.js";
import { DEFAULT_POLICY } from "./org.js";
import type { Agent, AuditEvent, UsageRecord } from "./types.js";

export interface SeedOrg {
  people: Person[];
  departments: Department[];
  requests: Request[];
  settings: OrgSettings;
  audit: AuditEvent[];
}

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** "Avery Ortiz" becomes "avery.ortiz@example.com". example.com is reserved for examples. */
export const emailFor = (name: string) =>
  `${name
    .toLowerCase()
    .replace(/[^a-z]+/g, ".")
    .replace(/^\.|\.$/g, "")}@example.com`;

const ASKS = [
  {
    name: "board-pack-drafter",
    purpose: "Drafts the monthly board pack from finance notes",
    dailyUsd: 12,
  },
  {
    name: "churn-analyst",
    purpose: "Explains why customers left last quarter",
    dailyUsd: 8,
  },
  {
    name: "rfp-responder",
    purpose: "Answers security questionnaires from past answers",
    dailyUsd: 15,
  },
  {
    name: "meeting-summariser",
    purpose: "Summarises recorded team meetings",
    dailyUsd: 4,
  },
  {
    name: "release-notes-writer",
    purpose: "Writes release notes from merged pull requests",
    dailyUsd: 3,
  },
  {
    name: "contract-search",
    purpose: "Finds clauses across signed contracts",
    dailyUsd: 6,
  },
];

/**
 * People, departments and requests for a demo fleet. Every agent owner
 * becomes a person in the department most of their agents are in; each
 * department gets a manager; two people are admins; and there are requests
 * waiting, so every role has something to do in the demo.
 */
export function generateOrg(
  agents: Agent[],
  usage: UsageRecord[],
  now: Date,
  r: () => number,
): SeedOrg {
  const t = now.getTime();
  const created = iso(t - 120 * DAY);
  const byOwner = new Map<string, Agent[]>();
  for (const a of agents) {
    a.ownerEmail = emailFor(a.owner);
    byOwner.set(a.owner, [...(byOwner.get(a.owner) ?? []), a]);
  }

  const people: Person[] = [];
  let n = 0;
  const person = (name: string, extra: Partial<Person>): Person => {
    const p: Person = {
      id: `usr_demo${(n++).toString().padStart(4, "0")}`,
      email: emailFor(name),
      name,
      role: "member",
      status: "active",
      source: "demo",
      createdAt: created,
      lastSignInAt: iso(t - Math.floor(r() * 10 * DAY)),
      ...extra,
    };
    people.push(p);
    return p;
  };

  // Each owner works in the department most of their agents belong to.
  for (const [owner, theirs] of [...byOwner].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const counts = new Map<string, number>();
    for (const a of theirs) {
      if (a.team) counts.set(a.team, (counts.get(a.team) ?? 0) + 1);
    }
    const department = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    person(owner, { department });
  }

  // One manager per department: its member with the most agents there.
  const teams = [
    ...new Set(agents.map((a) => a.team).filter(Boolean)),
  ] as string[];
  teams.sort();
  for (const team of teams) {
    const inTeam = people.filter(
      (p) => p.department === team && p.role === "member",
    );
    const best = inTeam.sort(
      (a, b) =>
        (byOwner.get(b.name)?.filter((x) => x.team === team).length ?? 0) -
        (byOwner.get(a.name)?.filter((x) => x.team === team).length ?? 0),
    )[0];
    if (best) {
      best.role = "manager";
      best.manages = [team];
    } else {
      person(`${team} Lead`, {
        role: "manager",
        department: team,
        manages: [team],
      });
    }
  }
  person("Morgan Admin", { role: "admin", department: "IT Platform" });
  person("Riley Admin", { role: "admin", department: "IT Platform" });
  const leaver = people.find((p) => p.role === "member" && byOwner.has(p.name));
  if (leaver) {
    leaver.status = "disabled";
    leaver.disabledAt = iso(t - 3 * DAY);
    leaver.disabledBy = "morgan.admin@example.com";
    // Leaving stopped their agents.
    for (const a of byOwner.get(leaver.name) ?? []) {
      if (a.status === "paused") continue;
      a.status = "paused";
      a.pausedAt = leaver.disabledAt;
      a.pausedBy = `morgan.admin@example.com (${leaver.email} left)`;
    }
  }

  // Monthly budgets about a fifth above what each department spends.
  const monthStart = now.toISOString().slice(0, 7);
  const spend = new Map<string, number>();
  const teamOf = new Map(agents.map((a) => [a.id, a.team]));
  for (const u of usage) {
    if (!u.at.startsWith(monthStart)) continue;
    const team = teamOf.get(u.agentId);
    if (team) spend.set(team, (spend.get(team) ?? 0) + u.costUsd);
  }
  const dayOfMonth = now.getUTCDate();
  const departments: Department[] = teams.map((name) => ({
    name,
    budgetMonthlyUsd:
      Math.ceil(
        (((spend.get(name) ?? 0) / Math.max(1, dayOfMonth)) * 30 * 1.2) / 50,
      ) * 50,
    ...(name.startsWith("Finance")
      ? {
          selfService: {
            autoApproveDailyUsd: 0,
            maxDailyUsd: 20,
            allowedProviders: ["openai", "anthropic"],
          },
        }
      : {}),
  }));

  // Requests: some waiting in most departments, and some already decided.
  const requests: Request[] = [];
  const audit: AuditEvent[] = [];
  const members = people.filter(
    (p) => p.role === "member" && p.status === "active" && p.department,
  );
  let q = 0;
  const used = new Set(agents.map((a) => a.name));
  for (let i = 0; i < 24 && members.length > 0; i++) {
    const asker = members[Math.floor(r() * members.length)];
    if (!asker) continue;
    const ask = ASKS[i % ASKS.length];
    if (!ask) continue;
    let name = `${ask.name}-${String(i + 1).padStart(2, "0")}`;
    while (used.has(name)) name += "x";
    used.add(name);
    const at = t - Math.floor(r() * 4 * DAY);
    const decided = i % 3 === 2;
    const managers = people.filter((p) =>
      p.manages?.includes(asker.department ?? ""),
    );
    const request: Request = {
      id: `req_demo${(q++).toString().padStart(3, "0")}`,
      kind: "agent",
      status: decided ? (i % 2 === 0 ? "approved" : "denied") : "pending",
      by: asker.email,
      byName: asker.name,
      department: asker.department,
      reason: "Needed for the quarter-end push.",
      createdAt: iso(at),
      agent: {
        name,
        purpose: ask.purpose,
        dailyUsd: ask.dailyUsd,
        monthlyUsd: ask.dailyUsd * 25,
      },
      ...(decided
        ? {
            decidedAt: iso(at + 3_600_000),
            decidedBy: managers[0]?.email ?? "morgan.admin@example.com",
            note:
              i % 2 === 0
                ? "Approved for this quarter."
                : "Please use the shared one in your team.",
          }
        : {}),
    };
    requests.push(request);
    audit.push({
      at: request.createdAt,
      type: "request.created",
      detail: { by: asker.email, request: request.id, kind: "agent", name },
    });
  }
  // Raises asked for agents that hit their limit.
  for (const agent of agents) {
    if (requests.filter((x) => x.kind === "raise").length >= 6) break;
    const spent = usage.length > 0 ? 1 : 0;
    if (!spent || agent.status !== "active" || !agent.limits.dailyUsd) continue;
    if (r() > 0.02) continue;
    const owner = people.find((p) => p.email === agent.ownerEmail);
    if (!owner || owner.status !== "active" || owner.role !== "member")
      continue;
    requests.push({
      id: `req_demo${(q++).toString().padStart(3, "0")}`,
      kind: "raise",
      status: "pending",
      by: owner.email,
      byName: owner.name,
      department: agent.team,
      reason: "Running behind on a deadline today.",
      createdAt: iso(t - Math.floor(r() * 6) * 3_600_000),
      raise: {
        agentId: agent.id,
        agentName: agent.name,
        window: "day",
        amountUsd: Math.max(1, Math.round(agent.limits.dailyUsd)),
      },
    });
  }

  // A coding agent with a second service to check its work, and agents that
  // have asked for one themselves.
  // In the sign-in page's order, so the people offered there have something to see.
  const employees = people.filter(
    (p) => p.role === "member" && p.status === "active" && p.department,
  );
  const ownedBy = (p: Person) =>
    agents.find(
      (a) =>
        a.ownerEmail === p.email &&
        a.status === "active" &&
        a.team === p.department &&
        !a.serviceLimits,
    );
  const first = employees[0];
  const partner = first && ownedBy(first);
  if (partner) {
    partner.name = "code-review-partner";
    partner.purpose =
      "Writes code changes, and asks a second model to find what is wrong with them";
    partner.providers = ["anthropic", "openai"];
    partner.serviceLimits = {
      openai: { dailyUsd: 2, monthlyUsd: 20, models: ["gpt-4o"] },
    };
  }
  const askService = (
    agent: Agent,
    owner: Person,
    provider: { id: string; name: string },
    dailyUsd: number,
    ownerMayDecide: boolean,
  ) => {
    requests.push({
      id: `req_demo${(q++).toString().padStart(3, "0")}`,
      kind: "service",
      status: "pending",
      by: owner.email,
      byName: owner.name,
      department: agent.team,
      reason:
        "I want a second opinion on risky changes before they go out for review.",
      createdAt: iso(t - Math.floor(r() * 6) * 3_600_000),
      askedByAgent: { id: agent.id, name: agent.name },
      ...(ownerMayDecide ? { ownerMayDecide } : {}),
      service: {
        agentId: agent.id,
        agentName: agent.name,
        provider: provider.id,
        providerName: provider.name,
        dailyUsd,
      },
    });
  };
  // One for an employee to decide on, within what they could give it themselves.
  const second =
    first &&
    agents.find(
      (a) =>
        a.ownerEmail === first.email &&
        a.status === "active" &&
        a !== partner &&
        !a.serviceLimits,
    );
  if (first && second) {
    askService(second, first, { id: "openai", name: "OpenAI" }, 2, true);
  }
  // And for managers, above that.
  for (const manager of people
    .filter((p) => p.role === "manager")
    .slice(0, 4)) {
    const owner = employees.find((m) =>
      manager.manages?.includes(m.department ?? ""),
    );
    const agent = owner && ownedBy(owner);
    if (owner && agent) {
      askService(agent, owner, { id: "openai", name: "OpenAI" }, 10, false);
    }
  }

  return {
    people,
    departments,
    requests,
    settings: {
      selfService: true,
      defaults: { ...DEFAULT_POLICY, autoApproveDailyUsd: 2 },
    },
    audit,
  };
}
