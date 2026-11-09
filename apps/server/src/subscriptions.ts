import { createReadStream } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  costUsd,
  findPrice,
  totalInputTokens,
  type PriceTable,
} from "./pricing.js";
import { emptyUsage, type TokenUsage } from "./types.js";
import { anthropicUsage } from "./usage.js";

/**
 * Subscription usage, read from the logs that coding tools write on this
 * machine. Purser never relays subscription traffic and never touches a
 * subscription login: it only reads files the user's own tools already keep,
 * and prices the tokens at API rates to show what the plan is worth.
 */

export type SubscriptionTool = "claude-code" | "codex";

export const SUBSCRIPTION_TOOLS: SubscriptionTool[] = ["claude-code", "codex"];

/** One model response, as a coding tool logged it. */
export interface SubscriptionEntry {
  tool: SubscriptionTool;
  /** Unique per response, so a response logged more than once counts once. */
  id: string;
  at: string;
  model: string;
  usage: TokenUsage;
}

export interface SubscriptionRow extends TokenUsage {
  tool: SubscriptionTool;
  /** UTC day, "2026-11-07". */
  day: string;
  model: string;
  responses: number;
  /** What the same tokens would have cost at API prices. */
  apiEquivalentUsd: number;
  /** "table" when the model was in the price table, "fallback" when it was not. */
  priced: "table" | "fallback";
}

export interface SubscriptionReport {
  since: string;
  tools: {
    tool: SubscriptionTool;
    /** False when the tool's log directory does not exist on this machine. */
    found: boolean;
    responses: number;
    apiEquivalentUsd: number;
  }[];
  rows: SubscriptionRow[];
  apiEquivalentUsd: number;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;

const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null;

/**
 * A Claude Code log record, if it is a model response with usage. Claude
 * Code writes one record per content block, each repeating the response's
 * usage, so the id is the message id and request id together.
 */
export function claudeEntry(record: unknown): SubscriptionEntry | null {
  if (!isObject(record) || record.type !== "assistant") return null;
  const message = record.message;
  if (!isObject(message)) return null;
  const messageId = str(message.id);
  const model = str(message.model);
  const at = str(record.timestamp);
  // "<synthetic>" marks messages the tool wrote itself, with no model call.
  if (!messageId || !model || model === "<synthetic>" || !at) return null;
  const usage = anthropicUsage(message.usage);
  if (!usage) return null;
  return {
    tool: "claude-code",
    id: `${messageId}:${str(record.requestId) ?? ""}`,
    at,
    model,
    usage,
  };
}

/**
 * Codex token counts follow OpenAI's convention: input includes cached
 * input, and output includes reasoning.
 */
export function codexUsage(usage: unknown): TokenUsage | null {
  if (!isObject(usage)) return null;
  const cached = num(usage.cached_input_tokens);
  return {
    ...emptyUsage(),
    inputTokens: Math.max(0, num(usage.input_tokens) - cached),
    cacheReadTokens: cached,
    outputTokens: num(usage.output_tokens),
  };
}

/**
 * Reads one Codex session file. Newer Codex versions write a
 * `token_usage_record` per response; older ones only write `token_count`
 * events, which repeat, so those count only when the running total grows.
 * The model comes from the turn's `turn_context`.
 */
export class CodexSession {
  private model: string | null = null;
  private readonly turnModels = new Map<string, string>();
  private readonly records: SubscriptionEntry[] = [];
  private readonly counts: SubscriptionEntry[] = [];
  private lastTotal = 0;

  constructor(private readonly fileId: string) {}

  add(record: unknown): void {
    if (!isObject(record) || !isObject(record.payload)) return;
    const payload = record.payload;
    const at = str(record.timestamp);
    if (record.type === "turn_context") {
      const model = str(payload.model);
      if (model) {
        this.model = model;
        const turn = str(payload.turn_id);
        if (turn) this.turnModels.set(turn, model);
      }
      return;
    }
    if (record.type === "token_usage_record") {
      const usage = codexUsage(payload.usage);
      const id = str(payload.response_id);
      if (!usage || !id || !at) return;
      const turn = str(payload.turn_id);
      this.records.push({
        tool: "codex",
        id,
        at,
        model: (turn && this.turnModels.get(turn)) ?? this.model ?? "unknown",
        usage,
      });
      return;
    }
    if (
      record.type === "event_msg" &&
      payload.type === "token_count" &&
      isObject(payload.info)
    ) {
      const total = isObject(payload.info.total_token_usage)
        ? num(payload.info.total_token_usage.total_tokens)
        : 0;
      const usage = codexUsage(payload.info.last_token_usage);
      if (!usage || !at || total <= this.lastTotal) return;
      this.lastTotal = total;
      this.counts.push({
        tool: "codex",
        id: `${this.fileId}:${total}`,
        at,
        model: this.model ?? "unknown",
        usage,
      });
    }
  }

  entries(): SubscriptionEntry[] {
    return this.records.length > 0 ? this.records : this.counts;
  }
}

const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWrite5mTokens: a.cacheWrite5mTokens + b.cacheWrite5mTokens,
  cacheWrite1hTokens: a.cacheWrite1hTokens + b.cacheWrite1hTokens,
});

/**
 * Totals entries by tool, UTC day and model, counting each response once and
 * pricing each one at API rates. Entries before `since` (a UTC day) are left out.
 */
export function summarize(
  entries: Iterable<SubscriptionEntry>,
  prices: PriceTable,
  since: string,
  found: Partial<Record<SubscriptionTool, boolean>> = {},
): SubscriptionReport {
  const seen = new Set<string>();
  const rows = new Map<string, SubscriptionRow>();
  for (const entry of entries) {
    const day = entry.at.slice(0, 10);
    if (day < since) continue;
    const unique = `${entry.tool}|${entry.id}`;
    if (seen.has(unique)) continue;
    seen.add(unique);
    const price = findPrice(prices, entry.model, totalInputTokens(entry.usage));
    const key = `${entry.tool}|${day}|${entry.model}`;
    const row = rows.get(key) ?? {
      tool: entry.tool,
      day,
      model: entry.model,
      responses: 0,
      ...emptyUsage(),
      apiEquivalentUsd: 0,
      priced: price.matched === null ? "fallback" : "table",
    };
    rows.set(key, {
      ...row,
      ...addUsage(row, entry.usage),
      responses: row.responses + 1,
      apiEquivalentUsd:
        row.apiEquivalentUsd + costUsd(entry.usage, price.rates),
    });
  }
  const sorted = [...rows.values()].sort(
    (a, b) =>
      a.day.localeCompare(b.day) ||
      a.tool.localeCompare(b.tool) ||
      a.model.localeCompare(b.model),
  );
  const tools = SUBSCRIPTION_TOOLS.map((tool) => {
    const mine = sorted.filter((r) => r.tool === tool);
    return {
      tool,
      found: found[tool] ?? mine.length > 0,
      responses: mine.reduce((n, r) => n + r.responses, 0),
      apiEquivalentUsd: mine.reduce((n, r) => n + r.apiEquivalentUsd, 0),
    };
  });
  return {
    since,
    tools,
    rows: sorted,
    apiEquivalentUsd: tools.reduce((n, t) => n + t.apiEquivalentUsd, 0),
  };
}

/**
 * Every `.jsonl` file under `dir` changed on or after `since`, skipping
 * symbolic links. A missing directory yields nothing.
 */
export async function jsonlFiles(dir: string, since: Date): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    // lstat, so a symbolic link is never followed out of the log directory.
    const info = await lstat(path).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) files.push(...(await jsonlFiles(path, since)));
    else if (
      info.isFile() &&
      name.endsWith(".jsonl") &&
      info.mtime.getTime() >= since.getTime()
    ) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Streams a JSON Lines file record by record. Session logs can run to
 * hundreds of megabytes, so the file is never read whole. Lines that do not
 * contain any of `markers` are skipped before parsing; malformed lines are ignored.
 */
export async function* readJsonl(
  file: string,
  markers: string[],
): AsyncGenerator<unknown> {
  const lines = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!markers.some((m) => line.includes(m))) continue;
    try {
      yield JSON.parse(line) as unknown;
    } catch {
      // A torn or partial line, usually the one being written right now.
    }
  }
}

export interface SubscriptionDirs {
  /** Claude Code's data directory, normally ~/.claude. */
  claudeDir: string;
  /** Codex CLI's data directory, normally ~/.codex. */
  codexDir: string;
}

const exists = (path: string) =>
  stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );

/** Reads both tools' logs from `since` (a UTC day) and summarizes them. */
export async function scanSubscriptions(
  dirs: SubscriptionDirs,
  prices: PriceTable,
  since: string,
): Promise<SubscriptionReport> {
  const sinceDate = new Date(`${since}T00:00:00Z`);
  const entries: SubscriptionEntry[] = [];

  const claudeRoot = join(dirs.claudeDir, "projects");
  for (const file of await jsonlFiles(claudeRoot, sinceDate)) {
    for await (const record of readJsonl(file, ['"assistant"'])) {
      const entry = claudeEntry(record);
      if (entry) entries.push(entry);
    }
  }

  const codexRoots = [
    join(dirs.codexDir, "sessions"),
    join(dirs.codexDir, "archived_sessions"),
  ];
  for (const root of codexRoots) {
    for (const file of await jsonlFiles(root, sinceDate)) {
      const session = new CodexSession(file);
      for await (const record of readJsonl(file, [
        "turn_context",
        "token_usage_record",
        "token_count",
      ])) {
        session.add(record);
      }
      entries.push(...session.entries());
    }
  }

  return summarize(entries, prices, since, {
    "claude-code": await exists(claudeRoot),
    codex: (await Promise.all(codexRoots.map(exists))).some(Boolean),
  });
}
