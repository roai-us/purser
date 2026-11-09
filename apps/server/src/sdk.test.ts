import Anthropic from "@anthropic-ai/sdk";
import { serve, type ServerType } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createAgent } from "./control.js";
import { InFlight } from "./inflight.js";
import { DEFAULT_PRICES } from "./prices.js";
import { Store } from "./store.js";
import {
  mockUpstream,
  OPENROUTER_COST,
  REAL_ANTHROPIC_KEY,
  REAL_OPENAI_KEY,
  REAL_OPENROUTER_KEY,
} from "./test/mock-upstream.js";

/**
 * End to end over real HTTP, with the official SDKs. The only thing each
 * client is told is Purser's base URL and its agent key: the same change a
 * real agent makes.
 */
const store = new Store();
const inflight = new InFlight();
const upstream = mockUpstream();
let upstreamServer: ServerType;
let purserServer: ServerType;
let purser = "";

const listen = (fetchHandler: (r: Request) => Response | Promise<Response>) =>
  new Promise<{ server: ServerType; url: string }>((resolve) => {
    const server = serve(
      { fetch: fetchHandler, hostname: "127.0.0.1", port: 0 },
      (info: AddressInfo) =>
        resolve({ server, url: `http://127.0.0.1:${info.port}` }),
    );
  });

beforeAll(async () => {
  const up = await listen(upstream.app.fetch);
  upstreamServer = up.server;
  const app = createApp({
    store,
    inflight,
    prices: DEFAULT_PRICES,
    providerKeys: {
      openai: REAL_OPENAI_KEY,
      anthropic: REAL_ANTHROPIC_KEY,
      openrouter: REAL_OPENROUTER_KEY,
    },
    upstreams: {
      openai: `${up.url}/openai/v1`,
      anthropic: `${up.url}/anthropic/v1`,
      openrouter: `${up.url}/openrouter/api/v1`,
    },
    fetch: globalThis.fetch,
    now: () => new Date(),
    adminToken: "purser_admin_e2e",
  });
  const p = await listen(app.fetch);
  purserServer = p.server;
  purser = p.url;
});

afterAll(() => {
  purserServer.close();
  upstreamServer.close();
});

const newAgent = (name: string) =>
  createAgent(
    { store, inflight, now: () => new Date() },
    { name, owner: "Dana Ortiz" },
  );

const kill = (id: string) =>
  fetch(`${purser}/admin/agents/${id}/kill`, {
    method: "POST",
    headers: { authorization: "Bearer purser_admin_e2e" },
  });

describe("official SDKs through Purser", () => {
  it("OpenAI SDK: completes, streams and is metered", async () => {
    const { agent, key } = newAgent("openai-sdk");
    const client = new OpenAI({
      baseURL: `${purser}/openai/v1`,
      apiKey: key,
      maxRetries: 0,
    });
    const reply = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(reply.choices[0]?.message.content).toBe("Hello world");

    let text = "";
    const stream = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    for await (const chunk of stream)
      text += chunk.choices[0]?.delta.content ?? "";
    expect(text).toBe("Hello world");

    const usage = store.listUsage(agent.id);
    expect(usage).toHaveLength(2);
    expect(usage.every((u) => u.costUsd > 0)).toBe(true);
  });

  it("Anthropic SDK: completes, streams and is metered", async () => {
    const { agent, key } = newAgent("anthropic-sdk");
    const client = new Anthropic({
      baseURL: `${purser}/anthropic`,
      apiKey: key,
      maxRetries: 0,
    });
    const message = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(message.content[0]).toMatchObject({
      type: "text",
      text: "Hello world",
    });

    let text = "";
    const stream = client.messages.stream({
      model: "claude-sonnet-4-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    stream.on("text", (t) => (text += t));
    await stream.finalMessage();
    expect(text).toBe("Hello world");
    expect(store.listUsage(agent.id).map((u) => u.costUsd)).toEqual([
      expect.closeTo(2175e-6, 12),
      expect.closeTo(1500e-6, 12),
    ]);
  });

  it("OpenAI SDK pointed at OpenRouter: completes, streams and records the reported charge", async () => {
    const { agent, key } = newAgent("router-sdk");
    const client = new OpenAI({
      baseURL: `${purser}/openrouter/api/v1`,
      apiKey: key,
      maxRetries: 0,
    });
    const reply = await client.chat.completions.create({
      model: "anthropic/claude-sonnet-4.5",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(reply.choices[0]?.message.content).toBe("Hello world");

    let text = "";
    const stream = await client.chat.completions.create({
      model: "anthropic/claude-sonnet-4.5",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    for await (const chunk of stream)
      text += chunk.choices[0]?.delta.content ?? "";
    expect(text).toBe("Hello world");

    const usage = store.listUsage(agent.id);
    expect(usage.map((u) => [u.priced, u.costUsd])).toEqual([
      ["provider", OPENROUTER_COST],
      ["provider", OPENROUTER_COST],
    ]);
  });

  it("a kill stops a streaming SDK client in under a second, and the SDK sees why", async () => {
    const { agent, key } = newAgent("runaway");
    const client = new OpenAI({
      baseURL: `${purser}/openai/v1`,
      apiKey: key,
      maxRetries: 0,
    });
    const stream = await client.chat.completions.create(
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
      { headers: { "x-mock-slow": "100" } },
    );

    let chunks = 0;
    let killedAt = 0;
    try {
      for await (const _chunk of stream) {
        chunks++;
        if (chunks === 2) {
          killedAt = performance.now();
          await kill(agent.id);
        }
      }
    } catch {
      // The stream is cut: this is the expected way out of the loop.
    }
    const stoppedAfter = performance.now() - killedAt;
    expect(chunks).toBeLessThan(100);
    expect(stoppedAfter).toBeLessThan(1000);

    const refused = client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    await expect(refused).rejects.toMatchObject({
      status: 403,
      code: "agent_paused",
    });

    const anthropic = new Anthropic({
      baseURL: `${purser}/anthropic`,
      apiKey: key,
      maxRetries: 0,
    });
    await expect(
      anthropic.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
