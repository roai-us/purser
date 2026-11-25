import Anthropic from "@anthropic-ai/sdk";
import { serve, type ServerType } from "@hono/node-server";
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  BUILTIN_CONNECTORS,
  type ConnectorManifest,
} from "../src/connectors.js";
import { createAgent } from "../src/control.js";
import { InFlight } from "../src/inflight.js";
import { DEFAULT_PRICES } from "../src/prices.js";
import { Store } from "../src/store.js";
import type { UsageRecord } from "../src/types.js";

/**
 * The proof from sdk.test.ts, against the real providers. For each built-in
 * connector with a key in the environment (PURSER_<ID>_API_KEY, the same
 * variables Purser reads), the official SDK is pointed at a Purser running on
 * this machine and told only its address and an agent key. Then:
 *
 *   1. a call is answered,
 *   2. and metered from the provider's own token counts,
 *   3. a streamed call is answered and metered too,
 *   4. an agent at its cap is refused before anything reaches the provider,
 *   5. and a stop cuts a running stream in under a second.
 *
 * It spends real money, a fraction of a cent per provider, so it never runs
 * in CI or with `pnpm test`. Run it with `pnpm test:live`. Keys are never
 * printed or written to the report.
 */

const ADMIN = "purser_admin_live";
const envId = (id: string) => id.toUpperCase().replace(/-/g, "_");
const keyFor = (id: string) => process.env[`PURSER_${envId(id)}_API_KEY`];
const upstreamFor = (id: string) => process.env[`PURSER_${envId(id)}_UPSTREAM`];
const modelFor = (c: ConnectorManifest) =>
  process.env[`PURSER_LIVE_${envId(c.id)}_MODEL`] ?? c.testModel;

const store = new Store();
const inflight = new InFlight();
let server: ServerType;
let purser = "";

interface Result {
  provider: string;
  model: string;
  checks: Record<string, string>;
  costUsd: number;
}
const results: Result[] = [];

const connectors = BUILTIN_CONNECTORS.filter(
  (c) => keyFor(c.id) && (!c.needsUpstream || upstreamFor(c.id)),
);

beforeAll(async () => {
  const providerKeys: Record<string, string> = {};
  const upstreams: Record<string, string> = {};
  for (const c of connectors) {
    providerKeys[c.id] = keyFor(c.id) as string;
    const up = upstreamFor(c.id);
    if (up) upstreams[c.id] = up;
  }
  const app = createApp({
    store,
    inflight,
    prices: DEFAULT_PRICES,
    providerKeys,
    upstreams,
    fetch: globalThis.fetch,
    now: () => new Date(),
    adminToken: ADMIN,
  });
  await new Promise<void>((resolve) => {
    server = serve(
      { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
      (info: AddressInfo) => {
        purser = `http://127.0.0.1:${info.port}`;
        resolve();
      },
    );
  });
});

afterAll(() => {
  server?.close();
  const names = ["answers", "metered", "streams", "cap", "stop"] as const;
  const lines = [
    `Live provider checks, ${new Date().toISOString().slice(0, 10)}`,
    "",
    "| Provider | Model | Answers | Metered | Streams, metered | Refused at cap | Stopped mid-stream | Spent |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...results.map(
      (r) =>
        `| ${r.provider} | \`${r.model}\` | ${names.map((n) => r.checks[n] ?? "not run").join(" | ")} | $${r.costUsd.toFixed(5)} |`,
    ),
    "",
    connectors.length === 0
      ? "No provider keys were set, so nothing was checked. Set PURSER_<ID>_API_KEY for each provider to check."
      : `Skipped (no key): ${
          BUILTIN_CONNECTORS.filter((c) => !connectors.includes(c))
            .map((c) => c.name)
            .join(", ") || "none"
        }.`,
  ];
  const report = lines.join("\n");
  process.stdout.write(`\n${report}\n`);
  const out = process.env.PURSER_LIVE_REPORT;
  if (out) writeFileSync(out, `${report}\n`);
});

const admin = (method: string, path: string, body?: unknown) =>
  fetch(`${purser}/admin${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const newAgent = (name: string) =>
  createAgent(
    { store, inflight, now: () => new Date() },
    { name, owner: "Live check" },
  );

/**
 * The agent's latest usage record. A stream's record is written as Purser
 * finishes relaying it, which can be a moment after the client has read the
 * last piece, so this waits up to two seconds for it.
 */
async function last(agentId: string): Promise<UsageRecord | undefined> {
  for (let i = 0; i < 40; i++) {
    const record = store.listUsage(agentId).at(-1);
    if (record) return record;
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}

/** "yes (table)" when priced from real counts; a warning when Purser had to guess. */
function meteredWords(r: UsageRecord | undefined): string {
  if (!r) return "NO RECORD";
  if (r.priced === "estimate") return `estimated ($${r.costUsd.toFixed(6)})`;
  if (r.priced === "fallback")
    return `yes, but model not in price table ($${r.costUsd.toFixed(6)})`;
  return `yes, ${r.inputTokens} in / ${r.outputTokens} out, $${r.costUsd.toFixed(6)}`;
}

const LONG = "Count from 1 to 300, one number per line, and nothing else.";

/**
 * For checking this check against the test mock (src/test/mock-upstream.ts),
 * whose streams are otherwise instant: PURSER_LIVE_MOCK_SLOW=100 makes it
 * wait that many milliseconds between pieces. Real providers ignore it.
 */
const extraHeaders: Record<string, string> = process.env.PURSER_LIVE_MOCK_SLOW
  ? { "x-mock-slow": process.env.PURSER_LIVE_MOCK_SLOW }
  : {};

/** A client that sends and streams through Purser with the agent's key, in the provider's own SDK. */
function client(c: ConnectorManifest, key: string, model: string) {
  const base = `${purser}${c.agentPath ?? c.mount ?? `/${c.id}/v1`}`;
  if (c.kind === "anthropic") {
    const sdk = new Anthropic({
      baseURL: base,
      apiKey: key,
      maxRetries: 0,
      defaultHeaders: extraHeaders,
    });
    return {
      async ask(prompt: string, maxTokens: number) {
        const m = await sdk.messages.create({
          model,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        });
        const first = m.content[0];
        return {
          text: first?.type === "text" ? first.text : "",
          input: m.usage.input_tokens,
          output: m.usage.output_tokens,
        };
      },
      async *stream(prompt: string, maxTokens: number) {
        const s = sdk.messages.stream({
          model,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        });
        for await (const event of s) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            yield event.delta.text;
          }
        }
      },
    };
  }
  const sdk = new OpenAI({
    baseURL: base,
    apiKey: key,
    maxRetries: 0,
    defaultHeaders: extraHeaders,
  });
  // OpenAI's own newer models want max_completion_tokens; the rest take max_tokens.
  const limit = (n: number) =>
    c.id === "openai" || c.id === "azure-openai"
      ? { max_completion_tokens: n }
      : { max_tokens: n };
  return {
    async ask(prompt: string, maxTokens: number) {
      const r = await sdk.chat.completions.create({
        model,
        messages: [{ role: "user", content: prompt }],
        ...limit(maxTokens),
      });
      return {
        text: r.choices[0]?.message.content ?? "",
        input: r.usage?.prompt_tokens,
        output: r.usage?.completion_tokens,
      };
    },
    async *stream(prompt: string, maxTokens: number) {
      const s = await sdk.chat.completions.create({
        model,
        messages: [{ role: "user", content: prompt }],
        stream: true,
        ...limit(maxTokens),
      });
      for await (const chunk of s) {
        const t = chunk.choices[0]?.delta.content;
        if (t) yield t;
      }
    },
  };
}

if (connectors.length === 0) {
  it("has no provider keys to check with", () => {
    expect(connectors).toEqual([]);
  });
}

for (const c of connectors) {
  const model = modelFor(c);
  describe.skipIf(!model)(`${c.name} (${model ?? "no test model"})`, () => {
    const result: Result = {
      provider: c.name,
      model: model ?? "",
      checks: {},
      costUsd: 0,
    };
    results.push(result);
    const note = (check: string, words: string) =>
      (result.checks[check] = words);
    const spent = (agentId: string) =>
      (result.costUsd += store
        .listUsage(agentId)
        .reduce((sum, u) => sum + u.costUsd, 0));

    it("answers, and meters the call from the provider's counts", async () => {
      const { agent, key } = newAgent(`live-${c.id}`);
      const api = client(c, key, model as string);
      note("answers", "FAILED");
      note("metered", "FAILED");
      try {
        const reply = await api.ask("Reply with the single word: ready", 16);
        expect(reply.text.length).toBeGreaterThan(0);
        note("answers", "yes");
        const record = await last(agent.id);
        note("metered", meteredWords(record));
        expect(record?.outcome).toBe("complete");
        expect(record?.priced).not.toBe("estimate");
        if (reply.input !== undefined && record) {
          // OpenAI-style counts include cached tokens, which Purser keeps
          // apart; Anthropic's input_tokens already leaves them out.
          const counted =
            c.kind === "anthropic"
              ? record.inputTokens
              : record.inputTokens + record.cacheReadTokens;
          expect(counted).toBe(reply.input);
        }
        if (reply.output !== undefined) {
          expect(record?.outputTokens).toBe(reply.output);
        }
      } finally {
        spent(agent.id);
      }
    });

    it("streams, and meters the stream", async () => {
      const { agent, key } = newAgent(`live-${c.id}-stream`);
      const api = client(c, key, model as string);
      note("streams", "FAILED");
      try {
        let text = "";
        for await (const t of api.stream("Say hello in five words.", 32)) {
          text += t;
        }
        expect(text.length).toBeGreaterThan(0);
        const record = await last(agent.id);
        note("streams", meteredWords(record));
        expect(record?.outcome).toBe("complete");
        expect(record?.costUsd).toBeGreaterThan(0);
      } finally {
        spent(agent.id);
      }
    });

    it("refuses an agent at its cap before calling the provider", async () => {
      const { agent, key } = newAgent(`live-${c.id}-cap`);
      note("cap", "FAILED");
      const res = await admin("PATCH", `/agents/${agent.id}/limits`, {
        dailyUsd: 0,
      });
      expect(res.status).toBe(200);
      const api = client(c, key, model as string);
      await expect(api.ask("hi", 8)).rejects.toMatchObject({ status: 403 });
      // Nothing was sent, so nothing was metered.
      expect(store.listUsage(agent.id)).toHaveLength(0);
      note("cap", "yes, 403, nothing sent");
    });

    it("cuts a running stream within a second of a stop", async () => {
      const { agent, key } = newAgent(`live-${c.id}-stop`);
      const api = client(c, key, model as string);
      note("stop", "FAILED");
      let pieces = 0;
      let stoppedAt = 0;
      let finished = false;
      try {
        for await (const _t of api.stream(LONG, 800)) {
          pieces++;
          if (pieces === 3) {
            stoppedAt = performance.now();
            await admin("POST", `/agents/${agent.id}/kill`);
          }
        }
        finished = true;
      } catch {
        // The cut: the expected way out.
      } finally {
        spent(agent.id);
      }
      if (stoppedAt === 0) {
        note("stop", "not tested: the answer finished first");
        return;
      }
      const ms = Math.round(performance.now() - stoppedAt);
      const record = await last(agent.id);
      note(
        "stop",
        `${finished ? "ended" : "cut"} after ${ms} ms, ${record?.outcome ?? "no record"}`,
      );
      expect(ms).toBeLessThan(1000);
      expect(record?.outcome).toBe("aborted");
      expect(record?.costUsd).toBeGreaterThan(0);
    });
  });
}
