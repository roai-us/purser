import { Hono } from "hono";

export const REAL_OPENAI_KEY = "sk-real-openai";
export const REAL_ANTHROPIC_KEY = "sk-ant-real";
export const REAL_OPENROUTER_KEY = "sk-or-real";
/** A key that may manage OpenRouter keys and make no calls. */
export const OPENROUTER_MANAGEMENT_KEY = "sk-or-mgmt-real";

/** A key the mock OpenRouter made through its key API. */
export interface MockOpenRouterKey {
  hash: string;
  key: string;
  name: string;
  limit: number | null;
  limit_reset: string | null;
  expires_at?: string | undefined;
  disabled: boolean;
  usage: number;
}
/** The charge the mock OpenRouter reports for every metered call. */
export const OPENROUTER_COST = 0.00042;

export interface SeenRequest {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A stand-in for the OpenAI and Anthropic APIs. It checks that Purser sent
 * the real provider key, and answers with fixed usage so costs are exact.
 *
 * Header `x-mock-slow: <ms>` makes a stream emit 100 chunks that far apart,
 * and a JSON response wait that long, so tests can kill mid-request.
 * Header `x-mock-no-cost: 1` makes the mock OpenRouter leave out `usage.cost`.
 */
export function mockUpstream() {
  const seen: SeenRequest[] = [];
  const aborted: string[] = [];
  const app = new Hono();
  /** OpenRouter's keys, by hash, and statuses to answer the next key API calls with. */
  const orKeys = new Map<string, MockOpenRouterKey>();
  const orKeyReplies: number[] = [];
  let orKeySeq = 0;

  app.use("*", async (c, next) => {
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => (headers[k] = v));
    let body: Record<string, unknown> | null = null;
    if (c.req.method === "POST") {
      body = (await c.req.raw.clone().json()) as Record<string, unknown>;
    }
    seen.push({ path: c.req.path, headers, body });
    await next();
  });

  app.use("/openai/*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${REAL_OPENAI_KEY}`) {
      return c.json({ error: { message: "bad key" } }, 401);
    }
    await next();
  });

  app.use("/anthropic/*", async (c, next) => {
    if (c.req.header("x-api-key") !== REAL_ANTHROPIC_KEY) {
      return c.json(
        {
          type: "error",
          error: { type: "authentication_error", message: "bad key" },
        },
        401,
      );
    }
    await next();
  });

  app.use("/openrouter/*", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    if (c.req.path.startsWith("/openrouter/api/v1/keys")) {
      if (auth === `Bearer ${OPENROUTER_MANAGEMENT_KEY}`) {
        const reply = orKeyReplies.shift();
        if (reply !== undefined) {
          return c.json(
            { error: { message: "mock failure", code: reply } },
            reply as 400,
          );
        }
        return next();
      }
      const known =
        auth === `Bearer ${REAL_OPENROUTER_KEY}` ||
        [...orKeys.values()].some((k) => auth === `Bearer ${k.key}`);
      return known
        ? c.json(
            {
              error: {
                message: "Only management keys can perform this operation",
                code: 403,
              },
            },
            403,
          )
        : c.json(
            { error: { message: "Invalid management key", code: 401 } },
            401,
          );
    }
    if (auth === `Bearer ${OPENROUTER_MANAGEMENT_KEY}`) {
      return c.json(
        { error: { message: "Management keys cannot make calls", code: 401 } },
        401,
      );
    }
    const own = [...orKeys.values()].find((k) => auth === `Bearer ${k.key}`);
    if (!own && auth !== `Bearer ${REAL_OPENROUTER_KEY}`) {
      return c.json({ error: { message: "bad key", code: 401 } }, 401);
    }
    if (own?.disabled) {
      return c.json({ error: { message: "Key disabled", code: 401 } }, 401);
    }
    if (own && own.limit !== null && own.usage >= own.limit) {
      return c.json(
        {
          error: {
            message: "Key limit exceeded",
            code: 402,
            metadata: { limit_source: "openrouter_key_limit" },
          },
        },
        402,
      );
    }
    await next();
    if (
      own &&
      c.res.ok &&
      /\/(chat\/completions|responses)$/.test(c.req.path)
    ) {
      own.usage += OPENROUTER_COST;
    }
  });

  const keyJson = (k: MockOpenRouterKey) => ({
    hash: k.hash,
    name: k.name,
    label: `sk-or-v1-${k.key.slice(-4)}`,
    disabled: k.disabled,
    limit: k.limit,
    limit_reset: k.limit_reset,
    limit_remaining: k.limit === null ? null : k.limit - k.usage,
    usage: k.usage,
    usage_daily: k.usage,
    usage_weekly: k.usage,
    usage_monthly: k.usage,
    expires_at: k.expires_at ?? null,
  });

  app.get("/openrouter/api/v1/keys", (c) => {
    const offset = Number(c.req.query("offset") ?? 0);
    const withDisabled = c.req.query("include_disabled") === "true";
    const all = [...orKeys.values()].filter((k) => withDisabled || !k.disabled);
    return c.json({ data: all.slice(offset, offset + 100).map(keyJson) });
  });

  app.post("/openrouter/api/v1/keys", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    if (
      typeof body.expires_at === "string" &&
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(body.expires_at)
    ) {
      return c.json({ error: { message: "bad expires_at", code: 400 } }, 400);
    }
    orKeySeq += 1;
    const k: MockOpenRouterKey = {
      hash: `hash${orKeySeq}`,
      key: `sk-or-v1-agent${orKeySeq}xyz${orKeySeq}`,
      name: String(body.name),
      limit: typeof body.limit === "number" ? body.limit : null,
      limit_reset:
        typeof body.limit_reset === "string" ? body.limit_reset : null,
      expires_at:
        typeof body.expires_at === "string" ? body.expires_at : undefined,
      disabled: false,
      usage: 0,
    };
    orKeys.set(k.hash, k);
    return c.json({ data: keyJson(k), key: k.key }, 201);
  });

  app.patch("/openrouter/api/v1/keys/:hash", async (c) => {
    const k = orKeys.get(c.req.param("hash"));
    if (!k) return c.json({ error: { message: "Not found", code: 404 } }, 404);
    const body = (await c.req.json()) as Record<string, unknown>;
    if ("limit" in body) k.limit = body.limit as number | null;
    if ("limit_reset" in body)
      k.limit_reset = body.limit_reset as string | null;
    if ("disabled" in body) k.disabled = body.disabled === true;
    return c.json({ data: keyJson(k) });
  });

  app.delete("/openrouter/api/v1/keys/:hash", (c) => {
    if (!orKeys.delete(c.req.param("hash"))) {
      return c.json({ error: { message: "Not found", code: 404 } }, 404);
    }
    return c.json({ deleted: true });
  });

  const slowMs = (c: { req: { header: (n: string) => string | undefined } }) =>
    Number(c.req.header("x-mock-slow") ?? 0);

  function sse(
    signal: AbortSignal,
    path: string,
    events: { event?: string; data: unknown }[],
    delayMs: number,
  ): Response {
    const encoder = new TextEncoder();
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (delayMs > 0 && i > 0) await sleep(delayMs);
        if (signal.aborted) return;
        const next = events[i++];
        if (!next) {
          controller.close();
          return;
        }
        const data =
          typeof next.data === "string" ? next.data : JSON.stringify(next.data);
        controller.enqueue(
          encoder.encode(
            `${next.event ? `event: ${next.event}\n` : ""}data: ${data}\n\n`,
          ),
        );
      },
      cancel() {
        aborted.push(path);
      },
    });
    signal.addEventListener("abort", () => aborted.push(path), { once: true });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "x-request-id": "req_mock",
      },
    });
  }

  app.post("/openai/v1/chat/completions", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const model = String(body.model);
    const usage = {
      prompt_tokens: 120,
      completion_tokens: 30,
      prompt_tokens_details: { cached_tokens: 20 },
    };
    const delay = slowMs(c);
    if (body.stream === true) {
      const chunk = (content: string) => ({
        id: "chatcmpl_mock",
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      });
      const count = delay > 0 ? 100 : 2;
      const events: { data: unknown }[] = Array.from(
        { length: count },
        (_, n) => ({
          data: chunk(n === 0 ? "Hello" : " world"),
        }),
      );
      const options = body.stream_options as
        { include_usage?: boolean } | undefined;
      if (options?.include_usage) {
        events.push({
          data: {
            id: "chatcmpl_mock",
            object: "chat.completion.chunk",
            created: 1,
            model,
            choices: [],
            usage,
          },
        });
      }
      events.push({ data: "[DONE]" });
      return sse(c.req.raw.signal, c.req.path, events, delay);
    }
    if (delay > 0) await sleep(delay);
    return c.json({
      id: "chatcmpl_mock",
      object: "chat.completion",
      created: 1,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello world" },
          finish_reason: "stop",
        },
      ],
      usage,
    });
  });

  app.post("/openai/v1/responses", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const model = String(body.model);
    const usage = {
      input_tokens: 100,
      output_tokens: 50,
      input_tokens_details: { cached_tokens: 40 },
    };
    const response = {
      id: "resp_mock",
      object: "response",
      model,
      status: "completed",
      output: [],
      usage,
    };
    if (body.stream === true) {
      return sse(
        c.req.raw.signal,
        c.req.path,
        [
          {
            event: "response.created",
            data: {
              type: "response.created",
              response: { ...response, status: "in_progress", usage: null },
            },
          },
          {
            event: "response.completed",
            data: { type: "response.completed", response },
          },
        ],
        0,
      );
    }
    return c.json(response);
  });

  app.post("/openai/v1/embeddings", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    return c.json({
      object: "list",
      model: body.model,
      data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
      usage: { prompt_tokens: 8, total_tokens: 8 },
    });
  });

  app.post("/openai/v1/fail", (c) =>
    c.json({ error: { message: "nope" } }, 500),
  );

  app.get("/openai/v1/models", (c) =>
    c.json({ object: "list", data: [{ id: "gpt-4o-mini", object: "model" }] }),
  );

  app.post("/anthropic/v1/messages", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const model = String(body.model);
    const delay = slowMs(c);
    if (body.stream === true) {
      const deltas = Array.from({ length: delay > 0 ? 100 : 2 }, (_, n) => ({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: n === 0 ? "Hello" : " world" },
        },
      }));
      return sse(
        c.req.raw.signal,
        c.req.path,
        [
          {
            event: "message_start",
            data: {
              type: "message_start",
              message: {
                id: "msg_mock",
                type: "message",
                role: "assistant",
                model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                  input_tokens: 200,
                  output_tokens: 1,
                  cache_read_input_tokens: 1000,
                  cache_creation_input_tokens: 0,
                },
              },
            },
          },
          {
            event: "content_block_start",
            data: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
          },
          ...deltas,
          {
            event: "content_block_stop",
            data: { type: "content_block_stop", index: 0 },
          },
          {
            event: "message_delta",
            data: {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 40 },
            },
          },
          { event: "message_stop", data: { type: "message_stop" } },
        ],
        delay,
      );
    }
    if (delay > 0) await sleep(delay);
    return c.json({
      id: "msg_mock",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: "Hello world" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 200,
        output_tokens: 40,
        cache_read_input_tokens: 1000,
        cache_creation: {
          ephemeral_5m_input_tokens: 100,
          ephemeral_1h_input_tokens: 50,
        },
      },
    });
  });

  app.post("/anthropic/v1/messages/count_tokens", (c) =>
    c.json({ input_tokens: 12 }),
  );

  app.post("/openrouter/api/v1/chat/completions", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const model = String(body.model);
    const usage: Record<string, unknown> = {
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 20 },
    };
    if (c.req.header("x-mock-no-cost") !== "1") usage.cost = OPENROUTER_COST;
    const delay = slowMs(c);
    if (body.stream === true) {
      const chunk = (content: string) => ({
        id: "gen_mock",
        object: "chat.completion.chunk",
        created: 1,
        model,
        provider: "Mock",
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      });
      const events: { data: unknown }[] = Array.from(
        { length: delay > 0 ? 100 : 2 },
        (_, n) => ({ data: chunk(n === 0 ? "Hello" : " world") }),
      );
      // OpenRouter always sends usage in the final chunk, unasked.
      events.push({ data: { ...chunk(""), choices: [], usage } });
      events.push({ data: "[DONE]" });
      return sse(c.req.raw.signal, c.req.path, events, delay);
    }
    if (delay > 0) await sleep(delay);
    return c.json({
      id: "gen_mock",
      object: "chat.completion",
      created: 1,
      model,
      provider: "Mock",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello world" },
          finish_reason: "stop",
        },
      ],
      usage,
    });
  });

  app.post("/openrouter/api/v1/responses", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    return c.json({
      id: "resp_mock",
      object: "response",
      model: String(body.model),
      status: "completed",
      output: [],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 40 },
        cost: OPENROUTER_COST,
      },
    });
  });

  app.get("/openrouter/api/v1/key", (c) =>
    c.req.header("authorization") === `Bearer ${REAL_OPENROUTER_KEY}`
      ? c.json({ data: { label: "mock" } })
      : c.json({ error: { message: "No auth credentials found" } }, 401),
  );

  app.get("/openrouter/api/v1/models", (c) =>
    c.json({
      data: [
        {
          id: "openai/gpt-4o-mini",
          name: "GPT-4o mini",
          pricing: { prompt: "0.00000015", completion: "0.0000006" },
        },
        {
          id: "vendor/not-in-the-table",
          pricing: { prompt: "0.000001", completion: "0.000002" },
        },
        {
          id: "vendor/not-in-the-table:free",
          pricing: { prompt: "0", completion: "0" },
        },
        {
          id: "openrouter/auto",
          pricing: { prompt: "-1", completion: "-1" },
        },
      ],
    }),
  );

  return { app, seen, aborted, orKeys, orKeyReplies };
}
