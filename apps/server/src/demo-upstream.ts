/**
 * The provider key the demo data uses for every connector. Calls made with it
 * are answered right here and never leave this computer, so the demo works
 * end to end with no provider account and no charges. A real key, pasted in
 * over it, goes to the real provider as usual.
 */
export const DEMO_PROVIDER_KEY = "demo-key-not-a-real-provider-key";

/** Any key like this stays on this computer, so the demo can show a key being replaced. */
const isDemoKey = (key: string | null): boolean =>
  key?.startsWith("demo-") === true;

const DEMO_NOTE =
  "[Demo reply. No real model was called, so no provider charged anything.]";

const MODELS: Record<string, string[]> = {
  "api.openai.com": ["gpt-4o", "gpt-4o-mini"],
  "api.anthropic.com": ["claude-sonnet-5-5", "claude-haiku-5-5"],
  "openrouter.ai": ["openai/gpt-4o-mini", "anthropic/claude-haiku-5-5"],
};

const tokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));

function lastUserText(body: Record<string, unknown>): string {
  if (typeof body.input === "string") return body.input;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last = messages[messages.length - 1] as
    { content?: unknown } | undefined;
  return typeof last?.content === "string" ? last.content : "";
}

const replyTo = (prompt: string, model: string) => {
  const quoted = prompt.length > 200 ? `${prompt.slice(0, 200)}...` : prompt;
  return `${DEMO_NOTE} ${model} would answer this here: "${quoted}"`;
};

function sse(events: unknown[]): Response {
  const text = events
    .map((e) =>
      typeof e === "string"
        ? `data: ${e}\n\n`
        : `data: ${JSON.stringify(e)}\n\n`,
    )
    .join("");
  return new Response(text, {
    headers: { "content-type": "text/event-stream" },
  });
}

function chat(body: Record<string, unknown>, cost: number | null): Response {
  const model = typeof body.model === "string" ? body.model : "demo-model";
  const prompt = lastUserText(body);
  const reply = replyTo(prompt, model);
  const usage = {
    prompt_tokens: tokens(prompt),
    completion_tokens: tokens(reply),
    total_tokens: tokens(prompt) + tokens(reply),
    ...(cost === null ? {} : { cost }),
  };
  if (body.stream === true) {
    const chunk = (choices: unknown[], extra = {}) => ({
      id: "chatcmpl-demo",
      object: "chat.completion.chunk",
      model,
      choices,
      ...extra,
    });
    return sse([
      chunk([{ index: 0, delta: { role: "assistant", content: reply } }]),
      chunk([{ index: 0, delta: {}, finish_reason: "stop" }]),
      chunk([], { usage }),
      "[DONE]",
    ]);
  }
  return Response.json({
    id: "chatcmpl-demo",
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: reply },
        finish_reason: "stop",
      },
    ],
    usage,
  });
}

function messages(body: Record<string, unknown>): Response {
  const model = typeof body.model === "string" ? body.model : "demo-model";
  const prompt = lastUserText(body);
  const reply = replyTo(prompt, model);
  const usage = {
    input_tokens: tokens(prompt),
    output_tokens: tokens(reply),
  };
  const message = {
    id: "msg_demo",
    type: "message",
    role: "assistant",
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
  };
  if (body.stream === true) {
    const events = [
      {
        type: "message_start",
        message: {
          ...message,
          content: [],
          stop_reason: null,
          usage: { input_tokens: usage.input_tokens, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: reply },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: usage.output_tokens },
      },
      { type: "message_stop" },
    ];
    const text = events
      .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join("");
    return new Response(text, {
      headers: { "content-type": "text/event-stream" },
    });
  }
  return Response.json({
    ...message,
    content: [{ type: "text", text: reply }],
    usage,
  });
}

function answer(url: URL, body: Record<string, unknown>): Response {
  const path = url.pathname;
  if (path.endsWith("/key")) {
    return Response.json({ data: { label: "demo key" } });
  }
  if (path.endsWith("/models")) {
    const ids = MODELS[url.host] ?? ["demo-model"];
    return Response.json({
      object: "list",
      data: ids.map((id) => ({ id, object: "model" })),
    });
  }
  if (path.endsWith("/chat/completions")) {
    return chat(body, url.host === "openrouter.ai" ? 0.0004 : null);
  }
  if (path.endsWith("/messages")) return messages(body);
  if (path.endsWith("/responses")) {
    const model = typeof body.model === "string" ? body.model : "demo-model";
    const prompt = lastUserText(body);
    const reply = replyTo(prompt, model);
    return Response.json({
      id: "resp_demo",
      object: "response",
      model,
      output_text: reply,
      usage: { input_tokens: tokens(prompt), output_tokens: tokens(reply) },
    });
  }
  if (path.endsWith("/embeddings")) {
    return Response.json({
      object: "list",
      model: body.model,
      data: [{ object: "embedding", index: 0, embedding: [0, 0, 0] }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    });
  }
  return Response.json(
    { error: { message: "The demo doesn't answer this." } },
    { status: 404 },
  );
}

/** Answers calls that carry the demo key. Everything else goes to the real network. */
export function demoFetch(real: typeof fetch): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const sent =
      request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      request.headers.get("x-api-key") ??
      request.headers.get("api-key");
    if (!isDemoKey(sent)) return real(input, init);
    const body =
      request.method === "POST"
        ? ((await request.json().catch(() => ({}))) as Record<string, unknown>)
        : {};
    return answer(new URL(request.url), body);
  };
}
