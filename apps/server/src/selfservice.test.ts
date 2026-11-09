import { describe, expect, it } from "vitest";
import type { Person, Request } from "./org.js";
import { chatBody, harness, type Harness } from "./test/helpers.js";
import type { PublicAgent } from "./types.js";

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

/** A small company: an admin, two managers and three members in two departments. */
function company() {
  const h = harness();
  const add = (
    email: string,
    role: Person["role"],
    department: string,
    manages?: string[],
  ) =>
    h.org.addPerson({
      email,
      name: email.split("@")[0] ?? email,
      role,
      department,
      manages,
      source: "admin",
    });
  const people = {
    admin: add("ada@example.com", "admin", "IT"),
    finMgr: add("fay@example.com", "manager", "Finance", ["Finance"]),
    salesMgr: add("sol@example.com", "manager", "Sales", ["Sales"]),
    finA: add("finn@example.com", "member", "Finance"),
    finB: add("fern@example.com", "member", "Finance"),
    sales: add("sam@example.com", "member", "Sales"),
  };
  h.addAgent(
    "fin-a-bot",
    { dailyUsd: 1 },
    {
      team: "Finance",
      ownerEmail: "finn@example.com",
    },
  );
  h.addAgent(
    "fin-b-bot",
    { dailyUsd: 1 },
    {
      team: "Finance",
      ownerEmail: "fern@example.com",
    },
  );
  h.addAgent(
    "sales-bot",
    { dailyUsd: 1 },
    {
      team: "Sales",
      ownerEmail: "sam@example.com",
    },
  );
  return { h, ...people };
}

const names = async (res: Promise<Response>) =>
  (await json<{ items: PublicAgent[] }>(res)).items.map((a) => a.name);

describe("who sees what", () => {
  it("shows members their own agents, managers their departments, admins everything", async () => {
    const { h, finA, finMgr, admin } = company();
    expect(await names(h.as(finA, "GET", "/me/agents"))).toEqual(["fin-a-bot"]);
    expect(await names(h.as(finA, "GET", "/me/agents?scope=team"))).toEqual([
      "fin-a-bot",
    ]);
    expect(await names(h.as(finMgr, "GET", "/me/agents?scope=team"))).toEqual([
      "fin-a-bot",
      "fin-b-bot",
    ]);
    expect(
      await names(h.as(admin, "GET", "/me/agents?scope=team")),
    ).toHaveLength(3);
    // Another member's agent is invisible, not forbidden.
    expect((await h.as(finA, "GET", "/me/agents/fin-b-bot")).status).toBe(404);
    expect((await h.as(finMgr, "GET", "/me/agents/sales-bot")).status).toBe(
      404,
    );
    expect((await h.as(finMgr, "GET", "/me/agents/fin-b-bot")).status).toBe(
      200,
    );
    // Facets only name what the person can see.
    const page = await json<{ facets: { owners: string[] } }>(
      h.as(finA, "GET", "/me/agents"),
    );
    expect(page.facets.owners).toEqual(["Dana Ortiz"]);
    const status = await json<{ total: number }>(
      h.as(finMgr, "GET", "/me/status?scope=team"),
    );
    expect(status.total).toBe(2);
  });

  it("keeps the admin API for admins", async () => {
    const { h, finA, finMgr, admin } = company();
    expect((await h.as(finA, "GET", "/admin/agents")).status).toBe(403);
    expect((await h.as(finMgr, "GET", "/admin/agents")).status).toBe(403);
    expect((await h.as(admin, "GET", "/admin/agents")).status).toBe(200);
    // Changes need the CSRF header, as before.
    const id = h.sessions.signIn(admin.id);
    const res = await h.app.request("/admin/kill-all", {
      method: "POST",
      headers: { cookie: `purser_session=${id}` },
    });
    expect(res.status).toBe(403);
  });

  it("tells the web UI who is signed in", async () => {
    const { h, finMgr } = company();
    const me = await json<{ viewer: { role: string; manages: string[] } }>(
      h.as(finMgr, "GET", "/me"),
    );
    expect(me.viewer).toMatchObject({ role: "manager", manages: ["Finance"] });
    const id = h.sessions.signIn(finMgr.id);
    const session = await json<{ viewer: { email: string } }>(
      h.app.request("/auth/session", {
        headers: { cookie: `purser_session=${id}` },
      }),
    );
    expect(session.viewer.email).toBe("fay@example.com");
    expect((await h.app.request("/me")).status).toBe(401);
  });
});

describe("asking for an agent", () => {
  const ask = (dailyUsd: number, name = "my-helper") => ({
    name,
    purpose: "Summarises supplier emails",
    dailyUsd,
  });

  it("is ready at once within the auto-approve limit, and its key works", async () => {
    const { h, finA } = company();
    const res = await h.as(finA, "POST", "/me/agents", ask(0.5));
    expect(res.status).toBe(201);
    const ready = (await res.json()) as {
      status: string;
      agent: PublicAgent;
      key: string;
      request: Request;
    };
    expect(ready.status).toBe("ready");
    expect(ready.agent).toMatchObject({
      owner: "finn",
      ownerEmail: "finn@example.com",
      team: "Finance",
      limits: { dailyUsd: 0.5 },
      rotation: { everyDays: 90, graceDays: 7 },
    });
    expect(ready.request).toMatchObject({
      status: "approved",
      decidedBy: "auto",
    });
    const call = await h.call("/openai/v1/chat/completions", {
      method: "POST",
      key: ready.key,
      body: chatBody(),
    });
    expect(call.status).toBe(200);
  });

  it("waits for a manager above it, then the owner collects a fresh key", async () => {
    const { h, finA, finMgr } = company();
    const res = await h.as(finA, "POST", "/me/agents", {
      ...ask(5),
      reason: "Month-end close",
    });
    expect(res.status).toBe(202);
    const { request } = (await res.json()) as { request: Request };
    expect(request).toMatchObject({
      status: "pending",
      department: "Finance",
      reason: "Month-end close",
    });
    expect(
      (await json<{ items: Request[] }>(h.as(finA, "GET", "/me/requests")))
        .items,
    ).toHaveLength(1);
    expect(
      (
        await json<{ pending: { toDecide: number } }>(
          h.as(finMgr, "GET", "/me"),
        )
      ).pending.toDecide,
    ).toBe(1);

    const approved = await json<Request>(
      h.as(finMgr, "POST", `/me/approvals/${request.id}/approve`, {
        note: "OK for this month",
      }),
    );
    expect(approved).toMatchObject({
      status: "approved",
      decidedBy: "fay@example.com",
      decidedByName: "fay",
      note: "OK for this month",
    });
    const agent = await json<PublicAgent>(
      h.as(finA, "GET", `/me/agents/${approved.agentId ?? ""}`),
    );
    expect(agent.awaitingKey).toBe(true);

    const collected = await json<{ key: string; agent: PublicAgent }>(
      h.as(finA, "POST", `/me/agents/${agent.id}/rotate-key`, {}),
    );
    expect(collected.agent.awaitingKey).toBeUndefined();
    expect(collected.agent.previousKeyValidUntil).toBeUndefined();
    const call = await h.call("/openai/v1/chat/completions", {
      method: "POST",
      key: collected.key,
      body: chatBody(),
    });
    expect(call.status).toBe(200);
    expect(h.store.auditLog().map((e) => e.type)).toEqual(
      expect.arrayContaining(["request.created", "request.approved"]),
    );
  });

  it("refuses what the department doesn't allow", async () => {
    const { h, finA, admin } = company();
    const over = await h.as(finA, "POST", "/me/agents", ask(500));
    expect(over.status).toBe(400);
    expect(await over.text()).toContain("$25");
    expect(
      (await h.as(finA, "POST", "/me/agents", ask(0.5, "fin-b-bot"))).status,
    ).toBe(409);
    expect(
      (await h.as(finA, "POST", "/me/agents", { ...ask(0.5), purpose: "" }))
        .status,
    ).toBe(400);
    expect(
      (
        await h.as(finA, "POST", "/me/agents", {
          ...ask(0.5),
          providers: ["nope"],
        })
      ).status,
    ).toBe(400);

    await h.admin("PUT", "/departments/Finance", {
      selfService: {
        autoApproveDailyUsd: 0,
        maxDailyUsd: 10,
        allowedProviders: ["openrouter"],
      },
    });
    const wrong = await h.as(finA, "POST", "/me/agents", {
      ...ask(1),
      providers: ["openai"],
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain("can't use OpenAI");
    // An auto-approve limit of 0 means every agent needs a yes.
    expect(
      (
        await h.as(finA, "POST", "/me/agents", {
          ...ask(0.01),
          providers: ["openrouter"],
        })
      ).status,
    ).toBe(202);

    await h.admin("PUT", "/settings/self-service", { selfService: false });
    expect((await h.as(finA, "POST", "/me/agents", ask(0.5, "x"))).status).toBe(
      403,
    );
    // The owner signed in by link or token has no department to ask from.
    void admin;
    const ownerRequests = await h.app.request("/me/requests", {
      headers: { authorization: "Bearer purser_admin_test" },
    });
    expect(ownerRequests.status).toBe(200);
    const asOwner = await h.app.request("/me/agents", {
      method: "POST",
      headers: {
        authorization: "Bearer purser_admin_test",
        "content-type": "application/json",
      },
      body: JSON.stringify(ask(0.5, "owner-bot")),
    });
    expect(asOwner.status).toBe(403);
  });
});

describe("deciding requests", () => {
  async function pending(h: Harness, person: Person, name = "big-helper") {
    const res = await h.as(person, "POST", "/me/agents", {
      name,
      purpose: "Drafts board papers",
      dailyUsd: 10,
    });
    return ((await res.json()) as { request: Request }).request;
  }

  it("lets only the right people decide, never their own request", async () => {
    const { h, finA, finB, finMgr, salesMgr, admin } = company();
    const mine = await pending(h, finMgr, "mgr-helper");
    const theirs = await pending(h, finA);
    const approve = (p: Person, r: Request) =>
      h.as(p, "POST", `/me/approvals/${r.id}/approve`, {});
    expect((await approve(finB, theirs)).status).toBe(403);
    expect((await approve(salesMgr, theirs)).status).toBe(403);
    const own = await approve(finMgr, mine);
    expect(own.status).toBe(403);
    expect(await own.text()).toContain("Someone else");
    expect((await approve(admin, mine)).status).toBe(200);
    expect((await approve(admin, mine)).status).toBe(409);
    // Managers see their department's requests; members see none to decide.
    expect(
      (
        await json<{ items: Request[] }>(h.as(finMgr, "GET", "/me/approvals"))
      ).items.map((r) => r.id),
    ).toEqual([theirs.id]);
    expect(
      (await json<{ items: Request[] }>(h.as(finA, "GET", "/me/approvals")))
        .items,
    ).toEqual([]);
    expect(
      (
        await json<{ items: Request[] }>(
          h.as(admin, "GET", "/me/approvals?status=approved"),
        )
      ).items.map((r) => r.id),
    ).toEqual([mine.id]);
    expect(
      (await h.as(admin, "POST", "/me/approvals/req_nope/approve", {})).status,
    ).toBe(404);
  });

  it("denies with a note, and lets people cancel their own pending asks", async () => {
    const { h, finA, finB, finMgr } = company();
    const first = await pending(h, finA, "one");
    const second = await pending(h, finA, "two");
    const denied = await json<Request>(
      h.as(finMgr, "POST", `/me/approvals/${first.id}/deny`, {
        note: "Use the shared bot",
      }),
    );
    expect(denied).toMatchObject({
      status: "denied",
      note: "Use the shared bot",
    });
    expect(
      (await h.as(finB, "POST", `/me/requests/${second.id}/cancel`)).status,
    ).toBe(403);
    expect(
      (
        await json<Request>(
          h.as(finA, "POST", `/me/requests/${second.id}/cancel`),
        )
      ).status,
    ).toBe("cancelled");
    expect(
      (await h.as(finA, "POST", `/me/requests/${first.id}/cancel`)).status,
    ).toBe(409);
    expect((await h.as(finA, "POST", "/me/requests/req_x/cancel")).status).toBe(
      404,
    );
  });

  it("refuses an approval when the name was taken meanwhile", async () => {
    const { h, finA, finMgr } = company();
    const r = await pending(h, finA, "racer");
    h.addAgent("racer");
    const res = await h.as(finMgr, "POST", `/me/approvals/${r.id}/approve`, {});
    expect(res.status).toBe(409);
  });
});

describe("raises and stops from /me", () => {
  it("turns a member's raise into a request, and applies a manager's at once", async () => {
    const { h, finA, finMgr } = company();
    const asked = await h.as(finA, "POST", "/me/agents/fin-a-bot/raise-limit", {
      window: "day",
      amountUsd: 3,
      reason: "Audit week",
    });
    expect(asked.status).toBe(202);
    const { request } = (await asked.json()) as { request: Request };
    expect(request.raise).toMatchObject({
      agentName: "fin-a-bot",
      amountUsd: 3,
    });
    await h.as(finMgr, "POST", `/me/approvals/${request.id}/approve`, {});
    const agent = await json<PublicAgent>(h.admin("GET", "/agents/fin-a-bot"));
    expect(agent.raised).toEqual({ dailyUsd: 3 });

    const direct = await json<{ status: string; agent: PublicAgent }>(
      h.as(finMgr, "POST", "/me/agents/fin-b-bot/raise-limit", {
        window: "day",
        amountUsd: 2,
      }),
    );
    expect(direct.status).toBe("raised");
    expect(direct.agent.raised).toEqual({ dailyUsd: 2 });
    expect(
      (
        await h.as(finMgr, "POST", "/me/agents/fin-b-bot/raise-limit", {
          window: "month",
          amountUsd: 2,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.as(finMgr, "POST", "/me/agents/fin-b-bot/raise-limit", {
          window: "year",
        })
      ).status,
    ).toBe(400);
  });

  it("lets owners stop their agents, but not undo a manager's stop", async () => {
    const { h, finA, finMgr } = company();
    await h.as(finA, "POST", "/me/agents/fin-a-bot/kill");
    expect(
      (await h.as(finA, "POST", "/me/agents/fin-a-bot/resume")).status,
    ).toBe(200);
    await h.as(finMgr, "POST", "/me/agents/fin-a-bot/kill");
    const res = await h.as(finA, "POST", "/me/agents/fin-a-bot/resume");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("fay@example.com stopped this agent");
    expect(
      (await h.as(finMgr, "POST", "/me/agents/fin-a-bot/resume")).status,
    ).toBe(200);
    expect(
      (
        await json<{ daily: unknown[] }>(
          h.as(finA, "GET", "/me/agents/fin-a-bot/usage?days=7"),
        )
      ).daily,
    ).toHaveLength(7);
    expect(
      (
        await h.as(finA, "POST", "/me/agents/fin-a-bot/rotate-key", {
          graceMinutes: -1,
        })
      ).status,
    ).toBe(400);
    expect((await h.as(finA, "GET", "/me/agents?sort=bogus")).status).toBe(400);
    const bad = await h.app.request("/me/agents/fin-a-bot/kill", {
      method: "POST",
      headers: {
        cookie: `purser_session=${h.sessions.signIn(finA.id)}`,
        "x-purser-csrf": "1",
      },
    });
    expect(bad.status).toBe(200);
  });
});

describe("people and offboarding", () => {
  it("stops a leaver's agents, signs them out and cancels their asks", async () => {
    const { h, finA, admin } = company();
    await h.as(finA, "POST", "/me/agents", {
      name: "pending-one",
      purpose: "Something big",
      dailyUsd: 10,
    });
    const session = h.sessions.signIn(finA.id);
    const res = await json<{ stopped: number; sessionsEnded: number }>(
      h.as(admin, "POST", `/admin/people/${finA.email}/disable`, {}),
    );
    expect(res.stopped).toBe(1);
    expect(res.sessionsEnded).toBeGreaterThanOrEqual(1);
    expect(
      (await json<PublicAgent>(h.admin("GET", "/agents/fin-a-bot"))).state,
    ).toBe("paused");
    expect(h.org.listRequests().find((r) => r.by === finA.email)?.status).toBe(
      "cancelled",
    );
    const after = await h.app.request("/me", {
      headers: { cookie: `purser_session=${session}` },
    });
    expect(after.status).toBe(401);
    expect(h.store.auditLog().at(-1)).toMatchObject({
      type: "person.disabled",
      detail: { person: "finn@example.com", stopped: 1 },
    });

    const back = await json<Person>(
      h.admin("POST", `/people/${finA.id}/enable`),
    );
    expect(back.status).toBe("active");
  });

  it("can hand a leaver's agents to someone else instead", async () => {
    const { h, finA, finB } = company();
    const res = await json<{ reassigned: number; stopped: number }>(
      h.admin("POST", `/people/${finA.email}/disable`, {
        reassignTo: finB.email,
      }),
    );
    expect(res).toMatchObject({ reassigned: 1, stopped: 0 });
    const agent = await json<PublicAgent>(h.admin("GET", "/agents/fin-a-bot"));
    expect(agent).toMatchObject({
      ownerEmail: "fern@example.com",
      owner: "fern",
      state: "running",
    });
    expect(
      (
        await h.admin("POST", `/people/${finB.email}/disable`, {
          reassignTo: finA.email,
        })
      ).status,
    ).toBe(400);
    expect((await h.admin("POST", "/people/ghost/disable", {})).status).toBe(
      404,
    );
    expect((await h.admin("POST", "/people/ghost/enable")).status).toBe(404);
  });

  it("adds, finds and changes people", async () => {
    const { h } = company();
    const added = await h.admin("POST", "/people", {
      email: "New.Person@Example.com",
      name: "New Person",
      role: "manager",
      department: "Legal",
      manages: ["Legal"],
    });
    expect(added.status).toBe(201);
    const person = (await added.json()) as Person;
    expect(person.email).toBe("new.person@example.com");
    expect(
      (
        await h.admin("POST", "/people", {
          email: "new.person@example.com",
          name: "x",
        })
      ).status,
    ).toBe(409);
    expect((await h.admin("POST", "/people", { email: "nope" })).status).toBe(
      400,
    );

    const list = await json<{
      items: (Person & { agents: number })[];
      total: number;
    }>(h.admin("GET", "/people?department=Finance&role=member"));
    expect(list.items.map((p) => [p.email, p.agents])).toEqual([
      ["fern@example.com", 1],
      ["finn@example.com", 1],
    ]);
    expect(
      (await json<{ total: number }>(h.admin("GET", "/people?q=sol"))).total,
    ).toBe(1);
    expect(
      (await json<{ total: number }>(h.admin("GET", "/people?status=disabled")))
        .total,
    ).toBe(0);

    const demoted = await json<Person>(
      h.admin("PATCH", `/people/${person.id}`, {
        role: "member",
        department: null,
      }),
    );
    expect(demoted).toMatchObject({ role: "member" });
    expect(demoted.manages).toBeUndefined();
    expect(demoted.department).toBeUndefined();
    expect(
      (await h.admin("PATCH", `/people/${person.id}`, { role: "boss" })).status,
    ).toBe(400);
    expect((await h.admin("PATCH", "/people/ghost", {})).status).toBe(404);
  });
});

describe("departments and organisation settings", () => {
  it("rolls up agents, people and requests per department", async () => {
    const { h, finA } = company();
    await h.as(finA, "POST", "/me/agents", {
      name: "needs-ok",
      purpose: "Something big",
      dailyUsd: 10,
    });
    await h.admin("POST", "/agents/sales-bot/kill");
    const res = await json<{
      items: {
        name: string;
        agents: number;
        green: number;
        red: number;
        people: number;
        pending: number;
        managers: { email: string }[];
      }[];
    }>(h.admin("GET", "/departments"));
    const fin = res.items.find((d) => d.name === "Finance");
    expect(fin).toMatchObject({
      agents: 2,
      green: 2,
      people: 3,
      pending: 1,
      managers: [{ email: "fay@example.com" }],
    });
    expect(res.items.find((d) => d.name === "Sales")).toMatchObject({ red: 1 });
    expect(res.items.map((d) => d.name)).toContain("IT");

    const saved = await h.admin("PUT", "/departments/Finance", {
      budgetMonthlyUsd: 500,
    });
    expect(await saved.json()).toMatchObject({ budgetMonthlyUsd: 500 });
    expect(
      (
        await h.admin("PUT", "/departments/Finance", {
          selfService: { autoApproveDailyUsd: 50, maxDailyUsd: 10 },
        })
      ).status,
    ).toBe(400);
    const cleared = await json<{ budgetMonthlyUsd?: number }>(
      h.admin("PUT", "/departments/Finance", {
        budgetMonthlyUsd: null,
        selfService: null,
      }),
    );
    expect(cleared.budgetMonthlyUsd).toBeUndefined();
  });

  it("stores the company sign-in, keeping the secret in the vault", async () => {
    const { h } = company();
    const res = await h.admin("PUT", "/settings/sign-in", {
      issuer: "https://login.example.com/tenant/v2.0/",
      clientId: "abc",
      clientSecret: "s3cret-value",
      allowedDomains: ["Example.com"],
      adminEmails: ["Ada@Example.com"],
      label: "Sign in with Example",
    });
    expect(res.status).toBe(200);
    const view = (await res.json()) as {
      signIn: { issuer: string; hasSecret: boolean; allowedDomains: string[] };
      redirectUri: string;
    };
    expect(view.signIn).toMatchObject({
      issuer: "https://login.example.com/tenant/v2.0",
      hasSecret: true,
      allowedDomains: ["example.com"],
    });
    expect(view.redirectUri).toBe("http://127.0.0.1:4141/auth/sso/callback");
    expect(JSON.stringify(view)).not.toContain("s3cret-value");
    expect(
      (await json<{ sso: { label: string } }>(h.app.request("/auth/options")))
        .sso.label,
    ).toBe("Sign in with Example");

    expect(
      (
        await h.admin("PUT", "/settings/sign-in", {
          issuer: "http://insecure.example.com",
          clientId: "abc",
          allowedDomains: ["example.com"],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.admin("PUT", "/settings/sign-in", {
          issuer: "https://x.example.com",
          clientId: "abc",
          allowedDomains: [],
        })
      ).status,
    ).toBe(400);
    const shared = await h.admin("PUT", "/settings/sign-in", {
      issuer: "https://login.microsoftonline.com/common/v2.0",
      clientId: "abc",
      allowedDomains: ["example.com"],
    });
    expect(shared.status).toBe(400);
    expect(await shared.text()).toContain("your own tenant");
    const kept = await json<{ signIn: { hasSecret: boolean } }>(
      h.admin("PUT", "/settings/sign-in", {
        issuer: "https://x.example.com",
        clientId: "abc",
        allowedDomains: ["example.com"],
      }),
    );
    expect(kept.signIn.hasSecret).toBe(true);
    const removed = await json<{ signIn: { hasSecret: boolean } }>(
      h.admin("PUT", "/settings/sign-in", {
        issuer: "https://x.example.com",
        clientId: "abc",
        clientSecret: "",
        allowedDomains: ["example.com"],
      }),
    );
    expect(removed.signIn.hasSecret).toBe(false);
    const off = await json<{ signIn: null }>(
      h.admin("DELETE", "/settings/sign-in"),
    );
    expect(off.signIn).toBeNull();
    expect(
      (await h.app.request("/auth/sso/start")).headers.get("location"),
    ).toBe("/?login=sso_off");
    expect(
      (await h.app.request("/auth/sso/callback")).headers.get("location"),
    ).toBe("/?login=sso_off");
  });

  it("sets the organisation's self-service defaults", async () => {
    const { h } = company();
    const view = await json<{
      selfService: boolean;
      defaults: { maxDailyUsd: number; allowedProviders?: string[] };
    }>(
      h.admin("PUT", "/settings/self-service", {
        selfService: true,
        defaults: {
          autoApproveDailyUsd: 2,
          maxDailyUsd: 40,
          allowedProviders: ["openrouter"],
        },
      }),
    );
    expect(view.defaults).toEqual({
      autoApproveDailyUsd: 2,
      maxDailyUsd: 40,
      allowedProviders: ["openrouter"],
    });
    expect(
      (await json<{ defaults: unknown }>(h.admin("GET", "/settings/org")))
        .defaults,
    ).toEqual(view.defaults);
    expect(
      (await h.admin("PUT", "/settings/self-service", { selfService: "yes" }))
        .status,
    ).toBe(400);
  });
});

describe("demo sign-in", () => {
  it("is off unless the demo turns it on", async () => {
    const { h } = company();
    expect(
      (await json<{ demo: unknown }>(h.app.request("/auth/options"))).demo,
    ).toBeNull();
    const res = await h.app.request("/auth/demo", {
      method: "POST",
      body: JSON.stringify({ personId: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("lists a few people of each role and signs in as one", async () => {
    const h = harness({ demoSignIn: true });
    const m = h.org.addPerson({
      email: "m@example.com",
      name: "Mo",
      role: "manager",
      manages: ["Ops"],
      source: "demo",
    });
    const options = await json<{ demo: { id: string; role: string }[] }>(
      h.app.request("/auth/options"),
    );
    expect(options.demo.map((p) => p.role)).toEqual(["manager"]);
    const res = await h.app.request("/auth/demo", {
      method: "POST",
      body: JSON.stringify({ personId: m.id }),
    });
    expect(res.status).toBe(200);
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const me = await json<{ viewer: { name: string } }>(
      h.app.request("/me", { headers: { cookie } }),
    );
    expect(me.viewer.name).toBe("Mo");
    expect(
      (
        await h.app.request("/auth/demo", {
          method: "POST",
          body: JSON.stringify({ personId: "nobody" }),
        })
      ).status,
    ).toBe(404);
    expect(
      (await h.app.request("/auth/demo", { method: "POST", body: "{" })).status,
    ).toBe(400);
  });
});
