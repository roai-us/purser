import { createInterface } from "node:readline";

export interface BridgeOptions {
  /** Purser's MCP address, such as http://127.0.0.1:4141/mcp. */
  url: string;
  key: string;
  fetch: typeof fetch;
  input: NodeJS.ReadableStream;
  output: { write(text: string): unknown };
}

/**
 * For MCP clients that only start local programs: reads messages from stdin,
 * one per line, posts each to Purser, and writes the answers to stdout. Answers
 * can come back out of order, which MCP allows, so a slow model call doesn't
 * hold up anything else.
 */
export async function runMcpBridge(options: BridgeOptions): Promise<void> {
  const send = (value: unknown) =>
    options.output.write(`${JSON.stringify(value)}\n`);
  const failure = (id: unknown, code: number, message: string) =>
    send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  const forward = async (line: string): Promise<void> => {
    let message: { id?: unknown };
    try {
      message = JSON.parse(line) as { id?: unknown };
    } catch {
      failure(null, -32700, "The message must be JSON.");
      return;
    }
    try {
      const response = await options.fetch(options.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.key}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: line,
      });
      if (response.status === 202) return;
      const text = await response.text();
      try {
        const answer = JSON.parse(text) as { id?: unknown };
        // A refused notification has nobody waiting for the answer.
        if (message.id === undefined) return;
        // Purser refuses a bad key before it reads the message, so the answer
        // has no id of its own, and the client needs one to match it up.
        send({ ...answer, id: answer.id ?? message.id });
      } catch {
        failure(
          message.id,
          -32000,
          `Purser answered with status ${response.status}.`,
        );
      }
    } catch {
      failure(message.id, -32000, `Could not reach Purser at ${options.url}.`);
    }
  };

  const running = new Set<Promise<void>>();
  for await (const line of createInterface({ input: options.input })) {
    if (line.trim() === "") continue;
    const task = forward(line).finally(() => running.delete(task));
    running.add(task);
  }
  await Promise.all(running);
}
