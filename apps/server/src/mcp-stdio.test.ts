import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runMcpBridge } from "./mcp-stdio.js";
import { harness } from "./test/helpers.js";

async function run(
  lines: string[],
  fetchFn: typeof fetch,
): Promise<Record<string, unknown>[]> {
  const input = new PassThrough();
  const out: string[] = [];
  const done = runMcpBridge({
    url: "http://purser.test/mcp",
    key: "the-key",
    fetch: fetchFn,
    input,
    output: { write: (text: string) => out.push(text) },
  });
  for (const line of lines) input.write(`${line}\n`);
  input.end();
  await done;
  return out.map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("the stdio bridge", () => {
  it("carries messages to Purser with the agent's key", async () => {
    const h = harness();
    const agent = h.addAgent("bridged");
    const input = new PassThrough();
    const out: string[] = [];
    const done = runMcpBridge({
      url: "http://purser.test/mcp",
      key: agent.key,
      fetch: (url, init) => Promise.resolve(h.app.request(String(url), init)),
      input,
      output: { write: (text: string) => out.push(text) },
    });
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
    );
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    input.write("\n");
    input.end();
    await done;
    expect(out).toHaveLength(1);
    expect(out[0]?.endsWith("\n")).toBe(true);
    const answer = JSON.parse(out[0] ?? "") as {
      id: number;
      result: { tools: unknown[] };
    };
    expect(answer.id).toBe(1);
    expect(answer.result.tools.length).toBeGreaterThan(0);
  });

  it("reports bad input and an unreachable server as JSON-RPC errors", async () => {
    const out = await run(
      ["{nope", JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" })],
      () => Promise.reject(new Error("refused")),
    );
    const byId = (id: unknown) => out.find((m) => m.id === id);
    expect((byId(null)?.error as { code: number }).code).toBe(-32700);
    expect((byId(7)?.error as { message: string }).message).toContain(
      "Could not reach",
    );
  });

  it("puts the message's id on a refusal, and stays quiet for notifications", async () => {
    const out = await run(
      [
        JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      ],
      () =>
        Promise.resolve(
          Response.json(
            {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32001, message: "Bad key" },
            },
            { status: 401 },
          ),
        ),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe(9);
  });

  it("reports an answer that isn't JSON", async () => {
    const out = await run(
      [JSON.stringify({ jsonrpc: "2.0", id: 8, method: "ping" })],
      () => Promise.resolve(new Response("<html>", { status: 502 })),
    );
    expect((out[0]?.error as { message: string }).message).toContain("502");
  });
});
