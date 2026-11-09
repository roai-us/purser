import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PRICES } from "./prices.js";
import {
  claudeEntry,
  CodexSession,
  codexUsage,
  jsonlFiles,
  readJsonl,
  scanSubscriptions,
  summarize,
  type SubscriptionEntry,
} from "./subscriptions.js";
import { ADMIN_TOKEN, harness } from "./test/helpers.js";
import { emptyUsage } from "./types.js";

/** Synthetic records in the shape Claude Code and Codex write. No real logs. */
const claudeRecord = (
  id: string,
  extra: { model?: string; at?: string; requestId?: string } = {},
) => ({
  type: "assistant",
  timestamp: extra.at ?? "2026-11-05T10:00:00.000Z",
  requestId: extra.requestId ?? `req_${id}`,
  sessionId: "s1",
  message: {
    id: `msg_${id}`,
    type: "message",
    role: "assistant",
    model: extra.model ?? "claude-sonnet-4-5",
    content: [{ type: "text", text: "synthetic" }],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 200,
      cache_creation: {
        ephemeral_5m_input_tokens: 200,
        ephemeral_1h_input_tokens: 0,
      },
    },
  },
});

const codexTokens = (input: number, cached: number, output: number) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  reasoning_output_tokens: 0,
  total_tokens: input + output,
});

const lines = (...records: unknown[]) =>
  records
    .map((r) => (typeof r === "string" ? r : JSON.stringify(r)))
    .join("\n") + "\n";

function fixtureDirs() {
  const root = mkdtempSync(join(tmpdir(), "purser-subs-"));
  const claudeDir = join(root, "claude");
  const codexDir = join(root, "codex");
  const project = join(claudeDir, "projects", "project-a");
  mkdirSync(join(project, "subagents"), { recursive: true });
  // One response written as two content-block records, plus a later one,
  // a synthetic message, a user record and a torn line.
  writeFileSync(
    join(project, "session-1.jsonl"),
    lines(
      claudeRecord("a"),
      claudeRecord("a"),
      claudeRecord("b", { at: "2026-11-06T09:00:00.000Z" }),
      claudeRecord("c", { model: "<synthetic>" }),
      { type: "user", timestamp: "2026-11-05T10:00:00.000Z", message: {} },
      '{"type":"assistant", "torn',
    ),
  );
  writeFileSync(
    join(project, "subagents", "agent-1.jsonl"),
    lines(claudeRecord("d", { at: "2026-10-30T09:00:00.000Z" })),
  );

  const day = join(codexDir, "sessions", "2026", "11", "05");
  mkdirSync(day, { recursive: true });
  // A newer session: one usage record per response.
  writeFileSync(
    join(day, "rollout-new.jsonl"),
    lines(
      {
        type: "turn_context",
        timestamp: "2026-11-05T11:00:00.000Z",
        payload: { model: "gpt-5.4", turn_id: "t1" },
      },
      {
        type: "token_usage_record",
        timestamp: "2026-11-05T11:00:01.000Z",
        payload: {
          response_id: "resp_1",
          turn_id: "t1",
          usage: codexTokens(1000, 400, 100),
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-11-05T11:00:01.000Z",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: codexTokens(1000, 400, 100),
            total_token_usage: codexTokens(1000, 400, 100),
          },
        },
      },
    ),
  );
  // An older session: only repeating token_count events.
  writeFileSync(
    join(day, "rollout-old.jsonl"),
    lines(
      {
        type: "turn_context",
        timestamp: "2026-11-05T12:00:00.000Z",
        payload: { model: "gpt-5.4" },
      },
      ...[1, 1, 2].map((n) => ({
        type: "event_msg",
        timestamp: "2026-11-05T12:00:0" + String(n) + ".000Z",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: codexTokens(500, 0, 50),
            total_token_usage: codexTokens(500 * n, 0, 50 * n),
          },
        },
      })),
    ),
  );
  return { root, claudeDir, codexDir };
}

describe("reading Claude Code logs", () => {
  it("takes model responses with usage and ignores everything else", () => {
    const entry = claudeEntry(claudeRecord("a"));
    expect(entry).toMatchObject({
      tool: "claude-code",
      id: "msg_a:req_a",
      model: "claude-sonnet-4-5",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 1000,
        cacheWrite5mTokens: 200,
      },
    });
    for (const record of [
      null,
      { type: "user" },
      { type: "assistant" },
      { type: "assistant", timestamp: "x", message: { id: "m", model: "x" } },
      claudeRecord("z", { model: "<synthetic>" }),
      { ...claudeRecord("z"), timestamp: undefined },
    ]) {
      expect(claudeEntry(record)).toBeNull();
    }
    const noRequest = { ...claudeRecord("y"), requestId: undefined };
    expect(claudeEntry(noRequest)?.id).toBe("msg_y:");
  });
});

describe("reading Codex logs", () => {
  it("splits cached input out of the input count", () => {
    expect(codexUsage(codexTokens(1000, 400, 100))).toEqual({
      ...emptyUsage(),
      inputTokens: 600,
      cacheReadTokens: 400,
      outputTokens: 100,
    });
    expect(codexUsage("nope")).toBeNull();
  });

  it("prefers usage records and maps each to its turn's model", () => {
    const s = new CodexSession("f");
    s.add({
      type: "turn_context",
      timestamp: "t",
      payload: { model: "gpt-5.4", turn_id: "t1" },
    });
    s.add({
      type: "turn_context",
      timestamp: "t",
      payload: { model: "gpt-5.4-mini", turn_id: "t2" },
    });
    const record = (turn: string, id: string) => ({
      type: "token_usage_record",
      timestamp: "2026-11-05T00:00:00Z",
      payload: { response_id: id, turn_id: turn, usage: codexTokens(10, 0, 1) },
    });
    s.add(record("t1", "r1"));
    s.add(record("t9", "r2"));
    s.add({ type: "token_usage_record", payload: { usage: {} } });
    s.add({ type: "turn_context", payload: {} });
    s.add({ type: "event_msg", payload: { type: "token_count", info: null } });
    s.add(null);
    expect(s.entries().map((e) => [e.id, e.model])).toEqual([
      ["r1", "gpt-5.4"],
      ["r2", "gpt-5.4-mini"],
    ]);
  });

  it("counts token_count events only when the running total grows", () => {
    const s = new CodexSession("file");
    const count = (total: number, last: unknown = codexTokens(5, 0, 5)) => ({
      type: "event_msg",
      timestamp: "2026-11-05T00:00:00Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: last,
          total_token_usage: { total_tokens: total },
        },
      },
    });
    s.add(count(10));
    s.add(count(10));
    s.add(count(20));
    s.add(count(30, null));
    s.add({
      type: "event_msg",
      timestamp: "2026-11-05T00:00:00Z",
      payload: {
        type: "token_count",
        info: { last_token_usage: codexTokens(1, 0, 1) },
      },
    });
    expect(s.entries().map((e) => [e.id, e.model])).toEqual([
      ["file:10", "unknown"],
      ["file:20", "unknown"],
    ]);
  });
});

describe("summarizing", () => {
  const entry = (
    id: string,
    model: string,
    at = "2026-11-05T10:00:00Z",
  ): SubscriptionEntry => ({
    tool: "claude-code",
    id,
    at,
    model,
    usage: { ...emptyUsage(), inputTokens: 1_000_000 },
  });

  it("counts each response once, by day and model, at API prices", () => {
    const report = summarize(
      [
        entry("1", "claude-sonnet-4-5"),
        entry("1", "claude-sonnet-4-5"),
        entry("2", "claude-sonnet-4-5"),
        entry("3", "mystery-model"),
        entry("4", "claude-sonnet-4-5", "2026-10-31T23:59:59Z"),
      ],
      DEFAULT_PRICES,
      "2026-11-01",
    );
    expect(report.rows).toHaveLength(2);
    expect(report.rows[0]).toMatchObject({
      model: "claude-sonnet-4-5",
      responses: 2,
      inputTokens: 2_000_000,
      apiEquivalentUsd: 6,
      priced: "table",
    });
    expect(report.rows[1]).toMatchObject({
      model: "mystery-model",
      priced: "fallback",
      apiEquivalentUsd: DEFAULT_PRICES.fallback.input,
    });
    expect(report.tools).toEqual([
      {
        tool: "claude-code",
        found: true,
        responses: 3,
        apiEquivalentUsd: 6 + DEFAULT_PRICES.fallback.input,
      },
      { tool: "codex", found: false, responses: 0, apiEquivalentUsd: 0 },
    ]);
  });
});

describe("scanning the log directories", () => {
  it("reads both tools, deduplicates and leaves out older days", async () => {
    const { claudeDir, codexDir } = fixtureDirs();
    const report = await scanSubscriptions(
      { claudeDir, codexDir },
      DEFAULT_PRICES,
      "2026-11-01",
    );
    const claude = report.rows.filter((r) => r.tool === "claude-code");
    expect(claude.map((r) => [r.day, r.responses])).toEqual([
      ["2026-11-05", 1],
      ["2026-11-06", 1],
    ]);
    // 100 x $3 + 50 x $15 + 1000 x $0.30 + 200 x $3.75, per million tokens
    expect(claude[0]?.apiEquivalentUsd).toBeCloseTo(2100e-6, 12);

    const codex = report.rows.filter((r) => r.tool === "codex");
    expect(codex).toHaveLength(1);
    expect(codex[0]).toMatchObject({
      model: "gpt-5.4",
      responses: 3,
      inputTokens: 600 + 500 + 500,
      cacheReadTokens: 400,
      outputTokens: 100 + 50 + 50,
      priced: "table",
    });
    expect(report.tools.every((t) => t.found)).toBe(true);
    expect(report.apiEquivalentUsd).toBeGreaterThan(0);
  });

  it("reports a tool that is not installed as not found", async () => {
    const root = mkdtempSync(join(tmpdir(), "purser-empty-"));
    const report = await scanSubscriptions(
      { claudeDir: join(root, "none"), codexDir: join(root, "none") },
      DEFAULT_PRICES,
      "2026-11-01",
    );
    expect(report.tools.map((t) => t.found)).toEqual([false, false]);
    expect(report.rows).toEqual([]);
  });

  it("skips files untouched since the start day and never follows links", async () => {
    const { root, claudeDir } = fixtureDirs();
    const project = join(claudeDir, "projects", "project-a");
    const old = join(project, "old.jsonl");
    writeFileSync(old, lines(claudeRecord("old")));
    utimesSync(old, new Date("2026-01-01"), new Date("2026-01-01"));
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.jsonl"), lines(claudeRecord("x")));
    symlinkSync(outside, join(project, "link"));
    const files = await jsonlFiles(
      join(claudeDir, "projects"),
      new Date("2026-11-01T00:00:00Z"),
    );
    expect(files.map((f) => f.slice(project.length + 1)).sort()).toEqual([
      "session-1.jsonl",
      "subagents/agent-1.jsonl",
    ]);
  });

  it("streams records, skipping lines without a marker and torn lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "purser-jsonl-"));
    const file = join(dir, "a.jsonl");
    writeFileSync(file, lines({ a: "keep" }, { b: 1 }, '{"a": "keep'));
    const out: unknown[] = [];
    for await (const record of readJsonl(file, ['"a"'])) out.push(record);
    expect(out).toEqual([{ a: "keep" }]);
  });
});

describe("subscriptions admin API", () => {
  it("needs the admin token, is off unless configured, and checks the day", async () => {
    const h = harness();
    expect((await h.app.request("/admin/subscriptions")).status).toBe(401);
    expect((await h.admin("GET", "/subscriptions")).status).toBe(404);

    const { claudeDir, codexDir } = fixtureDirs();
    const on = harness({ subscriptionDirs: { claudeDir, codexDir } });
    const bad = await on.admin("GET", "/subscriptions?since=last-week");
    expect(bad.status).toBe(400);
    const res = await on.app.request("/admin/subscriptions?since=2026-11-06", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { since: string; rows: unknown[] };
    expect(body.since).toBe("2026-11-06");
    expect(body.rows).toHaveLength(1);

    // With no day given, the report starts on the first of this UTC month.
    const month = (await (await on.admin("GET", "/subscriptions")).json()) as {
      since: string;
    };
    expect(month.since).toBe("2026-11-01");
  });
});
