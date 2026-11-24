import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adminToken, isLoopback, loadConfig } from "./config.js";
import { InFlight } from "./inflight.js";
import { generateAgentKey, hashKey, keyHint, safeEqual } from "./keys.js";
import { formatUsd } from "./money.js";
import { DEFAULT_PRICES } from "./prices.js";
import {
  costUsd,
  findPrice,
  modelMatches,
  totalInputTokens,
} from "./pricing.js";
import { Store, windowKey } from "./store.js";
import { emptyUsage, type Agent, type UsageRecord } from "./types.js";
import {
  anthropicUsage,
  openaiUsage,
  reportedCost,
  SseParser,
  cutOffUsage,
  StreamUsage,
  usageFromBody,
} from "./usage.js";

describe("keys", () => {
  it("makes long random keys, hashes them and shows a hint", () => {
    const a = generateAgentKey();
    const b = generateAgentKey();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(40);
    expect(hashKey(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(keyHint(a)).toBe(`purser_${a.slice(7, 9)}...${a.slice(-4)}`);
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("money", () => {
  it("shows cents, or four decimals below a cent", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.002175)).toBe("$0.0022");
    expect(formatUsd(12.5)).toBe("$12.50");
  });
});

describe("pricing", () => {
  it("picks the longest matching model family", () => {
    expect(findPrice(DEFAULT_PRICES, "gpt-4o-mini-2024-07-18", 0).matched).toBe(
      "gpt-4o-mini",
    );
    expect(findPrice(DEFAULT_PRICES, "gpt-4o-2024-08-06", 0).matched).toBe(
      "gpt-4o",
    );
    expect(
      findPrice(DEFAULT_PRICES, "claude-opus-4-1-20250805", 0).matched,
    ).toBe("claude-opus-4-1");
    expect(findPrice(DEFAULT_PRICES, "claude-opus-4", 0).matched).toBe(
      "claude-opus-4",
    );
    expect(findPrice(DEFAULT_PRICES, "gpt-4", 0).matched).toBeNull();
    expect(modelMatches("gpt-4oops", "gpt-4o")).toBe(false);
    expect(modelMatches("openai/gpt-4o:nitro", "openai/gpt-4o")).toBe(true);
  });

  it("switches to the long-prompt rate above the threshold", () => {
    expect(
      findPrice(DEFAULT_PRICES, "claude-haiku-5-5", 100_000).rates.input,
    ).toBe(0.1);
    expect(
      findPrice(DEFAULT_PRICES, "claude-haiku-5-5", 100_001).rates.input,
    ).toBe(0.5);
  });

  it("defaults cache rates from the input rate", () => {
    const usage = {
      inputTokens: 1e6,
      outputTokens: 1e6,
      cacheReadTokens: 1e6,
      cacheWrite5mTokens: 1e6,
      cacheWrite1hTokens: 1e6,
    };
    expect(costUsd(usage, { input: 2, output: 10 })).toBeCloseTo(
      2 + 10 + 2 + 2.5 + 4,
      10,
    );
    expect(totalInputTokens(usage)).toBe(4e6);
  });

  it("has a dated, sourced table whose fallback is its most expensive rate", () => {
    expect(DEFAULT_PRICES.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(DEFAULT_PRICES.sources.length).toBeGreaterThan(0);
    for (const price of Object.values(DEFAULT_PRICES.models)) {
      expect(price.input).toBeLessThanOrEqual(DEFAULT_PRICES.fallback.input);
      expect(price.output).toBeLessThanOrEqual(DEFAULT_PRICES.fallback.output);
    }
  });
});

describe("usage parsing", () => {
  it("reads OpenAI usage in both shapes and ignores junk", () => {
    expect(
      openaiUsage({ prompt_tokens: 10, completion_tokens: 5 }),
    ).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(openaiUsage({ input_tokens: 10, output_tokens: 5 })).toMatchObject({
      inputTokens: 10,
      cacheReadTokens: 0,
    });
    expect(openaiUsage({ prompt_tokens: "x" })).toMatchObject({
      inputTokens: 0,
    });
    expect(openaiUsage({ total_tokens: 3 })).toBeNull();
    expect(openaiUsage(null)).toBeNull();
    expect(usageFromBody("openai", [1])).toEqual({
      usage: null,
      model: null,
      costUsd: null,
    });
    expect(usageFromBody("openai", { usage: null })).toEqual({
      usage: null,
      model: null,
      costUsd: null,
    });
  });

  it("takes only a sane charge reported by OpenRouter", () => {
    expect(reportedCost("openrouter", { cost: 0.5 })).toBe(0.5);
    expect(reportedCost("openrouter", { cost: 0 })).toBe(0);
    for (const cost of [-1, "0.5", Number.NaN, null]) {
      expect(reportedCost("openrouter", { cost })).toBeNull();
    }
    expect(reportedCost("openrouter", null)).toBeNull();
    // Other providers' bodies are never trusted for a charge.
    expect(reportedCost("openai", { cost: 0.5 })).toBeNull();
  });

  it("reads Anthropic usage with the older cache field", () => {
    expect(
      anthropicUsage({
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 3,
      }),
    ).toMatchObject({
      cacheWrite5mTokens: 3,
      cacheWrite1hTokens: 0,
    });
    expect(anthropicUsage(undefined)).toBeNull();
  });

  it("counts the answer so a cut-off stream can be charged", () => {
    const chat = new StreamUsage("openai");
    chat.add({
      choices: [{ delta: { role: "assistant", content: "abcdef" } }],
    });
    chat.add({ choices: [{ delta: { reasoning: "abc" } }] });
    chat.add({
      choices: [
        {
          delta: {
            tool_calls: [{ id: "call_1", function: { arguments: "abc" } }],
          },
        },
      ],
    });
    chat.add({ choices: ["nope"] });
    expect(chat.outputChars).toBe(12);
    expect(chat.unreportedOutputTokens).toBe(4);

    const messages = new StreamUsage("anthropic");
    messages.add({ type: "message_start", message: { usage: null } });
    messages.add({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "abc" },
    });
    messages.add({
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: "abc" },
    });
    messages.add({
      type: "content_block_delta",
      delta: { type: "signature_delta", signature: "not-text" },
    });
    expect(messages.outputChars).toBe(6);

    const responses = new StreamUsage("openai");
    responses.add({ type: "response.output_text.delta", delta: "abc" });
    responses.add({ type: "response.created", response: { id: "not-text" } });
    expect(responses.outputChars).toBe(3);
  });

  it("stops estimating output once the provider has reported it", () => {
    const chat = new StreamUsage("openai");
    chat.add({ choices: [{ delta: { content: "abc" } }] });
    chat.add({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
    expect(chat.unreportedOutputTokens).toBeNull();

    const messages = new StreamUsage("anthropic");
    messages.add({
      type: "message_start",
      message: { usage: { input_tokens: 5, output_tokens: 1 } },
    });
    messages.add({ type: "content_block_delta", delta: { text: "abcdef" } });
    // message_start's count is only a placeholder, so this is still unknown.
    expect(messages.unreportedOutputTokens).toBe(2);
    messages.add({ type: "message_delta", usage: { output_tokens: 3 } });
    expect(messages.unreportedOutputTokens).toBeNull();
  });

  it("estimates from bytes when no event looks like an answer", () => {
    const stream = new StreamUsage("openai");
    stream.bytes = 30;
    expect(stream.unreportedOutputTokens).toBe(10);
  });

  it("keeps reported counts when charging a cut-off call", () => {
    const reported = {
      ...emptyUsage(),
      inputTokens: 200,
      cacheReadTokens: 50,
      outputTokens: 1,
    };
    expect(cutOffUsage(reported, 3000, 40)).toEqual({
      ...reported,
      outputTokens: 40,
    });
    expect(reported.outputTokens).toBe(1);
    expect(cutOffUsage(null, 300, 0)).toEqual({
      ...emptyUsage(),
      inputTokens: 100,
    });
  });

  it("ignores stream events without usage", () => {
    const openai = new StreamUsage("openai");
    openai.add("nope");
    openai.add({ choices: [] });
    expect(openai.seen).toBe(false);
    const anthropic = new StreamUsage("anthropic");
    anthropic.add({ type: "message_start", message: { usage: null } });
    anthropic.add({ type: "message_delta", usage: { output_tokens: 5 } });
    anthropic.add({
      type: "message_delta",
      usage: { output_tokens: 3, input_tokens: 9 },
    });
    anthropic.add({ type: "ping" });
    expect(anthropic.usage).toMatchObject({ outputTokens: 5, inputTokens: 9 });
    expect(anthropic.model).toBeNull();
  });

  it("splits server-sent events across chunk boundaries", () => {
    const events: unknown[] = [];
    const parser = new SseParser((e) => events.push(e));
    const enc = new TextEncoder();
    parser.push(enc.encode('event: x\r\ndata: {"a":'));
    parser.push(
      enc.encode("1}\r\n\r\ndata: [DONE]\n\ndata: not json\n\n: comment\n"),
    );
    parser.push(enc.encode('data: {"b":2}'));
    parser.end();
    parser.end();
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: "agt_1",
  name: "bot",
  owner: "Dana",
  keyHash: "h1",
  keyHint: "purser_ab...wxyz",
  status: "active",
  limits: {},
  createdAt: "2026-11-07T00:00:00Z",
  ...over,
});

const usageRecord = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  id: "use_1",
  agentId: "agt_1",
  provider: "openai",
  endpoint: "chat.completions",
  model: "gpt-4o",
  at: "2026-11-07T10:00:00Z",
  ...emptyUsage(),
  costUsd: 1.5,
  priced: "table",
  status: 200,
  durationMs: 10,
  outcome: "complete",
  ...over,
});

describe("store", () => {
  it("buckets spend by UTC day and month", () => {
    const store = new Store();
    store.createAgent(agent());
    store.recordUsage(usageRecord());
    store.recordUsage(
      usageRecord({ id: "use_2", at: "2026-11-08T01:00:00Z", costUsd: 2 }),
    );
    expect(store.spend("agt_1", "day", new Date("2026-11-07T23:59:59Z"))).toBe(
      1.5,
    );
    expect(store.spend("agt_1", "day", new Date("2026-11-08T12:00:00Z"))).toBe(
      2,
    );
    expect(
      store.spend("agt_1", "month", new Date("2026-11-30T00:00:00Z")),
    ).toBe(3.5);
    expect(
      store.spend("agt_1", "month", new Date("2026-12-01T00:00:00Z")),
    ).toBe(0);
    expect(windowKey("month", new Date("2026-11-07T00:00:00Z"))).toBe(
      "2026-11",
    );
  });

  it("persists agents, usage and audit to private files and reloads them", () => {
    const dir = mkdtempSync(join(tmpdir(), "purser-"));
    const store = new Store(dir);
    store.createAgent(agent());
    store.updateAgent("agt_1", { keyHash: "h2" });
    store.recordUsage(usageRecord());
    store.audit({
      at: "2026-11-07T00:00:00Z",
      type: "agent.created",
      agentId: "agt_1",
    });
    expect(statSync(join(dir, "agents.json")).mode & 0o077).toBe(0);
    expect(readFileSync(join(dir, "usage.jsonl"), "utf8")).toContain("use_1");

    const reloaded = new Store(dir);
    expect(reloaded.getAgentByKeyHash("h2")?.name).toBe("bot");
    expect(reloaded.getAgentByKeyHash("h1")).toBeUndefined();
    expect(
      reloaded.spend("agt_1", "day", new Date("2026-11-07T12:00:00Z")),
    ).toBe(1.5);
    expect(reloaded.listAudit()).toHaveLength(1);
  });

  it("refuses duplicate names and unknown ids", () => {
    const store = new Store();
    store.createAgent(agent());
    expect(() =>
      store.createAgent(agent({ id: "agt_2", keyHash: "h9" })),
    ).toThrow(/already exists/);
    expect(() => store.updateAgent("agt_404", {})).toThrow(/No agent/);
    expect(store.resolve("bot")?.id).toBe("agt_1");
    expect(store.resolve("agt_1")?.name).toBe("bot");
  });
});

describe("in-flight requests", () => {
  it("tracks and aborts per agent", () => {
    const inflight = new InFlight();
    const a = new AbortController();
    const b = new AbortController();
    inflight.add("x", a);
    inflight.add("x", b);
    inflight.remove("x", b);
    inflight.remove("nobody", b);
    expect(inflight.count("x")).toBe(1);
    expect(inflight.abortAll("x", "test")).toBe(1);
    expect(a.signal.aborted).toBe(true);
    expect(inflight.abortAll("x", "again")).toBe(0);
  });
});

describe("config", () => {
  it("binds to localhost and refuses other hosts unless told", () => {
    const config = loadConfig({
      PURSER_DATA_DIR: "/tmp/p",
      PURSER_OPENAI_API_KEY: "sk-1",
      PURSER_ANTHROPIC_UPSTREAM: "http://x/v1/",
    });
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 4141,
      providerKeys: { openai: "sk-1" },
    });
    expect(config.upstreams.anthropic).toBe("http://x/v1");
    expect(() => loadConfig({ PURSER_HOST: "0.0.0.0" })).toThrow(/Refusing/);
    expect(
      loadConfig({
        PURSER_HOST: "0.0.0.0",
        PURSER_ALLOW_REMOTE: "1",
        PURSER_ANTHROPIC_API_KEY: "a",
      }).host,
    ).toBe("0.0.0.0");
    expect(isLoopback("::1")).toBe(true);
    expect(loadConfig({}).baseUrl).toBe("http://127.0.0.1:4141");
    expect(
      loadConfig({ PURSER_BASE_URL: "https://purser.example.com/" }).baseUrl,
    ).toBe("https://purser.example.com");
    for (const bad of [
      "purser.example.com",
      "ftp://purser.example.com",
      "https://purser.example.com/?x=1",
      "https://user:pw@purser.example.com",
    ]) {
      expect(() => loadConfig({ PURSER_BASE_URL: bad })).toThrow(
        /PURSER_BASE_URL/,
      );
    }
    expect(loadConfig({}).dataDir).toMatch(/\.purser$/);
  });

  it("creates the admin token once, readable only by its owner", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "purser-")), "data");
    const first = adminToken({}, dir);
    expect(first).toMatch(/^purser_admin_/);
    expect(statSync(join(dir, "admin-token")).mode & 0o077).toBe(0);
    expect(adminToken({}, dir)).toBe(first);
    expect(adminToken({ PURSER_ADMIN_TOKEN: "env" }, dir)).toBe("env");
  });
});
