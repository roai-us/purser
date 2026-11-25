import { emptyUsage, type TokenUsage } from "./types.js";

/** How to read a provider's usage: its wire format and whether it reports the charge. */
export interface UsageSpec {
  kind: "openai-compatible" | "anthropic";
  reportsCost: boolean;
}

/**
 * A usage spec, or a built-in connector id as shorthand: "anthropic" reads
 * the Messages format, "openrouter" also reads the reported charge, and any
 * other id reads the OpenAI format.
 */
export type UsageSource = UsageSpec | string;

export function usageSpec(source: UsageSource): UsageSpec {
  if (typeof source !== "string") return source;
  return {
    kind: source === "anthropic" ? "anthropic" : "openai-compatible",
    reportsCost: source === "openrouter",
  };
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;

/**
 * OpenAI usage. Chat completions and embeddings report prompt and completion
 * tokens; the Responses API reports input and output tokens. Cached tokens are
 * part of the prompt count, so they are split out to be priced separately.
 */
export function openaiUsage(usage: unknown): TokenUsage | null {
  if (!isObject(usage)) return null;
  const result = emptyUsage();
  if ("prompt_tokens" in usage) {
    const details = isObject(usage.prompt_tokens_details)
      ? usage.prompt_tokens_details
      : {};
    const cached = num(details.cached_tokens);
    result.inputTokens = Math.max(0, num(usage.prompt_tokens) - cached);
    result.cacheReadTokens = cached;
    result.outputTokens = num(usage.completion_tokens);
    return result;
  }
  if ("input_tokens" in usage) {
    const details = isObject(usage.input_tokens_details)
      ? usage.input_tokens_details
      : {};
    const cached = num(details.cached_tokens);
    result.inputTokens = Math.max(0, num(usage.input_tokens) - cached);
    result.cacheReadTokens = cached;
    result.outputTokens = num(usage.output_tokens);
    return result;
  }
  return null;
}

/**
 * Anthropic usage. Input tokens exclude cache reads and writes. Cache writes
 * are split by lifetime when the API reports it, otherwise counted as 5-minute.
 */
export function anthropicUsage(usage: unknown): TokenUsage | null {
  if (!isObject(usage)) return null;
  const result = emptyUsage();
  result.inputTokens = num(usage.input_tokens);
  result.outputTokens = num(usage.output_tokens);
  result.cacheReadTokens = num(usage.cache_read_input_tokens);
  if (isObject(usage.cache_creation)) {
    result.cacheWrite5mTokens = num(
      usage.cache_creation.ephemeral_5m_input_tokens,
    );
    result.cacheWrite1hTokens = num(
      usage.cache_creation.ephemeral_1h_input_tokens,
    );
  } else {
    result.cacheWrite5mTokens = num(usage.cache_creation_input_tokens);
  }
  return result;
}

/**
 * The charge a provider reports itself, in US dollars, or null. Only
 * connectors that report it (OpenRouter today, in `usage.cost`) are trusted.
 */
export function reportedCost(
  provider: UsageSource,
  usage: unknown,
): number | null {
  if (!usageSpec(provider).reportsCost || !isObject(usage)) return null;
  const cost = usage.cost;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0
    ? cost
    : null;
}

const tokenUsage = (provider: UsageSource, usage: unknown) =>
  usageSpec(provider).kind === "anthropic"
    ? anthropicUsage(usage)
    : openaiUsage(usage);

/** Usage, model and any reported charge from a complete (non-streaming) JSON body. */
export function usageFromBody(
  provider: UsageSource,
  body: unknown,
): { usage: TokenUsage | null; model: string | null; costUsd: number | null } {
  if (!isObject(body)) return { usage: null, model: null, costUsd: null };
  const model = typeof body.model === "string" ? body.model : null;
  return {
    usage: tokenUsage(provider, body.usage),
    model,
    costUsd: reportedCost(provider, body.usage),
  };
}

/**
 * Collects usage from a stream of server-sent events, one parsed `data:`
 * payload at a time. Each provider reports usage in different events:
 *
 * - OpenAI chat completions: a final chunk with `usage` (Purser asks for it
 *   with `stream_options.include_usage`).
 * - OpenAI Responses: the `response.completed` event carries `response.usage`.
 * - Anthropic: `message_start` carries input and cache tokens; each
 *   `message_delta` carries the running output count.
 * - OpenRouter: like OpenAI, and the final chunk's `usage.cost` is the charge.
 *
 * Most of these arrive at the end, so it also counts the answer as it goes. A
 * stream cut off before its end is still billed by the provider, and the count
 * is what Purser charges for it.
 */
export class StreamUsage {
  usage: TokenUsage = emptyUsage();
  model: string | null = null;
  /** The charge the provider reported, when it reports one. */
  costUsd: number | null = null;
  seen = false;
  /** Characters of answer seen so far, including reasoning and tool calls. */
  outputChars = 0;

  private readonly spec: UsageSpec;
  /** The provider has given its count of the answer's tokens. */
  private outputReported = false;
  /** Bytes of the stream seen, for an estimate when no usage is reported. */
  bytes = 0;

  constructor(provider: UsageSource) {
    this.spec = usageSpec(provider);
  }

  add(event: unknown): void {
    if (!isObject(event)) return;
    this.outputChars += answerChars(event);
    if (this.spec.kind === "anthropic") this.addAnthropic(event);
    else this.addOpenai(event);
  }

  /**
   * The output tokens to charge if the stream ends here without finishing, or
   * null once the provider has reported its own count. Falls back to the bytes
   * seen when no event was recognized as answer text.
   */
  get unreportedOutputTokens(): number | null {
    if (this.outputReported) return null;
    return Math.ceil(
      (this.outputChars > 0 ? this.outputChars : this.bytes) /
        ESTIMATE_BYTES_PER_TOKEN,
    );
  }

  private addOpenai(event: Json): void {
    const holder = isObject(event.response) ? event.response : event;
    if (typeof holder.model === "string") this.model = holder.model;
    const usage = openaiUsage(holder.usage);
    if (usage) {
      this.usage = usage;
      this.costUsd = reportedCost(this.spec, holder.usage);
      this.seen = true;
      this.outputReported = true;
    }
  }

  private addAnthropic(event: Json): void {
    if (event.type === "message_start" && isObject(event.message)) {
      if (typeof event.message.model === "string")
        this.model = event.message.model;
      const usage = anthropicUsage(event.message.usage);
      if (usage) {
        this.usage = usage;
        this.seen = true;
      }
      return;
    }
    if (event.type === "message_delta" && isObject(event.usage)) {
      const delta = anthropicUsage(event.usage);
      if (!delta) return;
      this.outputReported = true;
      // Counts in message_delta are cumulative: keep the larger value.
      this.usage = {
        inputTokens: Math.max(this.usage.inputTokens, delta.inputTokens),
        outputTokens: Math.max(this.usage.outputTokens, delta.outputTokens),
        cacheReadTokens: Math.max(
          this.usage.cacheReadTokens,
          delta.cacheReadTokens,
        ),
        cacheWrite5mTokens: Math.max(
          this.usage.cacheWrite5mTokens,
          delta.cacheWrite5mTokens,
        ),
        cacheWrite1hTokens: Math.max(
          this.usage.cacheWrite1hTokens,
          delta.cacheWrite1hTokens,
        ),
      };
      this.seen = true;
    }
  }
}

/** Keys of a stream delta that describe the answer rather than being part of it. */
const NOT_ANSWER = new Set(["role", "type", "id", "signature"]);

/** Counts the text in a delta, wherever a provider puts it. */
function textChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + textChars(item), 0);
  }
  if (!isObject(value)) return 0;
  let sum = 0;
  for (const [key, item] of Object.entries(value)) {
    if (!NOT_ANSWER.has(key)) sum += textChars(item);
  }
  return sum;
}

/**
 * Characters of answer in one stream event: `choices[].delta` in chat
 * completions, `delta` in Anthropic's content blocks, and a string `delta` in
 * Responses events. Metadata in other events is not the answer, so isn't counted.
 */
function answerChars(event: Json): number {
  if (Array.isArray(event.choices)) {
    return event.choices.reduce<number>(
      (sum: number, choice: unknown) =>
        sum + (isObject(choice) ? textChars(choice.delta) : 0),
      0,
    );
  }
  if (event.type === "content_block_delta") return textChars(event.delta);
  if (
    typeof event.type === "string" &&
    event.type.endsWith(".delta") &&
    typeof event.delta === "string"
  ) {
    return event.delta.length;
  }
  return 0;
}

/** Splits a byte stream of server-sent events into parsed JSON `data:` payloads. */
export class SseParser {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly onData: (data: unknown) => void,
    /** Called for the OpenAI-style `data: [DONE]` that ends a stream. */
    private readonly onDone?: () => void,
  ) {}

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.line(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  end(): void {
    this.buffer += this.decoder.decode();
    if (this.buffer.length > 0) this.line(this.buffer.replace(/\r$/, ""));
    this.buffer = "";
  }

  private line(line: string): void {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") {
      this.onDone?.();
      return;
    }
    if (payload === "") return;
    try {
      this.onData(JSON.parse(payload));
    } catch {
      // Not JSON: nothing to meter in this event.
    }
  }
}

/** Well under the usual 4 characters a token, so estimates run high. */
const ESTIMATE_BYTES_PER_TOKEN = 3;

/**
 * A deliberately high token estimate for a call whose provider reported no
 * usage: about one token per 3 bytes of request and response. Used so a
 * provider that leaves usage out of a stream cannot be used to slip past a cap.
 */
export function estimateUsage(
  requestBytes: number,
  responseBytes: number,
): TokenUsage {
  const usage = emptyUsage();
  usage.inputTokens = Math.ceil(requestBytes / ESTIMATE_BYTES_PER_TOKEN);
  usage.outputTokens = Math.ceil(responseBytes / ESTIMATE_BYTES_PER_TOKEN);
  return usage;
}

/**
 * What a call cut off before its end is charged, since the provider bills for
 * what it produced. Keeps any counts it reported, and estimates the rest:
 * input from the request and output from the answer seen before the cut.
 */
export function cutOffUsage(
  reported: TokenUsage | null,
  requestBytes: number,
  unreportedOutputTokens: number,
): TokenUsage {
  const usage = reported ? { ...reported } : emptyUsage();
  if (!reported) {
    usage.inputTokens = Math.ceil(requestBytes / ESTIMATE_BYTES_PER_TOKEN);
  }
  usage.outputTokens = Math.max(usage.outputTokens, unreportedOutputTokens);
  return usage;
}
