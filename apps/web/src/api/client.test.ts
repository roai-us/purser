import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  ApiError,
  queryString,
  sendTestRequest,
  UNAUTHORIZED_EVENT,
} from "./client";
import { makeConnector, mockFetch } from "../test/helpers";

afterEach(() => vi.unstubAllGlobals());

describe("api client", () => {
  it("sends the CSRF header on changes but not on reads", async () => {
    const { calls } = mockFetch({
      "GET /admin/overview": () => ({ ok: true }),
      "POST /admin/agents/agt_1/kill": () => ({
        agent: {},
        abortedRequests: 0,
        elapsedMs: 1,
      }),
    });
    await api.overview();
    await api.kill("agt_1");
    expect(calls[0]?.headers["x-purser-csrf"]).toBeUndefined();
    expect(calls[1]?.headers["x-purser-csrf"]).toBe("1");
  });

  it("builds agent queries without empty values", async () => {
    const { calls } = mockFetch({ "GET /admin/agents": () => ({ items: [] }) });
    await api.agents({ q: "news", state: "paused", page: 2, owner: "" });
    expect(calls[0]?.url).toBe("/admin/agents?q=news&state=paused&page=2");
    expect(queryString({})).toBe("");
  });

  it("encodes agent references and sends bodies", async () => {
    const { calls } = mockFetch({
      "POST /admin/agents/a%2Fb/rotate-key": () => ({ key: "k" }),
      "POST /admin/agents/bulk": () => ({ results: [], elapsedMs: 1 }),
      "PUT /admin/providers/azure/key": () => ({}),
    });
    await api.rotateKey("a/b", 60);
    await api.bulk("resume", ["1", "2"]);
    await api.saveProviderKey("azure", "sk", "https://x.example");
    expect(calls[0]?.body).toEqual({ graceMinutes: 60 });
    expect(calls[1]?.body).toEqual({ action: "resume", ids: ["1", "2"] });
    expect(calls[2]?.body).toEqual({
      apiKey: "sk",
      upstream: "https://x.example",
    });
  });

  it("turns server errors into readable errors", async () => {
    mockFetch({
      "POST /admin/agents": () => ({
        status: 409,
        body: {
          error: {
            code: "duplicate_name",
            message: "An agent with that name exists.",
          },
        },
      }),
    });
    const error = await api
      .createAgent({ name: "x", owner: "y" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).code).toBe("duplicate_name");
    expect((error as ApiError).message).toBe("An agent with that name exists.");
  });

  it("falls back to a generic message when the body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("oops", { status: 500 })),
    );
    const error = (await api.overview().catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe("http_500");
    expect(error.message).toMatch(/error 500/);
  });

  it("announces a lost session on 401 from the admin API", async () => {
    mockFetch({ "GET /admin/overview": () => ({ status: 401, body: {} }) });
    const heard = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, heard);
    await api.overview().catch(() => undefined);
    window.removeEventListener(UNAUTHORIZED_EVENT, heard);
    expect(heard).toHaveBeenCalledOnce();
  });

  it("explains when Purser is not running", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("fail"))),
    );
    const error = (await api.session().catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe("offline");
    expect(error.message).toMatch(/isn't responding/);
  });
});

describe("sendTestRequest", () => {
  it("calls chat completions with a bearer key on the same origin", async () => {
    const { calls } = mockFetch({
      "POST /openrouter/api/v1/chat/completions": () => ({
        model: "openai/gpt-4o-mini",
        usage: { cost: 0.00004 },
      }),
    });
    const result = await sendTestRequest(makeConnector(), "purser_abc");
    expect(calls[0]?.url).toBe("/openrouter/api/v1/chat/completions");
    expect(calls[0]?.headers.authorization).toBe("Bearer purser_abc");
    expect(calls[0]?.body).toMatchObject({
      model: "openai/gpt-4o-mini",
      max_tokens: 16,
    });
    expect(result).toEqual({
      ok: true,
      model: "openai/gpt-4o-mini",
      costUsd: 0.00004,
    });
  });

  it("uses the messages endpoint and x-api-key for Anthropic-style connectors", async () => {
    const { calls } = mockFetch({ "POST /anthropic/v1/messages": () => ({}) });
    const result = await sendTestRequest(
      makeConnector({
        kind: "anthropic",
        agentBaseUrl: "http://127.0.0.1:4141/anthropic",
        testModel: "claude-haiku-5-5",
      }),
      "purser_k",
    );
    expect(calls[0]?.headers["x-api-key"]).toBe("purser_k");
    expect(result).toEqual({ ok: true, model: "claude-haiku-5-5" });
  });

  it("reports the gateway's refusal", async () => {
    mockFetch({
      "POST /openrouter/api/v1/chat/completions": () => ({
        status: 403,
        body: { error: { message: "This agent is paused." } },
      }),
    });
    const result = await sendTestRequest(makeConnector(), "purser_abc");
    expect(result).toEqual({ ok: false, error: "This agent is paused." });
  });

  it("reports when Purser cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("fail"))),
    );
    const result = await sendTestRequest(makeConnector(), "purser_abc");
    expect(result.ok).toBe(false);
  });
});
