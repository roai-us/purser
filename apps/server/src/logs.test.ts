import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CallLog,
  requestPreview,
  responseTextFromJson,
  StreamText,
  type CallEntry,
} from "./logs.js";
import { chatBody, harness } from "./test/helpers.js";
import type { PublicAgent } from "./types.js";

const post = (key: string, body: string) => ({
  method: "POST",
  key,
  body,
});

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

describe("call log through the gateway", () => {
  it("keeps nothing until an admin turns it on", async () => {
    const h = harness();
    const { key } = h.addAgent();
    await h.call("/openai/v1/chat/completions", post(key, chatBody()));
    expect(h.store.listUsage()[0]?.logged).toBeUndefined();
    const page = await json<{ items: unknown[]; settings: { mode: string } }>(
      h.admin("GET", "/logs"),
    );
    expect(page.items).toEqual([]);
    expect(page.settings.mode).toBe("off");
  });

  it("keeps request and response for every agent, without keys, and records each read", async () => {
    const h = harness();
    const { key } = h.addAgent();
    const set = await h.admin("PUT", "/settings/logging", { mode: "all" });
    expect(set.status).toBe(200);
    await h.call(
      "/openai/v1/chat/completions",
      post(
        key,
        chatBody({ messages: [{ role: "user", content: "Summarise Q3" }] }),
      ),
    );
    const usage = h.store.listUsage()[0];
    expect(usage?.logged).toBe(true);

    const page = await json<{ items: CallEntry[] }>(h.admin("GET", "/logs"));
    expect(page.items).toHaveLength(1);
    const summary = page.items[0];
    expect(summary).toMatchObject({
      id: usage?.id,
      agentName: "support-bot",
      requestPreview: "Summarise Q3",
      responsePreview: "Hello world",
      truncated: false,
    });
    expect(summary).not.toHaveProperty("request");

    const entry = await json<CallEntry>(
      h.admin("GET", `/logs/${usage?.id ?? ""}`),
    );
    expect(JSON.parse(entry.request)).toMatchObject({ model: "gpt-4o-mini" });
    expect(JSON.parse(entry.response)).toHaveProperty("choices");
    expect(JSON.stringify(entry)).not.toContain(key);
    expect(h.store.auditLog().at(-1)).toMatchObject({
      type: "log.viewed",
      detail: { by: "admin", call: usage?.id },
    });
    expect((await h.admin("GET", "/logs/nope")).status).toBe(404);
  });

  it("pieces a streamed answer together", async () => {
    const h = harness();
    const { key } = h.addAgent();
    await h.admin("PUT", "/settings/logging", { mode: "all" });
    const res = await h.call(
      "/openai/v1/chat/completions",
      post(key, chatBody({ stream: true })),
    );
    await res.text();
    const page = await json<{ items: CallEntry[] }>(h.admin("GET", "/logs"));
    const entry = await json<CallEntry>(
      h.admin("GET", `/logs/${page.items[0]?.id ?? ""}`),
    );
    expect(entry.response).toContain("data:");
    expect(entry.responseText).toBe("Hello world");
    expect(entry.responsePreview).toBe("Hello world");
  });

  it("can keep only the agents an admin picks", async () => {
    const h = harness();
    const a = h.addAgent("chosen");
    const b = h.addAgent("other");
    await h.admin("PUT", "/settings/logging", { mode: "selected" });
    const patched = await json<PublicAgent>(
      h.admin("PATCH", "/agents/chosen", { logCalls: true }),
    );
    expect(patched.logCalls).toBe(true);
    await h.call("/openai/v1/chat/completions", post(a.key, chatBody()));
    await h.call("/openai/v1/chat/completions", post(b.key, chatBody()));
    const page = await json<{ items: CallEntry[] }>(h.admin("GET", "/logs"));
    expect(page.items.map((e) => e.agentName)).toEqual(["chosen"]);
    const mine = await json<{ items: CallEntry[] }>(
      h.admin("GET", "/logs?agent=other"),
    );
    expect(mine.items).toEqual([]);
    expect((await h.admin("GET", "/logs?agent=ghost")).status).toBe(404);
  });

  it("cuts bodies to the size limit and says so", async () => {
    const h = harness();
    const { key } = h.addAgent();
    await h.admin("PUT", "/settings/logging", { mode: "all", maxKb: 1 });
    await h.call(
      "/openai/v1/chat/completions",
      post(
        key,
        chatBody({ messages: [{ role: "user", content: "x".repeat(5000) }] }),
      ),
    );
    const page = await json<{ items: CallEntry[] }>(h.admin("GET", "/logs"));
    const entry = await json<CallEntry>(
      h.admin("GET", `/logs/${page.items[0]?.id ?? ""}`),
    );
    expect(entry.truncated).toBe(true);
    expect(entry.request).toHaveLength(1024);
  });

  it("checks settings and records changes", async () => {
    const h = harness();
    expect(
      (await h.admin("PUT", "/settings/logging", { mode: "everything" }))
        .status,
    ).toBe(400);
    expect(
      (await h.admin("PUT", "/settings/logging", { retentionDays: 0 })).status,
    ).toBe(400);
    const saved = await json<{ logging: { retentionDays: number } }>(
      h.admin("PUT", "/settings/logging", { retentionDays: 7 }),
    );
    expect(saved.logging.retentionDays).toBe(7);
    expect(
      await json<{ logging: unknown }>(h.admin("GET", "/settings")),
    ).toEqual({ logging: { mode: "off", retentionDays: 7, maxKb: 64 } });
    expect(h.store.auditLog().at(-1)).toMatchObject({
      type: "settings.changed",
      detail: { setting: "logging", to: { retentionDays: 7 } },
    });
  });
});

function entry(id: string, at: string, agentId = "agt_1"): CallEntry {
  return {
    id,
    agentId,
    agentName: agentId,
    at,
    provider: "openai",
    endpoint: "chat.completions",
    model: "m",
    status: 200,
    outcome: "complete",
    costUsd: 0.001,
    durationMs: 10,
    requestPreview: "",
    responsePreview: "",
    truncated: false,
    request: "{}",
    response: "{}",
  };
}

describe("call log on disk", () => {
  it("keeps one private file per day and deletes days past retention", () => {
    const dir = mkdtempSync(join(tmpdir(), "purser-logs-"));
    let now = new Date("2026-11-08T12:00:00Z");
    const log = new CallLog(dir, () => now);
    log.update({ mode: "all", retentionDays: 2 });
    log.write(entry("a", "2026-11-05T10:00:00.000Z"));
    log.write(entry("b", "2026-11-07T10:00:00.000Z"));
    log.write(entry("c", "2026-11-08T10:00:00.000Z"));
    log.write(entry("d", "2026-11-08T11:00:00.000Z", "agt_2"));
    expect(statSync(join(dir, "logs", "2026-11-08.jsonl")).mode & 0o077).toBe(
      0,
    );

    // Settings survive a restart.
    const reopened = new CallLog(dir, () => now);
    expect(reopened.settings()).toEqual({
      mode: "all",
      retentionDays: 2,
      maxKb: 64,
    });

    // Newest first, a page at a time, across files.
    const first = reopened.list({ limit: 2 });
    expect(first.items.map((e) => e.id)).toEqual(["d", "c"]);
    const second = reopened.list({ limit: 2, before: first.next });
    expect(second.items.map((e) => e.id)).toEqual(["b", "a"]);
    expect(second.next).toBeUndefined();
    expect(reopened.list({ agentId: "agt_2" }).items).toHaveLength(1);
    expect(reopened.get("b")?.at).toBe("2026-11-07T10:00:00.000Z");
    expect(reopened.get("zzz")).toBeUndefined();

    expect(reopened.purge()).toBe(1);
    expect(readdirSync(join(dir, "logs")).sort()).toEqual([
      "2026-11-07.jsonl",
      "2026-11-08.jsonl",
    ]);
    now = new Date("2026-11-10T12:00:00Z");
    reopened.update({ retentionDays: 1 });
    expect(readdirSync(join(dir, "logs"))).toEqual([]);
    expect(reopened.list({}).items).toEqual([]);
  });

  it("purges in memory too", () => {
    const log = new CallLog(null, () => new Date("2026-11-08T12:00:00Z"));
    log.update({ retentionDays: 1 });
    log.write(entry("old", "2026-11-01T00:00:00.000Z"));
    log.write(entry("new", "2026-11-08T00:00:00.000Z"));
    expect(log.purge()).toBe(1);
    expect(log.list({}).items.map((e) => e.id)).toEqual(["new"]);
  });
});

describe("previews", () => {
  it("finds the last thing said in each request shape", () => {
    expect(
      requestPreview(
        JSON.stringify({
          messages: [
            { role: "system", content: "Be brief" },
            { role: "user", content: [{ type: "text", text: "Hello  there" }] },
          ],
        }),
      ),
    ).toBe("Hello there");
    expect(requestPreview(JSON.stringify({ input: "Write a poem" }))).toBe(
      "Write a poem",
    );
    expect(
      requestPreview(
        JSON.stringify({ input: [{ role: "user", content: "Responses" }] }),
      ),
    ).toBe("Responses");
    expect(requestPreview(JSON.stringify({ prompt: "Legacy" }))).toBe("Legacy");
    expect(requestPreview("not json")).toBe("");
    expect(requestPreview("[]")).toBe("");
  });

  it("finds the answer in each response shape", () => {
    expect(
      responseTextFromJson(
        JSON.stringify({ content: [{ type: "text", text: "Claude-style" }] }),
      ),
    ).toBe("Claude-style");
    expect(responseTextFromJson(JSON.stringify({ output_text: "Out" }))).toBe(
      "Out",
    );
    expect(
      responseTextFromJson(
        JSON.stringify({
          output: [{ content: [{ type: "output_text", text: "Parts" }] }],
        }),
      ),
    ).toBe("Parts");
    expect(
      responseTextFromJson(JSON.stringify({ error: { message: "Nope" } })),
    ).toBe("Nope");
    expect(responseTextFromJson("oops")).toBe("");
  });

  it("assembles stream text up to its limit", () => {
    const text = new StreamText(8);
    text.add({ type: "content_block_delta", delta: { text: "Hello " } });
    text.add({ type: "response.output_text.delta", delta: "world" });
    text.add({ type: "response.output_text.delta", delta: "!!!" });
    text.add("junk");
    expect(text.text).toBe("Hello wo");
  });
});

describe("one-time limit raise", () => {
  it("turns an agent at its daily limit back on for the rest of the day", async () => {
    const h = harness();
    const { key } = h.addAgent("busy", { dailyUsd: 0.000001 });
    await h.call("/openai/v1/chat/completions", post(key, chatBody()));
    const blocked = await h.call(
      "/openai/v1/chat/completions",
      post(key, chatBody()),
    );
    expect(blocked.status).toBe(403);
    expect(await blocked.text()).toContain("can raise it once in Purser");
    expect(
      (await json<PublicAgent>(h.admin("GET", "/agents/busy"))).state,
    ).toBe("at_limit");

    const res = await h.admin("POST", "/agents/busy/raise-limit", {
      window: "day",
      amountUsd: 5,
      reason: "Quarter close",
    });
    expect(res.status).toBe(200);
    const { agent } = (await res.json()) as { agent: PublicAgent };
    expect(agent.state).toBe("running");
    expect(agent.raised).toEqual({ dailyUsd: 5 });
    expect(agent.limits.dailyUsd).toBe(0.000001);
    expect(agent).not.toHaveProperty("raises");
    expect(h.store.auditLog().at(-1)).toMatchObject({
      type: "agent.limit_raised",
      detail: { window: "day", amountUsd: 5, reason: "Quarter close" },
    });
    expect(
      (await h.call("/openai/v1/chat/completions", post(key, chatBody())))
        .status,
    ).toBe(200);

    // Tomorrow the raise has lapsed. Today's spend is zero, so it runs again,
    // and a fresh raise drops yesterday's from the record.
    h.clock.now = new Date("2026-11-08T12:00:00Z");
    const tomorrow = await json<PublicAgent>(h.admin("GET", "/agents/busy"));
    expect(tomorrow.raised).toEqual({});
    await h.admin("POST", "/agents/busy/raise-limit", {
      window: "month",
      amountUsd: 1,
    });
    expect(h.store.findByName("busy")?.raises).toHaveLength(1);
  });

  it("refuses a raise with no limit to raise, or a bad amount", async () => {
    const h = harness();
    h.addAgent("free", {});
    h.addAgent("capped", { monthlyUsd: 10 });
    const none = await h.admin("POST", "/agents/free/raise-limit", {
      window: "day",
      amountUsd: 5,
    });
    expect(none.status).toBe(400);
    expect(await none.text()).toContain("no daily limit");
    for (const body of [
      { window: "week", amountUsd: 5 },
      { window: "month", amountUsd: 0 },
      { window: "month", amountUsd: 5, extra: true },
    ]) {
      expect(
        (await h.admin("POST", "/agents/capped/raise-limit", body)).status,
      ).toBe(400);
    }
    expect(
      (
        await h.admin("POST", "/agents/ghost/raise-limit", {
          window: "day",
          amountUsd: 1,
        })
      ).status,
    ).toBe(404);
  });
});
