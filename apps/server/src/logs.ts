import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./store.js";
import type { Agent } from "./types.js";

/**
 * Whose calls to keep: nobody's, every agent's, or only the agents marked
 * with `logCalls`.
 */
export type LogMode = "off" | "all" | "selected";

export interface LogSettings {
  mode: LogMode;
  /** Logs older than this many days are deleted. 1 to 365. */
  retentionDays: number;
  /** Each request and each response is cut to this many kilobytes. 1 to 1024. */
  maxKb: number;
}

export const DEFAULT_LOG_SETTINGS: LogSettings = {
  mode: "off",
  retentionDays: 30,
  maxKb: 64,
};

/** What a log list shows: everything but the bodies. */
export interface CallSummary {
  /** The usage record's id, so a usage row and its log share one id. */
  id: string;
  agentId: string;
  agentName: string;
  at: string;
  provider: string;
  endpoint: string;
  model: string;
  status: number;
  outcome: "complete" | "aborted" | "error";
  costUsd: number;
  durationMs: number;
  /** The start of the last thing the agent said. */
  requestPreview: string;
  /** The start of the answer. */
  responsePreview: string;
  /** True when a body was longer than the size limit and was cut. */
  truncated: boolean;
}

export interface CallEntry extends CallSummary {
  /** The JSON the agent sent, as it sent it. Keys are never logged: they travel in headers. */
  request: string;
  /** The raw response: JSON, or the server-sent event stream. */
  response: string;
  /** For a stream, the text of the answer pieced together from its events. */
  responseText?: string | undefined;
}

export interface CallPage {
  items: CallSummary[];
  /** Pass back as `before` for older entries. */
  next?: string | undefined;
}

const DAY_MS = 86_400_000;
const PREVIEW = 160;
const FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * Keeps the bodies of agent calls, when an admin turns it on, in one file per
 * UTC day under `<dataDir>/logs`, readable only by Purser's own user. Whole
 * days are deleted once they are older than the retention period. Without a
 * data directory everything stays in memory, for tests.
 */
export class CallLog {
  private current: LogSettings;
  private readonly memory: CallEntry[] = [];
  private readonly dir: string | null;

  constructor(
    private readonly dataDir: string | null,
    private readonly now: () => Date,
  ) {
    this.dir = dataDir ? join(dataDir, "logs") : null;
    this.current = { ...DEFAULT_LOG_SETTINGS, ...this.loadSettings() };
  }

  settings(): LogSettings {
    return { ...this.current };
  }

  /** Changes the settings, saves them and deletes anything now past retention. */
  update(patch: Partial<LogSettings>): LogSettings {
    this.current = { ...this.current, ...patch };
    if (this.dataDir) {
      mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      writeAtomic(
        join(this.dataDir, "settings.json"),
        JSON.stringify({ logging: this.current }, null, 2),
      );
    }
    this.purge();
    return this.settings();
  }

  shouldLog(agent: Agent): boolean {
    if (this.current.mode === "all") return true;
    return this.current.mode === "selected" && agent.logCalls === true;
  }

  /** The most a body may keep, in characters. */
  get maxChars(): number {
    return this.current.maxKb * 1024;
  }

  write(entry: CallEntry): void {
    if (!this.dir) {
      this.memory.push(entry);
      return;
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    appendFileSync(
      join(this.dir, `${entry.at.slice(0, 10)}.jsonl`),
      `${JSON.stringify(entry)}\n`,
      { mode: 0o600 },
    );
  }

  /**
   * Newest first. `before` is the `next` from an earlier page. Reads one day's
   * file at a time and stops as soon as the page is full.
   */
  list(options: {
    agentId?: string | undefined;
    before?: string | undefined;
    limit?: number | undefined;
  }): CallPage {
    const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 50)));
    const items: CallSummary[] = [];
    let more = false;
    for (const day of this.days()) {
      const entries = this.read(day);
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (!entry) continue;
        if (options.agentId && entry.agentId !== options.agentId) continue;
        if (options.before && !(cursor(entry) < options.before)) continue;
        if (items.length === limit) {
          more = true;
          break;
        }
        items.push(summarize(entry));
      }
      if (more) break;
    }
    const last = items.at(-1);
    return { items, next: more && last ? cursor(last) : undefined };
  }

  get(id: string): CallEntry | undefined {
    const needle = `"id":${JSON.stringify(id)}`;
    for (const day of this.days()) {
      if (this.dir) {
        const text = readFileSync(join(this.dir, `${day}.jsonl`), "utf8");
        if (!text.includes(needle)) continue;
      }
      const found = this.read(day).find((e) => e.id === id);
      if (found) return found;
    }
    return undefined;
  }

  /** Deletes whole days older than the retention period. Returns how many entries or files went. */
  purge(): number {
    const cutoff = new Date(
      this.now().getTime() - this.current.retentionDays * DAY_MS,
    )
      .toISOString()
      .slice(0, 10);
    if (!this.dir) {
      const before = this.memory.length;
      const keep = this.memory.filter((e) => e.at.slice(0, 10) >= cutoff);
      this.memory.length = 0;
      this.memory.push(...keep);
      return before - keep.length;
    }
    let removed = 0;
    for (const day of this.days()) {
      if (day < cutoff) {
        rmSync(join(this.dir, `${day}.jsonl`), { force: true });
        removed++;
      }
    }
    return removed;
  }

  /** Days with entries, newest first. */
  private days(): string[] {
    if (!this.dir) {
      return [...new Set(this.memory.map((e) => e.at.slice(0, 10)))]
        .sort()
        .reverse();
    }
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .map((name) => FILE.exec(name)?.[1])
      .filter((day): day is string => day !== undefined)
      .sort()
      .reverse();
  }

  private read(day: string): CallEntry[] {
    if (!this.dir) return this.memory.filter((e) => e.at.startsWith(day));
    const out: CallEntry[] = [];
    const file = join(this.dir, `${day}.jsonl`);
    if (!existsSync(file)) return out;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        out.push(JSON.parse(line) as CallEntry);
      } catch {
        // A line torn by a crash mid-write.
      }
    }
    return out;
  }

  private loadSettings(): Partial<LogSettings> {
    if (!this.dataDir) return {};
    const file = join(this.dataDir, "settings.json");
    if (!existsSync(file)) return {};
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as {
        logging?: Partial<LogSettings>;
      };
      return saved.logging ?? {};
    } catch {
      return {};
    }
  }
}

const cursor = (e: { at: string; id: string }) => `${e.at}|${e.id}`;

function summarize(entry: CallEntry): CallSummary {
  const {
    request: _request,
    response: _response,
    responseText: _text,
    ...summary
  } = entry;
  return summary;
}

/** Cuts text to `max` characters, saying whether it had to. */
export function clip(text: string, max: number): [string, boolean] {
  return text.length > max ? [text.slice(0, max), true] : [text, false];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The text of a message's content, which may be a string or a list of parts. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        isObject(part) && typeof part.text === "string" ? part.text : "",
      )
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

const oneLine = (text: string) =>
  text.replace(/\s+/g, " ").trim().slice(0, PREVIEW);

/** The last thing the agent said: the last message, or the `input` of a Responses call. */
export function requestPreview(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isObject(parsed)) return "";
    if (Array.isArray(parsed.messages)) {
      const last: unknown = parsed.messages.at(-1);
      if (isObject(last)) return oneLine(contentText(last.content));
    }
    if (typeof parsed.input === "string") return oneLine(parsed.input);
    if (Array.isArray(parsed.input)) {
      const last: unknown = parsed.input.at(-1);
      if (isObject(last)) return oneLine(contentText(last.content));
    }
    if (typeof parsed.prompt === "string") return oneLine(parsed.prompt);
  } catch {
    // Not JSON.
  }
  return "";
}

/** The answer's text from a JSON response: chat, messages or responses shape. */
export function responseTextFromJson(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isObject(parsed)) return "";
    if (Array.isArray(parsed.choices)) {
      const first: unknown = parsed.choices[0];
      if (isObject(first) && isObject(first.message)) {
        return contentText(first.message.content);
      }
    }
    if (Array.isArray(parsed.content)) return contentText(parsed.content);
    if (typeof parsed.output_text === "string") return parsed.output_text;
    if (Array.isArray(parsed.output)) {
      return parsed.output
        .map((item) => (isObject(item) ? contentText(item.content) : ""))
        .join("");
    }
    if (isObject(parsed.error) && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
  } catch {
    // Not JSON.
  }
  return "";
}

/**
 * Pieces the answer together from stream events: chat completion deltas,
 * Anthropic text deltas and Responses API text deltas.
 */
export class StreamText {
  private parts: string[] = [];
  private length = 0;

  constructor(private readonly max: number) {}

  add(event: unknown): void {
    if (!isObject(event) || this.length >= this.max) return;
    let piece = "";
    if (Array.isArray(event.choices)) {
      const first: unknown = event.choices[0];
      if (isObject(first) && isObject(first.delta)) {
        piece = contentText(first.delta.content);
      }
    } else if (
      event.type === "content_block_delta" &&
      isObject(event.delta) &&
      typeof event.delta.text === "string"
    ) {
      piece = event.delta.text;
    } else if (
      event.type === "response.output_text.delta" &&
      typeof event.delta === "string"
    ) {
      piece = event.delta;
    }
    if (piece) {
      this.parts.push(piece);
      this.length += piece.length;
    }
  }

  get text(): string {
    return this.parts.join("").slice(0, this.max);
  }
}

export const preview = oneLine;
