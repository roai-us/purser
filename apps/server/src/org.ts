import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { newId } from "./keys.js";
import { writeAtomic } from "./store.js";

/**
 * What a person may do. Admins run Purser. Managers approve requests and
 * look after the agents of the departments they manage. Members look after
 * their own agents and ask for new ones.
 */
export type Role = "admin" | "manager" | "member";

export interface Person {
  id: string;
  /** Lower case. How sign-in finds the person, and how agents name their owner. */
  email: string;
  name: string;
  role: Role;
  department?: string | undefined;
  /** Departments this person approves requests for. Managers only. */
  manages?: string[] | undefined;
  status: "active" | "disabled";
  /** How the person was added: by company sign-in, by an admin, or by the demo. */
  source: "sso" | "admin" | "demo";
  createdAt: string;
  lastSignInAt?: string | undefined;
  disabledAt?: string | undefined;
  disabledBy?: string | undefined;
}

/** What people in a department may set up for themselves, and when a manager must say yes. */
export interface SelfServicePolicy {
  /** A new agent with a daily limit up to this is ready at once. Above it needs approval. 0: always ask. */
  autoApproveDailyUsd: number;
  /** No one may ask for more than this per day per agent. */
  maxDailyUsd: number;
  /** Connector ids people may pick. Absent: any configured connector. */
  allowedProviders?: string[] | undefined;
}

export interface Department {
  name: string;
  /** What the department's agents together may spend per month. Shown against spend; not enforced yet. */
  budgetMonthlyUsd?: number | undefined;
  /** This department's rules. Absent: the organisation's defaults. */
  selfService?: SelfServicePolicy | undefined;
}

export type RequestStatus = "pending" | "approved" | "denied" | "cancelled";

export interface NewAgentAsk {
  name: string;
  purpose: string;
  providers?: string[] | undefined;
  dailyUsd: number;
  monthlyUsd?: number | undefined;
}

export interface RaiseAsk {
  agentId: string;
  agentName: string;
  window: "day" | "month";
  amountUsd: number;
}

/** A service asked for on an existing agent. */
export interface ServiceAsk {
  agentId: string;
  agentName: string;
  provider: string;
  providerName: string;
  dailyUsd: number;
  monthlyUsd?: number | undefined;
  models?: string[] | undefined;
}

/** Something a person asked for that a manager or admin decides. */
export interface Request {
  id: string;
  kind: "agent" | "raise" | "service";
  status: RequestStatus;
  /** The person who asked, by email. For an agent's own request: its owner. */
  by: string;
  byName: string;
  /** The department whose managers decide. */
  department?: string | undefined;
  reason?: string | undefined;
  createdAt: string;
  agent?: NewAgentAsk | undefined;
  raise?: RaiseAsk | undefined;
  service?: ServiceAsk | undefined;
  /** The agent asked for this itself, over MCP. A person always decides those. */
  askedByAgent?: { id: string; name: string } | undefined;
  /** The owner may decide their own agent's request: it is within what they could give it themselves. */
  ownerMayDecide?: boolean | undefined;
  decidedAt?: string | undefined;
  decidedBy?: string | undefined;
  /** The decider's name, to show the person who asked. */
  decidedByName?: string | undefined;
  /** What the decider said, shown to the person who asked. */
  note?: string | undefined;
  /** The agent this request made, once approved. */
  agentId?: string | undefined;
}

/** How the company sign-in is set up. The client secret is kept in the vault, not here. */
export interface SignInSettings {
  issuer: string;
  clientId: string;
  allowedDomains: string[];
  /** These people are made admins when they first sign in. */
  adminEmails: string[];
  /** The label on the sign-in button: "Sign in with Contoso". */
  label?: string | undefined;
}

export interface OrgSettings {
  /** Can people sign in and ask for agents themselves? */
  selfService: boolean;
  defaults: SelfServicePolicy;
  signIn?: SignInSettings | undefined;
  /** Can agents connect to Purser's MCP server with their keys? Absent means yes. */
  mcp?: boolean | undefined;
}

export const DEFAULT_POLICY: SelfServicePolicy = {
  autoApproveDailyUsd: 1,
  maxDailyUsd: 25,
};

interface OrgFile {
  people: Person[];
  departments: Department[];
  requests: Request[];
  settings: OrgSettings;
}

/**
 * The people who use Purser, their departments, the requests they make and
 * the organisation's rules. Kept in `<dataDir>/org.json`, readable only by
 * Purser's own user; in memory without a data directory.
 */
export class Org {
  private people = new Map<string, Person>();
  private byEmail = new Map<string, string>();
  private departments = new Map<string, Department>();
  private requests: Request[] = [];
  private current: OrgSettings = {
    selfService: true,
    defaults: { ...DEFAULT_POLICY },
  };

  constructor(
    private readonly dataDir: string | null,
    private readonly now: () => Date,
  ) {
    if (dataDir) this.load(dataDir);
  }

  // People

  listPeople(): Person[] {
    return [...this.people.values()];
  }

  getPerson(id: string): Person | undefined {
    return this.people.get(id);
  }

  findByEmail(email: string): Person | undefined {
    const id = this.byEmail.get(email.trim().toLowerCase());
    return id ? this.people.get(id) : undefined;
  }

  /** A person by id or email. */
  resolvePerson(ref: string): Person | undefined {
    return this.getPerson(ref) ?? this.findByEmail(ref);
  }

  addPerson(input: {
    email: string;
    name: string;
    role?: Role | undefined;
    department?: string | undefined;
    manages?: string[] | undefined;
    source: Person["source"];
  }): Person {
    const email = input.email.trim().toLowerCase();
    if (this.byEmail.has(email)) {
      throw new Error(`${email} is already in Purser.`);
    }
    const person: Person = {
      id: newId("usr"),
      email,
      name: input.name.trim() || email,
      role: input.role ?? "member",
      department: input.department,
      manages: input.manages?.length ? input.manages : undefined,
      status: "active",
      source: input.source,
      createdAt: this.now().toISOString(),
    };
    this.people.set(person.id, person);
    this.byEmail.set(email, person.id);
    this.save();
    return person;
  }

  updatePerson(
    id: string,
    patch: Partial<Omit<Person, "id" | "email">>,
  ): Person {
    const person = this.people.get(id);
    if (!person) throw new Error("No such person.");
    const next: Person = { ...person, ...patch };
    if (next.role !== "manager" && next.role !== "admin")
      next.manages = undefined;
    if (next.manages?.length === 0) next.manages = undefined;
    this.people.set(id, next);
    this.save();
    return next;
  }

  // Departments

  /** Every department named anywhere: on record, on a person, or passed in from agents. */
  departmentNames(extra: Iterable<string> = []): string[] {
    const names = new Set<string>(this.departments.keys());
    for (const p of this.people.values()) {
      if (p.department) names.add(p.department);
      for (const d of p.manages ?? []) names.add(d);
    }
    for (const d of extra) names.add(d);
    return [...names].sort();
  }

  getDepartment(name: string): Department {
    return this.departments.get(name) ?? { name };
  }

  setDepartment(dept: Department): Department {
    this.departments.set(dept.name, dept);
    this.save();
    return dept;
  }

  /** The rules for a department: its own, or the organisation's. */
  policyFor(department: string | undefined): SelfServicePolicy {
    const own = department
      ? this.departments.get(department)?.selfService
      : undefined;
    return own ?? this.current.defaults;
  }

  /** Managers who decide for a department. */
  managersOf(department: string | undefined): Person[] {
    if (!department) return [];
    return this.listPeople().filter(
      (p) => p.status === "active" && p.manages?.includes(department),
    );
  }

  // Requests

  listRequests(): Request[] {
    return [...this.requests];
  }

  getRequest(id: string): Request | undefined {
    return this.requests.find((r) => r.id === id);
  }

  addRequest(input: Omit<Request, "id" | "status" | "createdAt">): Request {
    const request: Request = {
      ...input,
      id: newId("req"),
      status: "pending",
      createdAt: this.now().toISOString(),
    };
    this.requests.push(request);
    this.save();
    return request;
  }

  updateRequest(id: string, patch: Partial<Request>): Request {
    const index = this.requests.findIndex((r) => r.id === id);
    const found = this.requests[index];
    if (!found) throw new Error("No such request.");
    const next = { ...found, ...patch };
    this.requests[index] = next;
    this.save();
    return next;
  }

  // Settings

  settings(): OrgSettings {
    return structuredClone(this.current);
  }

  updateSettings(patch: Partial<OrgSettings>): OrgSettings {
    this.current = { ...this.current, ...patch };
    this.save();
    return this.settings();
  }

  /** Replaces everything at once, for the demo seed. */
  replaceAll(data: Partial<OrgFile>): void {
    this.people.clear();
    this.byEmail.clear();
    for (const p of data.people ?? []) {
      this.people.set(p.id, p);
      this.byEmail.set(p.email, p.id);
    }
    this.departments.clear();
    for (const d of data.departments ?? []) this.departments.set(d.name, d);
    this.requests = [...(data.requests ?? [])];
    if (data.settings) this.current = data.settings;
    this.save();
  }

  private load(dir: string): void {
    const file = join(dir, "org.json");
    if (!existsSync(file)) return;
    const data = JSON.parse(readFileSync(file, "utf8")) as Partial<OrgFile>;
    for (const p of data.people ?? []) {
      this.people.set(p.id, p);
      this.byEmail.set(p.email, p.id);
    }
    for (const d of data.departments ?? []) this.departments.set(d.name, d);
    this.requests = data.requests ?? [];
    if (data.settings) {
      this.current = {
        ...this.current,
        ...data.settings,
        defaults: { ...DEFAULT_POLICY, ...data.settings.defaults },
      };
    }
  }

  private save(): void {
    if (!this.dataDir) return;
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const data: OrgFile = {
      people: this.listPeople(),
      departments: [...this.departments.values()],
      requests: this.requests,
      settings: this.current,
    };
    writeAtomic(join(this.dataDir, "org.json"), JSON.stringify(data, null, 2));
  }
}
