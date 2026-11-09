import { describe, expect, it } from "vitest";
import { chatBody, harness, messagesBody } from "./test/helpers.js";
import { REAL_ANTHROPIC_KEY, REAL_OPENAI_KEY } from "./test/mock-upstream.js";

const post = (body: string, headers: Record<string, string> = {}) => ({
  method: "POST",
  body,
  headers,
});

describe("authentication", () => {
  it("refuses a request with no key, in the provider's error shape", async () => {
    const h = harness();
    const res = await h.call("/openai/v1/chat/completions", post(chatBody()));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: {
        message: expect.any(String),
        type: "missing_key",
        code: "missing_key",
      },
    });
  });

  it("refuses an unknown key", async () => {
    const h = harness();
    const res = await h.call("/anthropic/v1/messages", {
      ...post(messagesBody()),
      key: "purser_nope",
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      type: "error",
      error: { type: "invalid_key", message: expect.any(String) },
    });
  });

  it("never forwards the agent key or the agent's own account headers upstream", async () => {
    const h = harness();
    const { key } = h.addAgent();
    const res = await h.call("/openai/v1/chat/completions", {
      ...post(chatBody(), {
        "openai-organization": "org_agent",
        cookie: "a=b",
        "x-trace": "keep",
      }),
      key,
    });
    expect(res.status).toBe(200);
    const seen = h.upstream.seen.at(-1);
    expect(seen?.headers.authorization).toBe(`Bearer ${REAL_OPENAI_KEY}`);
    expect(JSON.stringify(seen?.headers)).not.toContain(key);
    expect(seen?.headers["openai-organization"]).toBeUndefined();
    expect(seen?.headers.cookie).toBeUndefined();
    expect(seen?.headers["x-trace"]).toBe("keep");
    expect(res.headers.get("x-purser-agent")).toMatch(/^agt_/);
  });

  it("accepts an Anthropic agent key sent as a bearer token", async () => {
    const h = harness();
    const { key } = h.addAgent();
    const res = await h.app.request("/anthropic/v1/messages", {
      method: "POST",
      body: messagesBody(),
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
    expect(h.upstream.seen.at(-1)?.headers["x-api-key"]).toBe(
      REAL_ANTHROPIC_KEY,
    );
  });
});

describe("routing", () => {
  it("refuses endpoints Purser does not meter, so there is no side door", async () => {
    const h = harness();
    const { key } = h.addAgent();
    const res = await h.call("/openai/v1/images/generations", {
      ...post("{}"),
      key,
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("x-purser-denied")).toBe("endpoint_not_supported");
  });

  it("passes unmetered read endpoints through without recording spend", async () => {
    const h = harness();
    const { key } = h.addAgent();
    const res = await h.call("/openai/v1/models", { key });
    expect(res.status).toBe(200);
    const count = await h.call("/anthropic/v1/messages/count_tokens", {
      ...post(messagesBody()),
      key,
    });
    expect(await count.json()).toEqual({ input_tokens: 12 });
    expect(h.store.listUsage()).toHaveLength(0);
  });

  it("returns 503 when the provider has no key configured", async () => {
    const h = harness({ providerKeys: { openai: REAL_OPENAI_KEY } });
    const { key } = h.addAgent();
    const res = await h.call("/anthropic/v1/messages", {
      ...post(messagesBody()),
      key,
    });
    expect(res.status).toBe(503);
  });

  it("rejects a body that is not a JSON object", async () => {
    const h = harness();
    const { key } = h.addAgent();
    expect(
      (
        await h.call("/openai/v1/chat/completions", {
          ...post("not json"),
          key,
        })
      ).status,
    ).toBe(400);
    expect(
      (await h.call("/openai/v1/chat/completions", { ...post("[1,2]"), key }))
        .status,
    ).toBe(400);
  });

  it("returns 502 when the provider cannot be reached", async () => {
    const h = harness({
      fetch: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    const { key } = h.addAgent();
    const res = await h.call("/openai/v1/chat/completions", {
      ...post(chatBody()),
      key,
    });
    expect(res.status).toBe(502);
  });

  it("will not let a model id walk to another endpoint", async () => {
    const h = harness();
    const { key } = h.addAgent();
    for (const path of [
      "/openai/v1/models/%2e%2e",
      "/openai/v1/models/%2e%2e%2ffiles",
      "/openai/v1/models/..",
      "/anthropic/v1/models/a%2fb",
    ]) {
      const res = await h.call(path, { key });
      expect(res.status, path).toBe(404);
    }
    expect(h.upstream.seen).toHaveLength(0);
    // A real fine-tuned model id still goes through.
    await h.call("/openai/v1/models/ft:gpt-4o-mini:acme:v1.2", { key });
    expect(h.upstream.seen.at(-1)?.path).toBe(
      "/openai/v1/models/ft:gpt-4o-mini:acme:v1.2",
    );
  });

  it("keeps the query string", async () => {
    const h = harness();
    const { key } = h.addAgent();
    await h.call("/openai/v1/models?limit=2", { key });
    expect(h.upstream.seen.at(-1)?.path).toBe("/openai/v1/models");
  });
});

describe("metering", () => {
  it("prices an OpenAI chat completion, splitting cached input", async () => {
    const h = harness();
    const { id, key } = h.addAgent();
    const res = await h.call("/openai/v1/chat/completions", {
      ...post(chatBody()),
      key,
    });
    expect(res.status).toBe(200);
    const [record] = h.store.listUsage(id);
    expect(record).toMatchObject({
      provider: "openai",
      endpoint: "chat.completions",
      model: "gpt-4o-mini",
      inputTokens: 100,
      cacheReadTokens: 20,
      outputTokens: 30,
      priced: "table",
      outcome: "complete",
    });
    // 100 x $0.15 + 20 x $0.075 + 30 x $0.60, per million tokens
    expect(record?.costUsd).toBeCloseTo(34.5e-6, 12);
  });

  it("asks for usage on streamed chat completions and meters them", async () => {
    const h = harness();
    const { id, key } = h.addAgent();
    const res = await h.call("/openai/v1/chat/completions", {
      ...post(chatBody({ stream: true })),
      key,
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("Hello");
    expect(text).toContain("[DONE]");
    expect(h.upstream.seen.at(-1)?.body?.stream_options).toEqual({
      include_usage: true,
    });
    expect(h.store.listUsage(id)[0]?.costUsd).toBeCloseTo(34.5e-6, 12);
  });

  it("keeps the agent's own stream options when adding include_usage", async () => {
    const h = harness();
    const { key } = h.addAgent();
    await (
      await h.call("/openai/v1/chat/completions", {
        ...post(chatBody({ stream: true, stream_options: { other: 1 } })),
        key,
      })
    ).text();
    expect(h.upstream.seen.at(-1)?.body?.stream_options).toEqual({
      other: 1,
      include_usage: true,
    });
  });

  it("meters the Responses API, streamed and not", async () => {
    const h = harness();
    const { id, key } = h.addAgent();
    await h.call("/openai/v1/responses", { ...post(chatBody()), key });
    await (
      await h.call("/openai/v1/responses", {
        ...post(chatBody({ stream: true })),
        key,
      })
    ).text();
    const records = h.store.listUsage(id);
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record).toMatchObject({
        inputTokens: 60,
        cacheReadTokens: 40,
        outputTokens: 50,
      });
      expect(record.costUsd).toBeCloseTo(42e-6, 12);
    }
  });

  it("meters embeddings", async () => {
    const h = harness();
    const { id, key } = h.addAgent();
    await h.call("/openai/v1/embeddings", {
      ...post(JSON.stringify({ model: "text-embedding-3-small", input: "hi" })),
      key,
    });
    expect(h.store.listUsage(id)[0]?.costUsd).toBeCloseTo(0.16e-6, 14);
  });

  it("prices an Anthropic message, with cache reads and both cache write lifetimes", async () => {
    const h = harness();
    const { id, key } = h.addAgent();
    const res = await h.call("/anthropic/v1/messages", {
      ...post(messagesBody()),
      key,
    });
    expect(res.status).toBe(200);
    const [record] = h.store.listUsage(id);
    expect(record).toMatchObject({
      inputTokens: 200,
      outputTokens: 40,
      cacheReadTokens: 1000,
      cacheWrite5mTokens: 100,
      cacheWrite1hTokens: 50,
    });
    // 200x3 + 40x15 + 1000x0.30 + 100x3.75 + 50x6, per million tokens
    expect(record?.costUsd).toBeCloseTo(2175e-6, 12);
  });

  it("meters a streamed Anthropic message from message_start and message_delta", async () => {
    const h = harness();
    const { id, key } = h.addAgent();
    const res = await h.call("/anthropic/v1/messages", {
      ...post(messagesBody({ stream: true })),
      key,
    });
    const text = await res.text();
    expect(text).toContain("message_stop");
    const [record] = h.store.listUsage(id);
    expect(record).toMatchObject({
      inputTokens: 200,
      outputTokens: 40,
      cacheReadTokens: 1000,
    });
    expect(record?.costUsd).toBeCloseTo(1500e-6, 12);
  });

  it("charges an unknown model at the fallback rate and says so", async () => {
    const h = harness();
    const { id, key } = h.addAgent();
    await h.call("/openai/v1/chat/completions", {
      ...post(chatBody({ model: "mystery-1" })),
      key,
    });
    const [record] = h.store.listUsage(id);
    expect(record?.priced).toBe("fallback");
    // (100 + 20) x $30 + 30 x $180: the fallback has no cache discount
    expect(record?.costUsd).toBeCloseTo(9000e-6, 12);
  });

  it("records upstream errors with their status", async () => {
    const h = harness();
    const { id, key } = h.addAgent();
    const bad = harness({
      providerKeys: { openai: "sk-wrong", anthropic: REAL_ANTHROPIC_KEY },
    });
    const agent = bad.addAgent();
    const res = await bad.call("/openai/v1/chat/completions", {
      ...post(chatBody()),
      key: agent.key,
    });
    expect(res.status).toBe(401);
    expect(bad.store.listUsage(agent.id)[0]).toMatchObject({
      status: 401,
      outcome: "error",
      costUsd: 0,
    });
    expect(h.store.listUsage(id)).toHaveLength(0);
    expect(key).toBeDefined();
  });

  it("passes a non-JSON upstream body through, charging an estimate", async () => {
    const h = harness({
      fetch: () =>
        Promise.resolve(
          new Response("plain text", {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
        ),
    });
    const { id, key } = h.addAgent();
    const res = await h.call("/openai/v1/chat/completions", {
      ...post(chatBody()),
      key,
    });
    expect(await res.text()).toBe("plain text");
    const [record] = h.store.listUsage(id);
    expect(record).toMatchObject({ priced: "estimate", model: "gpt-4o-mini" });
    expect(record?.costUsd).toBeGreaterThan(0);
  });
});

describe("limits", () => {
  it("stops an agent at its daily cap and audits the refusal", async () => {
    const h = harness();
    const { id, key } = h.addAgent("capped", { dailyUsd: 0.002 });
    const first = await h.call("/anthropic/v1/messages", {
      ...post(messagesBody()),
      key,
    });
    expect(first.status).toBe(200);
    const second = await h.call("/anthropic/v1/messages", {
      ...post(messagesBody()),
      key,
    });
    expect(second.status).toBe(403);
    expect(second.headers.get("x-purser-denied")).toBe("budget_exceeded");
    expect(
      ((await second.json()) as { error: { message: string } }).error.message,
    ).toContain("daily cap of $0.0020");
    expect(h.store.listAudit().at(-1)).toMatchObject({
      type: "request.denied",
      agentId: id,
    });
  });

  it("resets the daily cap at midnight UTC but keeps the monthly one", async () => {
    const h = harness();
    const { key } = h.addAgent("capped", {
      dailyUsd: 0.002,
      monthlyUsd: 0.004,
    });
    await h.call("/anthropic/v1/messages", { ...post(messagesBody()), key });
    h.clock.now = new Date("2026-11-08T00:00:01Z");
    expect(
      (await h.call("/anthropic/v1/messages", { ...post(messagesBody()), key }))
        .status,
    ).toBe(200);
    h.clock.now = new Date("2026-11-09T00:00:01Z");
    const res = await h.call("/anthropic/v1/messages", {
      ...post(messagesBody()),
      key,
    });
    expect(res.status).toBe(403);
    expect(
      ((await res.json()) as { error: { message: string } }).error.message,
    ).toContain("monthly cap");
  });

  it("enforces the model allowlist, including dated versions", async () => {
    const h = harness();
    const { key } = h.addAgent("picky", { models: ["gpt-4o-mini"] });
    expect(
      (
        await h.call("/openai/v1/chat/completions", {
          ...post(chatBody({ model: "gpt-4o-mini-2024-07-18" })),
          key,
        })
      ).status,
    ).toBe(200);
    const res = await h.call("/openai/v1/chat/completions", {
      ...post(chatBody({ model: "gpt-4o" })),
      key,
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("x-purser-denied")).toBe("model_not_allowed");
    const none = await h.call("/openai/v1/chat/completions", {
      ...post(JSON.stringify({ messages: [] })),
      key,
    });
    expect(none.status).toBe(403);
  });

  it("refuses an agent past its end date", async () => {
    const h = harness();
    const { key } = h.addAgent("temp", {}, { endsAt: "2026-11-01T00:00:00Z" });
    const res = await h.call("/openai/v1/chat/completions", {
      ...post(chatBody()),
      key,
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("x-purser-denied")).toBe("agent_expired");
  });
});

describe("kill switch", () => {
  it("refuses a paused agent", async () => {
    const h = harness();
    const { id, key } = h.addAgent();
    await h.admin("POST", `/agents/${id}/kill`);
    const res = await h.call("/openai/v1/chat/completions", {
      ...post(chatBody()),
      key,
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("x-purser-denied")).toBe("agent_paused");
  });

  for (const [provider, path, body] of [
    ["openai", "/openai/v1/chat/completions", chatBody({ stream: true })],
    ["anthropic", "/anthropic/v1/messages", messagesBody({ stream: true })],
  ] as const) {
    it(`cuts a running ${provider} stream within a second of the kill`, async () => {
      const h = harness();
      const { id, key } = h.addAgent();
      const res = await h.call(path, {
        ...post(body, { "x-mock-slow": "100" }),
        key,
      });
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      expect(h.inflight.count(id)).toBe(1);

      const killed = performance.now();
      const kill = (await (
        await h.admin("POST", `/agents/${id}/kill`)
      ).json()) as { abortedRequests: number };
      expect(kill.abortedRequests).toBe(1);

      // Drain until the stream ends with an error.
      let error: unknown = null;
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch (err) {
        error = err;
      }
      const elapsed = performance.now() - killed;
      expect(error).not.toBeNull();
      expect(elapsed).toBeLessThan(1000);
      expect(h.inflight.count(id)).toBe(0);
      expect(h.upstream.aborted).toContain(path);
      expect(h.store.listUsage(id)[0]?.outcome).toBe("aborted");

      const after = await h.call(path, { ...post(body), key });
      expect(after.status).toBe(403);
    });
  }

  it("cuts a slow non-streaming request and tells the agent why", async () => {
    const h = harness();
    const { id, key } = h.addAgent();
    const pending = h.call("/openai/v1/chat/completions", {
      ...post(chatBody(), { "x-mock-slow": "5000" }),
      key,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await h.admin("POST", `/agents/${id}/kill`);
    const res = await pending;
    expect(res.status).toBe(403);
    expect(res.headers.get("x-purser-denied")).toBe("agent_paused");
  });

  it("cuts a request whose response body is cut off mid-read", async () => {
    const h = harness({
      fetch: (_input, init) => {
        const signal = init?.signal as AbortSignal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            signal.addEventListener("abort", () =>
              controller.error(new Error("aborted")),
            );
          },
        });
        return Promise.resolve(
          new Response(body, {
            headers: { "content-type": "application/json" },
          }),
        );
      },
    });
    const { id, key } = h.addAgent();
    const pending = h.call("/openai/v1/chat/completions", {
      ...post(chatBody()),
      key,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await h.admin("POST", `/agents/${id}/kill`);
    expect((await pending).status).toBe(403);
    const [record] = h.store.listUsage(id);
    expect(record).toMatchObject({ outcome: "aborted", priced: "estimate" });
    expect(record?.inputTokens).toBeGreaterThan(0);
    expect(record?.costUsd).toBeGreaterThan(0);
  });

  it("reports a body that fails without a kill as an upstream error", async () => {
    const h = harness({
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream({ start: (c) => c.error(new Error("reset")) }),
            { headers: { "content-type": "application/json" } },
          ),
        ),
    });
    const { key } = h.addAgent();
    const res = await h.call("/openai/v1/chat/completions", {
      ...post(chatBody()),
      key,
    });
    expect(res.status).toBe(502);
  });

  it("records a stream that breaks upstream as an error", async () => {
    const encoder = new TextEncoder();
    const h = harness({
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(encoder.encode('data: {"model":"gpt-4o-mini"}\n\n'));
              },
              pull(c) {
                c.error(new Error("reset"));
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
    });
    const { id, key } = h.addAgent();
    const res = await h.call("/openai/v1/chat/completions", {
      ...post(chatBody({ stream: true })),
      key,
    });
    await expect(res.text()).rejects.toThrow();
    expect(h.store.listUsage(id)[0]?.outcome).toBe("error");
  });

  it("stops paying for a stream when the agent disconnects", async () => {
    const h = harness();
    const { id, key } = h.addAgent();
    const res = await h.call("/anthropic/v1/messages", {
      ...post(messagesBody({ stream: true }), { "x-mock-slow": "50" }),
      key,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel();
    expect(h.inflight.count(id)).toBe(0);
    expect(h.store.listUsage(id)[0]).toMatchObject({
      outcome: "aborted",
      inputTokens: 200,
      priced: "estimate",
    });
    expect(h.store.listUsage(id)[0]?.outputTokens).toBeGreaterThan(0);
  });

  /** Starts a slow stream, reads its first chunk and hangs up. */
  async function hangUp(
    h: ReturnType<typeof harness>,
    key: string,
    path = "/openai/v1/chat/completions",
    body = chatBody({ stream: true }),
  ): Promise<void> {
    const res = await h.call(path, {
      ...post(body, { "x-mock-slow": "50" }),
      key,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel();
  }

  it("charges a stream the agent hangs up on before its usage arrives", async () => {
    const h = harness();
    const { id, key } = h.addAgent();
    await hangUp(h, key);
    const [record] = h.store.listUsage(id);
    expect(record).toMatchObject({ outcome: "aborted", priced: "estimate" });
    expect(record?.inputTokens).toBeGreaterThan(0);
    expect(record?.outputTokens).toBeGreaterThan(0);
    expect(record?.costUsd).toBeGreaterThan(0);
  });

  it("charges the Responses API when the agent hangs up", async () => {
    const h = harness({
      fetch: (_input, init) => {
        const signal = init?.signal as AbortSignal;
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "A long answer", model: "gpt-4o-mini" })}\n\n`,
              ),
            );
            signal.addEventListener("abort", () =>
              controller.error(new Error("aborted")),
            );
          },
        });
        return Promise.resolve(
          new Response(body, {
            headers: { "content-type": "text/event-stream" },
          }),
        );
      },
    });
    const { id, key } = h.addAgent();
    await hangUp(h, key, "/openai/v1/responses");
    expect(h.store.listUsage(id)[0]).toMatchObject({
      endpoint: "responses",
      outcome: "aborted",
      priced: "estimate",
      // 13 characters at 3 to a token.
      outputTokens: 5,
    });
  });

  it("stops an agent at its cap when it keeps hanging up", async () => {
    const h = harness();
    const { key } = h.addAgent("hangs-up", { dailyUsd: 0.000001 });
    await hangUp(h, key);
    const next = await h.call("/openai/v1/chat/completions", {
      ...post(chatBody()),
      key,
    });
    expect(next.status).toBe(403);
    expect(next.headers.get("x-purser-denied")).toBe("budget_exceeded");
  });

  it("keeps the provider's figures when its usage came before the cut", async () => {
    const usage = { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 };
    const h = harness({
      fetch: (_input, init) => {
        const signal = init?.signal as AbortSignal;
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ model: "gpt-4o-mini", choices: [{ delta: { content: "x".repeat(300) } }], usage })}\n\n`,
              ),
            );
            signal.addEventListener("abort", () =>
              controller.error(new Error("aborted")),
            );
          },
        });
        return Promise.resolve(
          new Response(body, {
            headers: { "content-type": "text/event-stream" },
          }),
        );
      },
    });
    const { id, key } = h.addAgent();
    await hangUp(h, key);
    expect(h.store.listUsage(id)[0]).toMatchObject({
      outcome: "aborted",
      priced: "table",
      inputTokens: 7,
      outputTokens: 9,
    });
  });

  it("doesn't charge a stream the provider refused", async () => {
    const h = harness({
      fetch: () => {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("data: {}\n\n"));
            controller.error(new Error("broken"));
          },
        });
        return Promise.resolve(
          new Response(body, {
            status: 500,
            headers: { "content-type": "text/event-stream" },
          }),
        );
      },
    });
    const { id, key } = h.addAgent();
    const res = await h.call("/openai/v1/chat/completions", {
      ...post(chatBody({ stream: true })),
      key,
    });
    await res.text().catch(() => "");
    expect(h.store.listUsage(id)[0]?.costUsd).toBe(0);
  });
});
