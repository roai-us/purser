import { describe, expect, it } from "vitest";
import { openrouterPricingModel } from "./providers.js";
import { chatBody, harness, routerBody } from "./test/helpers.js";
import { OPENROUTER_COST, REAL_OPENROUTER_KEY } from "./test/mock-upstream.js";

const CHAT = "/openrouter/api/v1/chat/completions";

const post = (body: string, headers: Record<string, string> = {}) => ({
  method: "POST",
  body,
  headers,
});

describe("OpenRouter's own prices for estimates", () => {
  /** Makes one call so the model list loads, then hangs up on a stream. */
  async function cutOff(model: string) {
    const h = harness();
    const { id, key } = h.addAgent();
    await h.call(CHAT, { ...post(routerBody()), key });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const res = await h.call(CHAT, {
      ...post(routerBody({ stream: true, model }), { "x-mock-slow": "50" }),
      key,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel();
    const record = h.store.listUsage(id).at(-1);
    expect(record).toMatchObject({ outcome: "aborted", priced: "estimate" });
    return record as NonNullable<typeof record>;
  }

  /** The cost of a record's tokens at per-million rates. */
  const at = (
    r: { inputTokens: number; outputTokens: number },
    input: number,
    output: number,
  ) => (r.inputTokens * input + r.outputTokens * output) / 1_000_000;

  it("charges a model the table doesn't know at OpenRouter's price", async () => {
    const record = await cutOff("vendor/not-in-the-table");
    expect(record.costUsd).toBeCloseTo(at(record, 1, 2), 10);
  });

  it("charges a free model nothing", async () => {
    const record = await cutOff("vendor/not-in-the-table:free");
    expect(record.costUsd).toBe(0);
  });

  it("uses the base model's price for a variant it doesn't list", async () => {
    const record = await cutOff("vendor/not-in-the-table:nitro");
    expect(record.costUsd).toBeCloseTo(at(record, 1, 2), 10);
  });

  it("falls back to the table when the model isn't listed, or has no fixed price", async () => {
    for (const model of ["vendor/unlisted", "openrouter/auto"]) {
      const record = await cutOff(model);
      expect(record.costUsd).toBeCloseTo(at(record, 30, 180), 10);
    }
  });

  it("falls back to the table until the list has loaded, without making calls wait", async () => {
    const h = harness({
      fetch: (input, init) => {
        // The model list never answers.
        if (String(input).endsWith("/models")) {
          return new Promise<Response>(() => undefined);
        }
        const signal = init?.signal as AbortSignal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: "A long answer" } }] })}\n\n`,
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
    const res = await h.call(CHAT, {
      ...post(routerBody({ stream: true, model: "vendor/not-in-the-table" })),
      key,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel();
    const record = h.store.listUsage(id).at(-1);
    expect(record).toBeDefined();
    expect(record?.costUsd).toBeCloseTo(
      at(record as NonNullable<typeof record>, 30, 180),
      10,
    );
  });

  it("doesn't use OpenRouter's prices for another provider's model", async () => {
    const h = harness();
    const { id, key } = h.addAgent();
    await h.call(CHAT, { ...post(routerBody()), key });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const model = "vendor/not-in-the-table";
    const res = await h.call("/openai/v1/chat/completions", {
      ...post(chatBody({ stream: true, model }), { "x-mock-slow": "50" }),
      key,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel();
    const record = h.store.listUsage(id).at(-1);
    expect(record).toMatchObject({ provider: "openai", priced: "estimate" });
    expect(record?.costUsd).toBeCloseTo(
      at(record as NonNullable<typeof record>, 30, 180),
      10,
    );
  });

  it("still records OpenRouter's reported charge on a finished call", async () => {
    const h = harness();
    const { id, key } = h.addAgent();
    for (let i = 0; i < 2; i++) {
      await h.call(CHAT, {
        ...post(routerBody({ model: "vendor/not-in-the-table" })),
        key,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(h.store.listUsage(id).at(-1)).toMatchObject({
      costUsd: OPENROUTER_COST,
      priced: "provider",
    });
  });
});

describe("OpenRouter", () => {
  it("swaps in the real key and records the charge OpenRouter reports", async () => {
    const h = harness();
    const { id, key } = h.addAgent();
    const res = await h.call(CHAT, { ...post(routerBody()), key });
    expect(res.status).toBe(200);
    const seen = h.upstream.seen.at(-1);
    expect(seen?.path).toBe("/openrouter/api/v1/chat/completions");
    expect(seen?.headers.authorization).toBe(`Bearer ${REAL_OPENROUTER_KEY}`);
    expect(JSON.stringify(seen?.headers)).not.toContain(key);
    const [record] = h.store.listUsage(id);
    expect(record).toMatchObject({
      provider: "openrouter",
      endpoint: "chat.completions",
      model: "openai/gpt-4o-mini",
      inputTokens: 100,
      cacheReadTokens: 20,
      outputTokens: 30,
      costUsd: OPENROUTER_COST,
      priced: "provider",
      outcome: "complete",
    });
  });

  it("meters a stream from its final chunk without changing the request", async () => {
    const h = harness();
    const { id, key } = h.addAgent();
    const res = await h.call(CHAT, {
      ...post(routerBody({ stream: true })),
      key,
    });
    const text = await res.text();
    expect(text).toContain("Hello");
    expect(text).toContain("[DONE]");
    expect(h.upstream.seen.at(-1)?.body?.stream_options).toBeUndefined();
    expect(h.store.listUsage(id)[0]).toMatchObject({
      costUsd: OPENROUTER_COST,
      priced: "provider",
    });
  });

  it("meters the Responses API from the reported charge", async () => {
    const h = harness();
    const { id, key } = h.addAgent();
    await h.call("/openrouter/api/v1/responses", {
      ...post(routerBody()),
      key,
    });
    expect(h.store.listUsage(id)[0]).toMatchObject({
      inputTokens: 60,
      cacheReadTokens: 40,
      outputTokens: 50,
      costUsd: OPENROUTER_COST,
      priced: "provider",
    });
  });

  it("falls back to the price table, without the vendor prefix, when no charge is reported", async () => {
    const h = harness();
    const { id, key } = h.addAgent();
    await h.call(CHAT, {
      ...post(routerBody(), { "x-mock-no-cost": "1" }),
      key,
    });
    await h.call(CHAT, {
      ...post(routerBody({ model: "mystery/model-1" }), {
        "x-mock-no-cost": "1",
      }),
      key,
    });
    const [known, unknown] = h.store.listUsage(id);
    // gpt-4o-mini: 100 x $0.15 + 20 x $0.075 + 30 x $0.60, per million tokens
    expect(known).toMatchObject({ priced: "table" });
    expect(known?.costUsd).toBeCloseTo(34.5e-6, 12);
    expect(unknown).toMatchObject({ priced: "fallback" });
    expect(unknown?.costUsd).toBeCloseTo(9000e-6, 12);
  });

  it("enforces a model allowlist written with vendor-prefixed ids", async () => {
    const h = harness();
    const { key } = h.addAgent("router-bot", {
      models: ["openai/gpt-4o-mini"],
    });
    const ok = await h.call(CHAT, {
      ...post(routerBody({ model: "openai/gpt-4o-mini:nitro" })),
      key,
    });
    expect(ok.status).toBe(200);
    for (const model of ["anthropic/claude-opus-4.1", "gpt-4o-mini"]) {
      const res = await h.call(CHAT, { ...post(routerBody({ model })), key });
      expect(res.status, model).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { code: "model_not_allowed" },
      });
    }
  });

  it("proxies the model list but no per-model path, so nothing can walk elsewhere", async () => {
    const h = harness();
    const { key } = h.addAgent();
    const list = await h.call("/openrouter/api/v1/models", { key });
    expect(list.status).toBe(200);
    expect(h.upstream.seen).toHaveLength(1);
    for (const path of [
      "/openrouter/api/v1/models/openai/gpt-4o",
      "/openrouter/api/v1/models/%2e%2e",
      "/openrouter/api/v1/models/%2e%2e%2fkey",
      "/openrouter/api/v1/key",
      "/openrouter/api/v1/credits",
      "/openrouter/api/v1/keys",
    ]) {
      const res = await h.call(path, { key });
      expect(res.status, path).toBe(404);
    }
    expect(h.upstream.seen).toHaveLength(1);
  });

  it("cuts a running stream within a second of the kill", async () => {
    const h = harness();
    const { id, key } = h.addAgent();
    const res = await h.call(CHAT, {
      ...post(routerBody({ stream: true }), { "x-mock-slow": "100" }),
      key,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    const killed = performance.now();
    const kill = (await (
      await h.admin("POST", `/agents/${id}/kill`)
    ).json()) as { abortedRequests: number };
    expect(kill.abortedRequests).toBe(1);
    let error: unknown = null;
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch (err) {
      error = err;
    }
    expect(error).not.toBeNull();
    expect(performance.now() - killed).toBeLessThan(1000);
    expect(h.upstream.aborted).toContain("/openrouter/api/v1/chat/completions");
    const [record] = h.store.listUsage(id);
    expect(record).toMatchObject({ outcome: "aborted", priced: "estimate" });
    expect(record?.costUsd).toBeGreaterThan(0);
    const after = await h.call(CHAT, { ...post(routerBody()), key });
    expect(after.status).toBe(403);
  });

  it("returns 503 when no OpenRouter key is configured", async () => {
    const h = harness({ providerKeys: {} });
    const { key } = h.addAgent();
    const res = await h.call(CHAT, { ...post(routerBody()), key });
    expect(res.status).toBe(503);
  });
});

describe("OpenRouter model names in the price table", () => {
  it("drops the vendor and variant, and writes Anthropic version dots as dashes", () => {
    expect(openrouterPricingModel("openai/gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(openrouterPricingModel("openai/gpt-4.1:floor")).toBe("gpt-4.1");
    expect(openrouterPricingModel("anthropic/claude-sonnet-4.5")).toBe(
      "claude-sonnet-4-5",
    );
    expect(openrouterPricingModel("gpt-4o")).toBe("gpt-4o");
  });
});
