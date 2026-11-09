import { describe, expect, it } from "vitest";
import type { Person, Request as OrgRequest } from "./org.js";
import { chatBody, harness } from "./test/helpers.js";
import type { PublicAgent } from "./types.js";

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
    manager: add("mia@example.com", "manager", "Eng", ["Eng"]),
    owner: add("omar@example.com", "member", "Eng"),
    other: add("otto@example.com", "member", "Eng"),
  };
  const coder = h.addAgent(
    "coder",
    { dailyUsd: 5 },
    { team: "Eng", ownerEmail: "omar@example.com", providers: ["anthropic"] },
  );
  return { h, people, coder };
}

const chat = (h: ReturnType<typeof company>["h"], key: string, extra = {}) =>
  h.call("/openai/v1/chat/completions", {
    method: "POST",
    key,
    body: chatBody(extra),
  });

describe("limits per service", () => {
  it("adds a service to the agent's list, so its key reaches it", async () => {
    const { h, coder } = company();
    expect((await chat(h, coder.key)).status).toBe(403);
    const res = await h.admin("PUT", `/agents/${coder.id}/services/openai`, {
      dailyUsd: 2,
    });
    expect(res.status).toBe(200);
    const agent = (await res.json()) as PublicAgent;
    expect(agent.providers).toEqual(["anthropic", "openai"]);
    expect(agent.serviceLimits?.openai?.dailyUsd).toBe(2);
    expect((await chat(h, coder.key)).status).toBe(200);
    const after = (await (
      await h.admin("GET", `/agents/${coder.id}`)
    ).json()) as PublicAgent;
    expect(after.serviceSpend.openai?.today).toBeGreaterThan(0);
    expect(after.serviceSpend.anthropic?.today).toBe(0);
  });

  it("stops at the service's limit while other services carry on", async () => {
    const { h, coder } = company();
    await h.admin("PUT", `/agents/${coder.id}/services/openai`, {
      dailyUsd: 0.000001,
    });
    expect((await chat(h, coder.key)).status).toBe(200);
    const refused = await chat(h, coder.key);
    expect(refused.status).toBe(403);
    expect(refused.headers.get("x-purser-denied")).toBe("budget_exceeded");
    expect(await refused.text()).toContain("on OpenAI");
    const other = await h.call("/anthropic/v1/messages", {
      method: "POST",
      key: coder.key,
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(other.status).toBe(200);
  });

  it("has a monthly limit too", async () => {
    const { h, coder } = company();
    await h.admin("PUT", `/agents/${coder.id}/services/openai`, {
      monthlyUsd: 0.000001,
    });
    expect((await chat(h, coder.key)).status).toBe(200);
    const refused = await chat(h, coder.key);
    expect(await refused.text()).toContain("monthly limit");
  });

  it("the agent's overall cap still applies", async () => {
    const { h, coder } = company();
    await h.admin("PUT", `/agents/${coder.id}`, {});
    await h.admin("PATCH", `/agents/${coder.id}`, {
      limits: { dailyUsd: 0.000001 },
    });
    await h.admin("PUT", `/agents/${coder.id}/services/openai`, {
      dailyUsd: 100,
    });
    expect((await chat(h, coder.key)).status).toBe(200);
    const refused = await chat(h, coder.key);
    expect(await refused.text()).toContain("daily cap");
  });

  it("a service's model list replaces the agent's own there", async () => {
    const { h, coder } = company();
    await h.admin("PATCH", `/agents/${coder.id}`, {
      limits: { dailyUsd: 5, models: ["claude-sonnet-4-5"] },
    });
    await h.admin("PUT", `/agents/${coder.id}/services/openai`, {
      models: ["gpt-4o"],
    });
    expect((await chat(h, coder.key, { model: "gpt-4o" })).status).toBe(200);
    const refused = await chat(h, coder.key, { model: "gpt-3.5-turbo" });
    expect(refused.headers.get("x-purser-denied")).toBe("model_not_allowed");
  });

  it("reports what each call cost", async () => {
    const { h, coder } = company();
    await h.admin("PUT", `/agents/${coder.id}/services/openai`, {});
    const res = await chat(h, coder.key);
    expect(Number(res.headers.get("x-purser-cost-usd"))).toBeGreaterThan(0);
  });

  it("the admin routes check what they're given", async () => {
    const { h, coder } = company();
    const unknown = await h.admin("PUT", `/agents/${coder.id}/services/nope`, {
      dailyUsd: 1,
    });
    expect(unknown.status).toBe(400);
    const bad = await h.admin("PUT", `/agents/${coder.id}/services/openai`, {
      dailyUsd: -1,
    });
    expect(bad.status).toBe(400);
    const missing = await h.admin("PUT", `/agents/nope/services/openai`, {});
    expect(missing.status).toBe(404);
    const gone = await h.admin("DELETE", `/agents/nope/services/openai`);
    expect(gone.status).toBe(404);
  });

  it("takes a service away, but never the last one", async () => {
    const { h, coder } = company();
    await h.admin("PUT", `/agents/${coder.id}/services/openai`, {
      dailyUsd: 1,
    });
    const removed = await h.admin(
      "DELETE",
      `/agents/${coder.id}/services/openai`,
    );
    const agent = (await removed.json()) as PublicAgent;
    expect(agent.providers).toEqual(["anthropic"]);
    expect(agent.serviceLimits).toBeUndefined();
    expect((await chat(h, coder.key)).status).toBe(403);
    // An empty list means any provider, so the last one stays.
    const last = await h.admin(
      "DELETE",
      `/agents/${coder.id}/services/anthropic`,
    );
    expect(last.status).toBe(409);
  });

  it("on an agent allowed anything, it only sets or lifts a limit", async () => {
    const { h } = company();
    const open = h.addAgent("open");
    const set = (await (
      await h.admin("PUT", `/agents/${open.id}/services/openai`, {
        dailyUsd: 1,
      })
    ).json()) as PublicAgent;
    expect(set.providers).toBeUndefined();
    const lifted = (await (
      await h.admin("DELETE", `/agents/${open.id}/services/openai`)
    ).json()) as PublicAgent;
    expect(lifted.providers).toBeUndefined();
    expect(lifted.serviceLimits).toBeUndefined();
  });
});

describe("asking for a service", () => {
  it("is granted at once within the auto-approve limit", async () => {
    const { h, people, coder } = company();
    const res = await h.as(
      people.owner,
      "POST",
      `/me/agents/${coder.id}/services`,
      { provider: "openai", dailyUsd: 0.5, models: ["gpt-4o"] },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      agent: PublicAgent;
      request: OrgRequest;
    };
    expect(body.status).toBe("granted");
    expect(body.request.decidedBy).toBe("auto");
    expect(body.agent.serviceLimits?.openai).toEqual({
      dailyUsd: 0.5,
      models: ["gpt-4o"],
    });
    expect((await chat(h, coder.key, { model: "gpt-4o" })).status).toBe(200);
  });

  it("goes to a manager above that", async () => {
    const { h, people, coder } = company();
    const res = await h.as(
      people.owner,
      "POST",
      `/me/agents/${coder.id}/services`,
      {
        provider: "openai",
        dailyUsd: 10,
        monthlyUsd: 50,
        reason: "Long reviews.",
      },
    );
    expect(res.status).toBe(202);
    const { request } = (await res.json()) as { request: OrgRequest };
    expect(request.kind).toBe("service");
    expect(request.service?.providerName).toBe("OpenAI");
    expect((await chat(h, coder.key)).status).toBe(403);
    // A person can't approve what they asked for themselves.
    const mine = await h.as(
      people.owner,
      "POST",
      `/me/approvals/${request.id}/approve`,
      {},
    );
    expect(mine.status).toBe(403);
    const yes = await h.as(
      people.manager,
      "POST",
      `/me/approvals/${request.id}/approve`,
      {},
    );
    expect(yes.status).toBe(200);
    expect((await chat(h, coder.key)).status).toBe(200);
  });

  it("a manager or admin just sets it", async () => {
    const { h, people, coder } = company();
    const res = await h.as(
      people.manager,
      "POST",
      `/me/agents/${coder.id}/services`,
      { provider: "openai", dailyUsd: 20, monthlyUsd: 90, models: ["gpt-4o"] },
    );
    const body = (await res.json()) as { status: string; agent: PublicAgent };
    expect(body.status).toBe("granted");
    expect(body.agent.serviceLimits?.openai).toEqual({
      dailyUsd: 20,
      monthlyUsd: 90,
      models: ["gpt-4o"],
    });
    const unknown = await h.as(
      people.manager,
      "POST",
      `/me/agents/${coder.id}/services`,
      { provider: "nope", dailyUsd: 1 },
    );
    expect(unknown.status).toBe(400);
  });

  it("nobody else can touch it, and asks are checked", async () => {
    const { h, people, coder } = company();
    const other = await h.as(
      people.other,
      "POST",
      `/me/agents/${coder.id}/services`,
      { provider: "openai", dailyUsd: 1 },
    );
    expect(other.status).toBe(404);
    const bad = await h.as(
      people.owner,
      "POST",
      `/me/agents/${coder.id}/services`,
      { provider: "openai" },
    );
    expect(bad.status).toBe(400);
    const over = await h.as(
      people.owner,
      "POST",
      `/me/agents/${coder.id}/services`,
      { provider: "openai", dailyUsd: 5000 },
    );
    expect(
      ((await over.json()) as { error: { code: string } }).error.code,
    ).toBe("over_max");
    const unknown = await h.as(
      people.owner,
      "POST",
      `/me/agents/${coder.id}/services`,
      { provider: "nope", dailyUsd: 1 },
    );
    expect(
      ((await unknown.json()) as { error: { code: string } }).error.code,
    ).toBe("unknown_provider");
  });

  it("an owner may narrow what an agent has, not lift a limit", async () => {
    const { h, people, coder } = company();
    await h.admin("PUT", `/agents/${coder.id}/services/openai`, {
      dailyUsd: 1,
    });
    const ok = await h.as(
      people.owner,
      "DELETE",
      `/me/agents/${coder.id}/services/openai`,
    );
    expect(ok.status).toBe(200);
    const last = await h.as(
      people.owner,
      "DELETE",
      `/me/agents/${coder.id}/services/anthropic`,
    );
    expect(last.status).toBe(409);

    const open = h.addAgent(
      "open",
      { dailyUsd: 1 },
      { team: "Eng", ownerEmail: "omar@example.com" },
    );
    await h.admin("PUT", `/agents/${open.id}/services/openai`, { dailyUsd: 1 });
    const lift = await h.as(
      people.owner,
      "DELETE",
      `/me/agents/${open.id}/services/openai`,
    );
    expect(lift.status).toBe(403);
    const manager = await h.as(
      people.manager,
      "DELETE",
      `/me/agents/${open.id}/services/openai`,
    );
    expect(manager.status).toBe(200);
  });

  it("an approved request for a removed agent says so", async () => {
    const { h, people, coder } = company();
    const res = await h.as(
      people.owner,
      "POST",
      `/me/agents/${coder.id}/services`,
      { provider: "openai", dailyUsd: 10 },
    );
    const { request } = (await res.json()) as { request: OrgRequest };
    const service = request.service;
    if (!service) throw new Error("Expected a service request.");
    h.org.updateRequest(request.id, {
      service: { ...service, agentId: "agt_gone" },
    });
    const yes = await h.as(
      people.manager,
      "POST",
      `/me/approvals/${request.id}/approve`,
      {},
    );
    expect(yes.status).toBe(404);
  });
});

describe("the me summary", () => {
  it("says where to connect over MCP", async () => {
    const { h, people } = company();
    const me = (await (await h.as(people.owner, "GET", "/me")).json()) as {
      mcp: { enabled: boolean; url: string };
    };
    expect(me.mcp.enabled).toBe(true);
    expect(me.mcp.url).toMatch(/\/mcp$/);
  });
});
