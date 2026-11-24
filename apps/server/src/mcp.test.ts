import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { demoFetch, DEMO_PROVIDER_KEY } from "./demo-upstream.js";
import { MCP_PROTOCOL_VERSIONS } from "./mcp.js";
import type { Person, Request as OrgRequest } from "./org.js";
import { chatBody, harness, type Harness } from "./test/helpers.js";

const URL_ = "http://purser.test/mcp";

/** The official MCP client, talking to Purser with this agent's key. */
async function connect(h: Harness, key: string): Promise<Client> {
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(URL_), {
      fetch: (url, init) => Promise.resolve(h.app.request(String(url), init)),
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  );
  return client;
}

type Called = {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
};

const call = async (
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) => (await client.callTool({ name, arguments: args })) as Called;

const text = (r: Called) => r.content[0]?.text ?? "";

const post = (
  h: Harness,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  Promise.resolve(
    h.app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

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
    manager: add("mia@example.com", "manager", "Eng", ["Eng"]),
    owner: add("omar@example.com", "member", "Eng"),
  };
  const coder = h.addAgent(
    "coder",
    { dailyUsd: 5 },
    { team: "Eng", ownerEmail: "omar@example.com", providers: ["anthropic"] },
  );
  return { h, people, coder };
}

describe("connecting", () => {
  it("works with the official MCP client and lists the tools", async () => {
    const { h, coder } = company();
    const client = await connect(h, coder.key);
    expect(client.getServerVersion()?.name).toBe("roai-purser");
    expect(client.getInstructions()).toContain("list_my_services");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "ask_model",
      "check_my_requests",
      "get_my_account",
      "get_my_usage",
      "list_models",
      "list_my_services",
      "report_outcome",
      "request_more_budget",
      "request_service",
    ]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.description).toBeTruthy();
    }
    await client.ping();
    await client.close();
  });

  it("agrees on a protocol version, or offers its newest", async () => {
    const { h, coder } = company();
    const auth = { authorization: `Bearer ${coder.key}` };
    const init = (protocolVersion: unknown) =>
      post(
        h,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion },
        },
        auth,
      );
    const version = async (v: unknown) =>
      (
        (await (await init(v)).json()) as {
          result: { protocolVersion: string };
        }
      ).result.protocolVersion;
    expect(await version("2025-06-18")).toBe("2025-06-18");
    expect(await version("1999-01-01")).toBe(MCP_PROTOCOL_VERSIONS[0]);
    const refused = await post(
      h,
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { ...auth, "mcp-protocol-version": "1999-01-01" },
    );
    expect(refused.status).toBe(400);
  });

  it("turns away missing, wrong and rotated keys", async () => {
    const { h, coder } = company();
    const message = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    expect((await post(h, message)).status).toBe(401);
    expect(
      (await post(h, message, { authorization: "Bearer nope" })).status,
    ).toBe(401);
    expect((await post(h, message, { "x-api-key": coder.key })).status).toBe(
      200,
    );
    const rotated = (await (
      await h.admin("POST", `/agents/${coder.id}/rotate-key`, {})
    ).json()) as { key: string };
    expect(
      (await post(h, message, { authorization: `Bearer ${coder.key}` })).status,
    ).toBe(401);
    expect(
      (await post(h, message, { authorization: `Bearer ${rotated.key}` }))
        .status,
    ).toBe(200);
  });

  it("refuses an expired key, and warns about an old one in its overlap", async () => {
    const { h, coder } = company();
    const rotated = (await (
      await h.admin("POST", `/agents/${coder.id}/rotate-key`, {
        graceMinutes: 60,
      })
    ).json()) as { key: string };
    const old = await connect(h, coder.key);
    const account = await call(old, "get_my_account");
    expect(text(account)).toContain("old key");

    await h.admin("PATCH", `/agents/${coder.id}`, {
      keyExpiresAt: new Date(h.clock.now.getTime() + 60_000).toISOString(),
    });
    h.clock.now = new Date(h.clock.now.getTime() + 120_000);
    const expired = await post(
      h,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { authorization: `Bearer ${rotated.key}` },
    );
    expect(expired.status).toBe(403);
    expect(await expired.text()).toContain("expired");
  });

  it("speaks JSON-RPC properly", async () => {
    const { h, coder } = company();
    const auth = { authorization: `Bearer ${coder.key}` };
    expect((await post(h, "{not json", auth)).status).toBe(400);
    expect((await post(h, [{ jsonrpc: "2.0" }], auth)).status).toBe(400);
    const note = await post(
      h,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      auth,
    );
    expect(note.status).toBe(202);
    const unknown = (await (
      await post(h, { jsonrpc: "2.0", id: 2, method: "sampling/nope" }, auth)
    ).json()) as { error: { code: number } };
    expect(unknown.error.code).toBe(-32601);
    const noTool = (await (
      await post(
        h,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "steal_keys" },
        },
        auth,
      )
    ).json()) as { error: { code: number } };
    expect(noTool.error.code).toBe(-32602);
    expect((await h.app.request("/mcp")).status).toBe(405);
    expect((await h.app.request("/mcp", { method: "DELETE" })).status).toBe(
      405,
    );
  });

  it("turns away other sites and oversized messages", async () => {
    const { h, coder } = company();
    const auth = { authorization: `Bearer ${coder.key}` };
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect(
      (await post(h, ping, { ...auth, origin: "https://evil.example" })).status,
    ).toBe(403);
    expect((await post(h, ping, { ...auth, origin: "not a url" })).status).toBe(
      403,
    );
    // A rebound name: the page's own address, sent as both Origin and Host.
    expect(
      (
        await post(h, ping, {
          ...auth,
          origin: "http://evil.example:4141",
          host: "evil.example:4141",
        })
      ).status,
    ).toBe(403);
    expect(
      (await post(h, ping, { ...auth, origin: "http://127.0.0.1:4141" }))
        .status,
    ).toBe(200);
    const huge = await post(h, "x".repeat(3 * 1024 * 1024), {
      ...auth,
      "content-length": String(3 * 1024 * 1024),
    });
    expect(huge.status).toBe(413);
  });

  it("can be turned off, and says so", async () => {
    const { h, coder } = company();
    const off = await h.admin("PUT", "/settings/mcp", { enabled: false });
    expect(
      ((await off.json()) as { mcp: { enabled: boolean } }).mcp.enabled,
    ).toBe(false);
    const refused = await post(
      h,
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { authorization: `Bearer ${coder.key}` },
    );
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("turned off");
    expect(
      (await h.admin("PUT", "/settings/mcp", { enabled: "yes" })).status,
    ).toBe(400);
    await h.admin("PUT", "/settings/mcp", { enabled: true });
    expect((await connect(h, coder.key)).getServerVersion()).toBeDefined();
  });
});

describe("what an agent can see", () => {
  it("shows its own account and never a key", async () => {
    const { h, coder } = company();
    h.addAgent("someone-else", { dailyUsd: 99 }, { team: "Sales" });
    const client = await connect(h, coder.key);
    const raw = text(await call(client, "get_my_account"));
    const account = JSON.parse(raw) as {
      name: string;
      department: string;
      limits: { dailyUsd: number };
    };
    expect(account.name).toBe("coder");
    expect(account.department).toBe("Eng");
    expect(account.limits.dailyUsd).toBe(5);
    expect(raw).not.toContain(coder.key);
    expect(raw).not.toContain("someone-else");
    expect(raw).not.toContain("keyHash");
  });

  it("lists only the services it may use, with their limits", async () => {
    const { h, coder } = company();
    await h.admin("PUT", `/agents/${coder.id}/services/openai`, {
      dailyUsd: 2,
      models: ["gpt-4o"],
    });
    const client = await connect(h, coder.key);
    const { services } = (await call(client, "list_my_services"))
      .structuredContent as {
      services: {
        id: string;
        models: unknown;
        limits: { dailyUsd: number | null };
        baseUrl: string;
      }[];
    };
    expect(services.map((s) => s.id).sort()).toEqual(["anthropic", "openai"]);
    const openai = services.find((s) => s.id === "openai");
    expect(openai?.limits.dailyUsd).toBe(2);
    expect(openai?.models).toEqual(["gpt-4o"]);
    expect(openai?.baseUrl).toContain("/openai/v1");
  });

  it("an agent allowed anything sees every connected service", async () => {
    const h = harness();
    const open = h.addAgent("open");
    const client = await connect(h, open.key);
    const { services } = (await call(client, "list_my_services"))
      .structuredContent as { services: { id: string; models: unknown }[] };
    expect(services.map((s) => s.id).sort()).toEqual([
      "anthropic",
      "openai",
      "openrouter",
    ]);
    expect(services[0]?.models).toBe("any");
  });

  it("reports recent usage by service and model", async () => {
    const { h, coder } = company();
    await h.admin("PUT", `/agents/${coder.id}/services/openai`, {
      dailyUsd: 2,
    });
    await h.call("/openai/v1/chat/completions", {
      method: "POST",
      key: coder.key,
      body: chatBody(),
    });
    const client = await connect(h, coder.key);
    const usage = (await call(client, "get_my_usage", { days: 3 }))
      .structuredContent as {
      calls: number;
      totalUsd: number;
      byService: Record<string, number>;
      byModel: Record<string, number>;
    };
    expect(usage.calls).toBe(1);
    expect(usage.byService.openai).toBeGreaterThan(0);
    expect(usage.byModel["gpt-4o-mini"]).toBe(usage.totalUsd);
    h.clock.now = new Date(h.clock.now.getTime() + 8 * 86_400_000);
    const later = (await call(client, "get_my_usage")).structuredContent as {
      calls: number;
    };
    expect(later.calls).toBe(0);
  });
});

describe("asking another model", () => {
  it("a Claude-side agent asks OpenAI, metered under its own account", async () => {
    const { h, coder } = company();
    await h.admin("PUT", `/agents/${coder.id}/services/openai`, {
      dailyUsd: 2,
    });
    const client = await connect(h, coder.key);
    const result = await call(client, "ask_model", {
      service: "openai",
      model: "gpt-4o",
      system: "Find what is wrong.",
      prompt: "Review this diff.",
    });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toBe("Hello world");
    expect(result.structuredContent?.costUsd).toBeGreaterThan(0);

    // The provider got the real key and never saw the agent's.
    const seen = h.upstream.seen.at(-1);
    expect(seen?.path).toBe("/openai/v1/chat/completions");
    expect(seen?.headers.authorization).toBe("Bearer sk-real-openai");
    expect(JSON.stringify(seen)).not.toContain(coder.key);
    expect(seen?.body?.max_completion_tokens).toBe(4096);
    expect(seen?.body?.max_tokens).toBeUndefined();
    expect(seen?.body?.messages).toEqual([
      { role: "system", content: "Find what is wrong." },
      { role: "user", content: "Review this diff." },
    ]);

    const usage = h.store.listUsage(coder.id);
    expect(usage).toHaveLength(1);
    expect(usage[0]?.provider).toBe("openai");
    expect(
      h.store.serviceSpend(coder.id, "openai", "day", h.clock.now),
    ).toBeGreaterThan(0);
  });

  it("speaks each service's own format", async () => {
    const { h, coder } = company();
    const client = await connect(h, coder.key);
    const result = await call(client, "ask_model", {
      service: "Anthropic",
      model: "claude-sonnet-4-5",
      system: "Be brief.",
      prompt: "Hello?",
      max_tokens: 50,
    });
    expect(result.isError).toBeFalsy();
    const seen = h.upstream.seen.at(-1);
    expect(seen?.path).toBe("/anthropic/v1/messages");
    expect(seen?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(seen?.headers["x-api-key"]).toBe("sk-ant-real");
    expect(seen?.body?.max_tokens).toBe(50);
    expect(seen?.body?.system).toBe("Be brief.");
  });

  it("refuses a service the agent doesn't have, and says what it can use", async () => {
    const { h, coder } = company();
    const client = await connect(h, coder.key);
    const result = await call(client, "ask_model", {
      service: "openai",
      model: "gpt-4o",
      prompt: "Hi",
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("It can use: anthropic");
    expect(text(result)).toContain("request_service");
    expect(h.upstream.seen).toHaveLength(0);
    const none = await call(client, "ask_model", {
      service: "nothing",
      model: "x",
      prompt: "Hi",
    });
    expect(none.isError).toBe(true);
  });

  it("keeps to the agent's limits and models", async () => {
    const { h, coder } = company();
    await h.admin("PUT", `/agents/${coder.id}/services/openai`, {
      dailyUsd: 0.000001,
      models: ["gpt-4o"],
    });
    const client = await connect(h, coder.key);
    const wrong = await call(client, "ask_model", {
      service: "openai",
      model: "gpt-3.5-turbo",
      prompt: "Hi",
    });
    expect(wrong.isError).toBe(true);
    expect(text(wrong)).toContain("may not use model");
    const first = await call(client, "ask_model", {
      service: "openai",
      model: "gpt-4o",
      prompt: "Hi",
    });
    expect(first.isError).toBeFalsy();
    const second = await call(client, "ask_model", {
      service: "openai",
      model: "gpt-4o",
      prompt: "Hi",
    });
    expect(second.isError).toBe(true);
    expect(text(second)).toContain("daily limit");
    expect(text(second)).toContain("OpenAI");
  });

  it("stops the moment the agent is stopped", async () => {
    const { h, coder } = company();
    const client = await connect(h, coder.key);
    await h.admin("POST", `/agents/${coder.id}/kill`);
    const result = await call(client, "ask_model", {
      service: "anthropic",
      model: "claude-sonnet-4-5",
      prompt: "Hi",
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("paused");
    const account = (await call(client, "get_my_account"))
      .structuredContent as { state: string };
    expect(account.state).toBe("paused");
  });

  it("reports a provider's own errors", async () => {
    const h = harness({
      fetch: () =>
        Promise.resolve(
          Response.json(
            { error: { message: "model is busy" } },
            { status: 503 },
          ),
        ),
    });
    const a = h.addAgent("a");
    const client = await connect(h, a.key);
    const failed = await call(client, "ask_model", {
      service: "openai",
      model: "gpt-4o",
      prompt: "Hi",
    });
    expect(failed.isError).toBe(true);
    expect(text(failed)).toBe("model is busy");
    const models = await call(client, "list_models", { service: "openai" });
    expect(models.isError).toBe(true);
    expect(text(models)).toBe("model is busy");
  });

  it("checks the arguments and explains what's wrong", async () => {
    const { h, coder } = company();
    const client = await connect(h, coder.key);
    const result = await call(client, "ask_model", { service: "anthropic" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Check the arguments");
    expect(text(result)).toContain("prompt");
  });

  it("lists a service's models, within the allowed ones", async () => {
    const h = harness({
      providerKeys: { openai: DEMO_PROVIDER_KEY },
      upstreams: { openai: "https://api.openai.com/v1" },
      fetch: demoFetch(() => {
        throw new Error("no network in tests");
      }),
    });
    const a = h.addAgent("a", {}, { providers: ["openai"] });
    const client = await connect(h, a.key);
    const all = (await call(client, "list_models", { service: "openai" }))
      .structuredContent as { models: string[] };
    expect(all.models).toContain("gpt-4o-mini");
    await h.admin("PUT", `/agents/${a.id}/services/openai`, {
      models: ["gpt-4o-mini"],
    });
    const some = (await call(client, "list_models", { service: "openai" }))
      .structuredContent as { models: string[] };
    expect(some.models).toEqual(["gpt-4o-mini"]);
    const not = await call(client, "list_models", { service: "anthropic" });
    expect(not.isError).toBe(true);
  });
});

describe("an agent asking for more", () => {
  it("files a request a person decides, even within the auto-approve limit", async () => {
    const { h, people, coder } = company();
    const client = await connect(h, coder.key);
    const asked = await call(client, "request_service", {
      service: "OpenAI",
      daily_usd: 0.5,
      reason: "A second opinion on risky changes.",
    });
    expect(asked.isError).toBeFalsy();
    expect(asked.structuredContent?.status).toBe("pending");
    // Nothing changed yet.
    const still = await call(client, "ask_model", {
      service: "openai",
      model: "gpt-4o",
      prompt: "Hi",
    });
    expect(still.isError).toBe(true);

    // Its owner sees it under their requests, and may say yes: it's within
    // what they could have given it themselves.
    const mine = (await (
      await h.as(people.owner, "GET", "/me/requests")
    ).json()) as { items: OrgRequest[] };
    const request = mine.items[0];
    expect(request?.askedByAgent?.name).toBe("coder");
    expect(request?.ownerMayDecide).toBe(true);
    const yes = await h.as(
      people.owner,
      "POST",
      `/me/approvals/${request?.id}/approve`,
      {},
    );
    expect(yes.status).toBe(200);

    const now = await call(client, "ask_model", {
      service: "openai",
      model: "gpt-4o",
      prompt: "Hi",
    });
    expect(now.isError).toBeFalsy();
    const requests = (await call(client, "check_my_requests"))
      .structuredContent as { requests: { status: string }[] };
    expect(requests.requests[0]?.status).toBe("approved");
    expect(h.store.getAgent(coder.id)?.serviceLimits?.openai?.dailyUsd).toBe(
      0.5,
    );
  });

  it("above that, its owner can't decide but a manager can", async () => {
    const { h, people, coder } = company();
    const client = await connect(h, coder.key);
    await call(client, "request_service", {
      service: "openai",
      daily_usd: 10,
      monthly_usd: 40,
      reason: "Long reviews.",
    });
    const [request] = (
      (await (await h.as(people.owner, "GET", "/me/requests")).json()) as {
        items: OrgRequest[];
      }
    ).items;
    expect(request?.ownerMayDecide).toBeUndefined();
    const no = await h.as(
      people.owner,
      "POST",
      `/me/approvals/${request?.id}/approve`,
      {},
    );
    expect(no.status).toBe(403);
    const waiting = (await (
      await h.as(people.manager, "GET", "/me/approvals?status=pending")
    ).json()) as { items: OrgRequest[] };
    expect(waiting.items[0]?.service?.provider).toBe("openai");
    const yes = await h.as(
      people.manager,
      "POST",
      `/me/approvals/${request?.id}/approve`,
      { note: "Fine for now." },
    );
    expect(yes.status).toBe(200);
    expect(h.store.getAgent(coder.id)?.serviceLimits?.openai).toEqual({
      dailyUsd: 10,
      monthlyUsd: 40,
    });
    const after = (await call(client, "check_my_requests"))
      .structuredContent as { requests: { note: string }[] };
    expect(after.requests[0]?.note).toBe("Fine for now.");
  });

  it("can't flood anyone: one per service, and a few at a time", async () => {
    const { h, coder } = company();
    const client = await connect(h, coder.key);
    const ask = (service: string) =>
      call(client, "request_service", {
        service,
        daily_usd: 1,
        reason: "Because.",
      });
    const first = await ask("openai");
    const again = await ask("openai");
    expect(again.structuredContent?.id).toBe(first.structuredContent?.id);
    await ask("xai");
    await ask("gemini");
    await ask("mistral");
    await ask("groq");
    const sixth = await ask("deepseek");
    expect(sixth.isError).toBe(true);
    expect(text(sixth)).toContain("already waiting");
    const budget = await call(client, "request_more_budget", {
      window: "day",
      amount_usd: 5,
      reason: "Deadline.",
    });
    expect(budget.isError).toBe(true);
  });

  it("follows the department's rules", async () => {
    const { h, coder } = company();
    h.org.setDepartment({
      name: "Eng",
      selfService: {
        autoApproveDailyUsd: 1,
        maxDailyUsd: 5,
        allowedProviders: ["anthropic", "openai"],
      },
    });
    const client = await connect(h, coder.key);
    const ask = (service: string, daily: number) =>
      call(client, "request_service", {
        service,
        daily_usd: daily,
        reason: "Because.",
      });
    const over = await ask("openai", 50);
    expect(over.isError).toBe(true);
    expect(text(over)).toContain("$5");
    const banned = await ask("xai", 1);
    expect(banned.isError).toBe(true);
    expect(text(banned)).toContain("can't use xAI");
    const unknown = await ask("nothing", 1);
    expect(unknown.isError).toBe(true);
    h.org.updateSettings({ selfService: false });
    const off = await ask("openai", 1);
    expect(off.isError).toBe(true);
    expect(text(off)).toContain("turned off");
  });

  it("a stopped agent can't ask for anything", async () => {
    const { h, coder } = company();
    const client = await connect(h, coder.key);
    await h.admin("POST", `/agents/${coder.id}/kill`);
    const a = await call(client, "request_service", {
      service: "openai",
      daily_usd: 1,
      reason: "Because.",
    });
    const b = await call(client, "request_more_budget", {
      window: "day",
      amount_usd: 1,
      reason: "Because.",
    });
    expect(a.isError).toBe(true);
    expect(b.isError).toBe(true);
    expect(h.org.listRequests()).toHaveLength(0);
  });

  it("asks for more budget, for a manager to decide", async () => {
    const { h, people, coder } = company();
    const client = await connect(h, coder.key);
    const none = await call(client, "request_more_budget", {
      window: "month",
      amount_usd: 5,
      reason: "No monthly limit to raise.",
    });
    expect(none.isError).toBe(true);
    const asked = await call(client, "request_more_budget", {
      window: "day",
      amount_usd: 5,
      reason: "A big review today.",
    });
    expect(asked.structuredContent?.status).toBe("pending");
    const [request] = (
      (await (
        await h.as(people.manager, "GET", "/me/approvals?status=pending")
      ).json()) as { items: OrgRequest[] }
    ).items;
    expect(request?.kind).toBe("raise");
    expect(request?.askedByAgent?.id).toBe(coder.id);
    await h.as(
      people.manager,
      "POST",
      `/me/approvals/${request?.id}/approve`,
      {},
    );
    const account = (await call(client, "get_my_account"))
      .structuredContent as { limits: { raisedToday: number } };
    expect(account.limits.raisedToday).toBe(5);
  });

  it("an agent nobody signs in for still reaches the admins", async () => {
    const h = harness();
    const lone = h.addAgent("lone");
    const client = await connect(h, lone.key);
    await call(client, "request_service", {
      service: "openai",
      daily_usd: 0.5,
      reason: "Second opinions.",
    });
    const [request] = h.org.listRequests();
    expect(request?.by).toBe(`agent:${lone.id}`);
    const admin = h.org.addPerson({
      email: "ada@example.com",
      name: "Ada",
      role: "admin",
      source: "admin",
    });
    const waiting = (await (
      await h.as(admin, "GET", "/me/approvals?status=pending")
    ).json()) as { items: OrgRequest[] };
    expect(waiting.items[0]?.id).toBe(request?.id);
  });
});
