import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { newId, secretHint } from "./keys.js";
import {
  MailError,
  sendMail as nodemailerSend,
  type MailMessage,
  type SendMail,
  type SmtpSettings,
} from "./mail.js";
import { capFor } from "./policy.js";
import { writeAtomic, type SpendWindow, type Store } from "./store.js";
import type { Agent, AuditEvent, UsageRecord } from "./types.js";
import type { Vault } from "./vault.js";

/** Everything Purser can alert on. */
export const ALERT_TYPES = [
  "agent.near_limit",
  "agent.at_limit",
  "agent.spend_spike",
  "agent.stopped",
  "key.expiring",
  "key.expired",
  "workflow.stop",
  "request.waiting",
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export const ALERT_TYPE_WORDS: Record<AlertType, string> = {
  "agent.near_limit": "An agent is close to its spending limit",
  "agent.at_limit": "An agent reached its spending limit",
  "agent.spend_spike": "An agent is spending far more than usual",
  "agent.stopped": "An agent was stopped",
  "key.expiring": "An agent's key expires soon",
  "key.expired": "An agent's key expired",
  "workflow.stop": "A workflow crossed its stop line",
  "request.waiting": "A request is waiting for a decision",
};

export type Severity = "info" | "warning" | "critical";

const SEVERITY: Record<AlertType, Severity> = {
  "agent.near_limit": "info",
  "agent.at_limit": "warning",
  "agent.spend_spike": "warning",
  "agent.stopped": "info",
  "key.expiring": "info",
  "key.expired": "warning",
  "workflow.stop": "critical",
  "request.waiting": "info",
};

/** Where alerts go. Slack and Discord get messages in their own format. */
export type ChannelKind = "webhook" | "slack" | "discord" | "email";

export interface Channel {
  id: string;
  name: string;
  kind: ChannelKind;
  /** Alert types sent here. Empty means every type. */
  events: AlertType[];
  enabled: boolean;
  createdAt: string;
  /** For email: who gets the alerts. */
  to?: string[] | undefined;
}

export interface AlertSettings {
  /** near_limit fires at this share of a cap, in percent. */
  nearLimitPercent: number;
  /** spend_spike fires when today's spend is this many times the 7-day average... */
  spikeMultiple: number;
  /** ...and at least this many dollars. */
  spikeMinUsd: number;
  /** key.expiring fires this many days before a key expires. */
  keyExpiringDays: number;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  nearLimitPercent: 80,
  spikeMultiple: 3,
  spikeMinUsd: 5,
  keyExpiringDays: 7,
};

/** One alert, as it is sent and kept in the history. */
export interface Alert {
  id: string;
  type: AlertType;
  severity: Severity;
  at: string;
  title: string;
  text: string;
  /** Where to look in Purser. */
  url: string;
  /** How many events this alert stands for, when a burst was summed up. */
  count: number;
  data: Record<string, unknown>;
}

export interface Delivery {
  channelId: string;
  channelName: string;
  ok: boolean;
  attempts: number;
  status?: number | undefined;
  error?: string | undefined;
}

export interface AlertRecord extends Alert {
  deliveries: Delivery[];
}

/** A channel as the admin API shows it: never the URL, only a hint of it. */
export interface PublicChannel extends Channel {
  urlHint: string;
  signed: boolean;
  lastDelivery?:
    { at: string; ok: boolean; error?: string | undefined } | undefined;
}

export interface AlertsDeps {
  store: Store;
  vault: Vault;
  fetch: typeof fetch;
  now: () => Date;
  /** The address people reach Purser at, for links in alerts. */
  baseUrl: string;
  /** Waits between delivery attempts. Tests pass zeros. */
  retryDelaysMs?: number[] | undefined;
  /** How long events gather before they are sent, so a burst becomes one message. */
  batchMs?: number | undefined;
  /** Sends email. Tests pass their own. */
  sendMail?: SendMail | undefined;
}

/** The mail server as the admin API shows it: never the password. */
export interface PublicSmtp extends SmtpSettings {
  passwordSet: boolean;
}

interface Pending {
  type: AlertType;
  title: string;
  text: string;
  path: string;
  data: Record<string, unknown>;
  /** A name for this event in a summary of many: "support-bot". */
  label: string;
}

interface AlertsFile {
  settings: AlertSettings;
  channels: Channel[];
  smtp?: SmtpSettings | undefined;
}

/** More events of one type than this in one batch are summed up in one message. */
const SUMMARY_AFTER = 3;
const HISTORY_KEPT = 200;
/** Fired-once markers are forgotten after this long. */
const DEDUPE_DAYS = 40;
const DAY_MS = 86_400_000;
const TIMEOUT_MS = 5_000;

/** The vault entry holding a channel's URL. */
export const channelSecret = (id: string) => `__alert_${id}`;
/** The vault entry holding a webhook channel's signing secret. */
export const signingSecret = (id: string) => `__alert_sign_${id}`;
/** The vault entry holding the mail server's password. */
export const SMTP_SECRET = "__alert_smtp";

const money = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(n);

/**
 * A webhook URL must be https, so the secret in it isn't sent in the clear.
 * Plain http is allowed only to this computer, for testing.
 */
export function webhookProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "That is not a URL.";
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol === "http:" && local) return null;
  return "Use an https:// address.";
}

/**
 * Alerts: watches spend and the audit log, sweeps for keys about to expire and
 * workflows past their stop line, and sends what it finds to webhooks, Slack
 * and Discord. Sending never happens in the request path: events gather for a
 * moment, so a burst becomes one message, and each channel gets a few tries.
 */
export class Alerts {
  private settingsValue: AlertSettings = { ...DEFAULT_ALERT_SETTINGS };
  private channelsList: Channel[] = [];
  private smtpValue: SmtpSettings | undefined;
  private readonly history: AlertRecord[] = [];
  /** Markers for alerts that fire once, with when they fired. */
  private readonly fired = new Map<string, string>();
  private queue: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  /** Workflow ids whose stop line was crossed at the last sweep. */
  private readonly stopped = new Set<string>();

  constructor(
    private readonly deps: AlertsDeps,
    private readonly dataDir: string | null = null,
  ) {
    if (dataDir) this.load(dataDir);
    deps.store.subscribe({
      usage: (record) => this.onUsage(record),
      audit: (event) => this.onAudit(event),
    });
  }

  // Settings and channels

  settings(): AlertSettings {
    return { ...this.settingsValue };
  }

  setSettings(patch: Partial<AlertSettings>): AlertSettings {
    this.settingsValue = { ...this.settingsValue, ...patch };
    this.save();
    return this.settings();
  }

  /** The mail server email alerts go out through, if one is set up. */
  smtp(): PublicSmtp | null {
    if (!this.smtpValue) return null;
    return {
      ...this.smtpValue,
      passwordSet: Boolean(this.deps.vault.get(SMTP_SECRET)?.apiKey),
    };
  }

  /**
   * Sets up the mail server. A password left out keeps the saved one; an
   * empty one forgets it.
   */
  setSmtp(input: SmtpSettings & { password?: string | undefined }): PublicSmtp {
    const { password, ...settings } = input;
    this.smtpValue = settings;
    if (password === "") this.deps.vault.removeKey(SMTP_SECRET);
    else if (password !== undefined) {
      this.deps.vault.set(SMTP_SECRET, {
        apiKey: password,
        updatedAt: this.deps.now().toISOString(),
      });
    }
    this.save();
    return this.smtp() as PublicSmtp;
  }

  removeSmtp(): void {
    this.smtpValue = undefined;
    this.deps.vault.removeKey(SMTP_SECRET);
    this.save();
  }

  channels(): PublicChannel[] {
    return this.channelsList.map((c) => this.present(c));
  }

  getChannel(id: string): Channel | undefined {
    return this.channelsList.find((c) => c.id === id);
  }

  addChannel(input: {
    name: string;
    kind: ChannelKind;
    url?: string | undefined;
    to?: string[] | undefined;
    events: AlertType[];
  }): { channel: PublicChannel; signingSecret?: string | undefined } {
    const channel: Channel = {
      id: newId("ch"),
      name: input.name,
      kind: input.kind,
      events: input.events,
      enabled: true,
      createdAt: this.deps.now().toISOString(),
      ...(input.kind === "email" ? { to: input.to ?? [] } : {}),
    };
    if (input.kind !== "email") {
      this.deps.vault.set(channelSecret(channel.id), {
        apiKey: input.url ?? "",
        updatedAt: channel.createdAt,
      });
    }
    // A plain webhook is signed, so the receiver can tell it came from here.
    let secret: string | undefined;
    if (channel.kind === "webhook") {
      secret = `whsec_${randomBytes(24).toString("base64url")}`;
      this.deps.vault.set(signingSecret(channel.id), { apiKey: secret });
    }
    this.channelsList.push(channel);
    this.save();
    return { channel: this.present(channel), signingSecret: secret };
  }

  updateChannel(
    id: string,
    patch: {
      name?: string | undefined;
      url?: string | undefined;
      to?: string[] | undefined;
      events?: AlertType[] | undefined;
      enabled?: boolean | undefined;
    },
  ): PublicChannel {
    const current = this.getChannel(id);
    if (!current) throw new Error(`No channel ${id}.`);
    const next: Channel = {
      ...current,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.events === undefined ? {} : { events: patch.events }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.to === undefined || current.kind !== "email"
        ? {}
        : { to: patch.to }),
    };
    if (patch.url !== undefined && current.kind !== "email") {
      this.deps.vault.set(channelSecret(id), {
        apiKey: patch.url,
        updatedAt: this.deps.now().toISOString(),
      });
    }
    this.channelsList = this.channelsList.map((c) => (c.id === id ? next : c));
    this.save();
    return this.present(next);
  }

  removeChannel(id: string): void {
    this.channelsList = this.channelsList.filter((c) => c.id !== id);
    this.deps.vault.removeKey(channelSecret(id));
    this.deps.vault.removeKey(signingSecret(id));
    this.save();
  }

  /** The newest alerts first. */
  recent(limit = 50): AlertRecord[] {
    return this.history.slice(-limit).reverse();
  }

  // Watching

  private onUsage(record: UsageRecord): void {
    const agent = this.deps.store.getAgent(record.agentId);
    if (!agent) return;
    const now = new Date(record.at);
    for (const window of ["day", "month"] as const) {
      this.checkCap(agent, window, now);
    }
    this.checkSpike(agent, now);
  }

  private checkCap(agent: Agent, window: SpendWindow, now: Date): void {
    const cap = capFor(agent, window, now);
    if (cap === undefined || cap <= 0) return;
    const spent = this.deps.store.spend(agent.id, window, now);
    const period =
      window === "day"
        ? now.toISOString().slice(0, 10)
        : now.toISOString().slice(0, 7);
    const label = window === "day" ? "daily" : "monthly";
    const until = window === "day" ? "tomorrow" : "next month";
    const data = {
      agent: this.agentData(agent),
      window,
      period,
      spentUsd: spent,
      capUsd: cap,
    };
    if (spent >= cap) {
      if (!this.once(`at_limit|${agent.id}|${window}|${period}|${cap}`)) return;
      this.emit({
        type: "agent.at_limit",
        title: `${agent.name} reached its ${label} limit`,
        text: `${agent.name} (owner ${agent.owner}) has spent ${money(spent)} of its ${money(cap)} ${label} limit. Its calls are refused until ${until} (UTC), unless someone raises the limit.`,
        path: `/agents?agent=${encodeURIComponent(agent.id)}`,
        data,
        label: agent.name,
      });
    } else if (spent >= (cap * this.settingsValue.nearLimitPercent) / 100) {
      if (!this.once(`near_limit|${agent.id}|${window}|${period}|${cap}`)) {
        return;
      }
      this.emit({
        type: "agent.near_limit",
        title: `${agent.name} has used ${Math.floor((spent / cap) * 100)}% of its ${label} limit`,
        text: `${agent.name} (owner ${agent.owner}) has spent ${money(spent)} of its ${money(cap)} ${label} limit.`,
        path: `/agents?agent=${encodeURIComponent(agent.id)}`,
        data,
        label: agent.name,
      });
    }
  }

  private checkSpike(agent: Agent, now: Date): void {
    const { spikeMultiple, spikeMinUsd } = this.settingsValue;
    const today = this.deps.store.spend(agent.id, "day", now);
    if (today < spikeMinUsd) return;
    let total = 0;
    let daysWithSpend = 0;
    for (let i = 1; i <= 7; i++) {
      const spent = this.deps.store.spend(
        agent.id,
        "day",
        new Date(now.getTime() - i * DAY_MS),
      );
      total += spent;
      if (spent > 0) daysWithSpend++;
    }
    // A new agent has no normal yet to compare with.
    if (daysWithSpend < 3) return;
    const average = total / 7;
    if (today < average * spikeMultiple) return;
    const day = now.toISOString().slice(0, 10);
    if (!this.once(`spike|${agent.id}|${day}`)) return;
    this.emit({
      type: "agent.spend_spike",
      title: `${agent.name} is spending ${Math.round(today / average)} times its usual rate`,
      text: `${agent.name} (owner ${agent.owner}) has spent ${money(today)} today (UTC), against a 7-day average of ${money(average)} a day.`,
      path: `/agents?agent=${encodeURIComponent(agent.id)}`,
      data: {
        agent: this.agentData(agent),
        todayUsd: today,
        averageUsd: average,
      },
      label: agent.name,
    });
  }

  private onAudit(event: AuditEvent): void {
    const agent =
      event.agentId === undefined
        ? undefined
        : this.deps.store.getAgent(event.agentId);
    const detail = event.detail ?? {};
    if (event.type === "agent.paused" && agent) {
      const by = typeof detail.by === "string" ? detail.by : "someone";
      this.emit({
        type: "agent.stopped",
        title: `${agent.name} was stopped`,
        text: `${by} stopped ${agent.name} (owner ${agent.owner}). Its calls are refused until someone resumes it.`,
        path: `/agents?agent=${encodeURIComponent(agent.id)}`,
        data: { agent: this.agentData(agent), by },
        label: agent.name,
      });
    } else if (event.type === "key.expired" && agent) {
      this.emit({
        type: "key.expired",
        title: `${agent.name}'s key expired`,
        text: `${agent.name}'s key (owner ${agent.owner}) expired, so its calls are refused. Rotate the key and give the new one to the tool.`,
        path: `/agents?agent=${encodeURIComponent(agent.id)}`,
        data: { agent: this.agentData(agent) },
        label: agent.name,
      });
    } else if (event.type === "request.created") {
      this.onRequest(detail);
    }
  }

  /** The request may be approved on the spot by the rules; only a waiting one alerts. */
  private requestStatus: (id: string) => string | undefined = () => undefined;

  /** Tells Alerts how to look up a request, so it alerts only on waiting ones. */
  watchRequests(status: (id: string) => string | undefined): void {
    this.requestStatus = status;
  }

  private onRequest(detail: Record<string, unknown>): void {
    const id = typeof detail.request === "string" ? detail.request : "";
    // Rules can approve a request on the spot; check once it has settled.
    queueMicrotask(() => {
      if (this.requestStatus(id) !== "pending") return;
      const who = typeof detail.for === "string" ? detail.for : "someone";
      const what =
        detail.kind === "agent"
          ? `a new agent${typeof detail.name === "string" ? `, ${detail.name}` : ""}`
          : detail.kind === "raise"
            ? "more budget for an agent"
            : "a new service for an agent";
      this.emit({
        type: "request.waiting",
        title: `${who} is asking for ${what}`,
        text: `A request from ${who} for ${what} is waiting for a decision.`,
        path: "/approvals",
        data: { request: id, kind: detail.kind, by: who },
        label: who,
      });
    });
  }

  /**
   * Looks for keys about to expire and workflows past their stop line. Run on
   * start and every hour.
   */
  sweep(
    workflows: {
      id: string;
      name: string;
      verdict: string;
      stopRule: string;
    }[] = [],
  ): void {
    const now = this.deps.now();
    const soon = now.getTime() + this.settingsValue.keyExpiringDays * DAY_MS;
    for (const agent of this.deps.store.listAgents()) {
      if (agent.status !== "active" || agent.keyExpiresAt === undefined)
        continue;
      const at = Date.parse(agent.keyExpiresAt);
      if (at <= now.getTime() || at > soon) continue;
      if (!this.once(`expiring|${agent.id}|${agent.keyHash.slice(0, 16)}`))
        continue;
      const days = Math.max(1, Math.ceil((at - now.getTime()) / DAY_MS));
      this.emit({
        type: "key.expiring",
        title: `${agent.name}'s key expires in ${days} ${days === 1 ? "day" : "days"}`,
        text: `${agent.name}'s key (owner ${agent.owner}) expires on ${agent.keyExpiresAt.slice(0, 10)}. Rotate it before then and give the new key to the tool.`,
        path: `/agents?agent=${encodeURIComponent(agent.id)}`,
        data: { agent: this.agentData(agent), expiresAt: agent.keyExpiresAt },
        label: agent.name,
      });
    }
    for (const w of workflows) {
      if (w.verdict !== "stop") {
        // Once it recovers, crossing the line again alerts again.
        this.stopped.delete(w.id);
        this.fired.delete(`workflow.stop|${w.id}`);
        continue;
      }
      if (this.stopped.has(w.id)) continue;
      this.stopped.add(w.id);
      if (!this.once(`workflow.stop|${w.id}`)) continue;
      this.emit({
        type: "workflow.stop",
        title: `${w.name} crossed its stop line`,
        text: `By the rule written down before any result, "${w.stopRule}", the workflow ${w.name} should stop. See its ROI report.`,
        path: `/workflows/${encodeURIComponent(w.name)}/report`,
        data: { workflow: w.id, name: w.name, rule: w.stopRule },
        label: w.name,
      });
    }
    this.save();
  }

  // Sending

  /** Sends a test message to one channel straight away and says how it went. */
  async test(id: string): Promise<Delivery> {
    const channel = this.getChannel(id);
    if (!channel) throw new Error(`No channel ${id}.`);
    const alert: Alert = {
      id: newId("alr"),
      type: "agent.stopped",
      severity: "info",
      at: this.deps.now().toISOString(),
      title: "A test from ROAI Purser",
      text: `This is a test alert for the channel "${channel.name}". If you can read it, alerts will arrive here.`,
      url: this.deps.baseUrl,
      count: 1,
      data: { test: true },
    };
    const delivery = await this.deliver(channel, alert, [0]);
    this.noteDelivery(channel.id, alert.at, delivery);
    this.save();
    return delivery;
  }

  /** Sends everything waiting now. The timer calls this; tests call it directly. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.queue;
    this.queue = [];
    this.flushing = this.flushing.then(() => this.send(batch));
    return this.flushing;
  }

  private emit(event: Omit<Pending, never>): void {
    this.queue.push(event);
    if (this.timer === null) {
      this.timer = setTimeout(
        () => void this.flush(),
        this.deps.batchMs ?? 2_000,
      );
      this.timer.unref?.();
    }
  }

  private async send(batch: Pending[]): Promise<void> {
    if (batch.length === 0) return;
    const at = this.deps.now().toISOString();
    for (const alert of summarize(batch, at, this.deps.baseUrl)) {
      const channels = this.channelsList.filter(
        (c) =>
          c.enabled && (c.events.length === 0 || c.events.includes(alert.type)),
      );
      // Channels are sent to side by side, so a slow one doesn't hold up the rest.
      const deliveries = await Promise.all(
        channels.map((channel) =>
          this.deliver(
            channel,
            alert,
            this.deps.retryDelaysMs ?? [0, 1_000, 5_000],
          ),
        ),
      );
      for (const [i, delivery] of deliveries.entries()) {
        const channel = channels[i];
        if (!channel) continue;
        this.noteDelivery(channel.id, alert.at, delivery);
        if (!delivery.ok) {
          this.deps.store.audit({
            at: this.deps.now().toISOString(),
            type: "alert.failed",
            detail: {
              channel: channel.name,
              alert: alert.type,
              error: delivery.error,
            },
          });
        }
      }
      this.remember({ ...alert, deliveries });
    }
    this.save();
  }

  private async deliver(
    channel: Channel,
    alert: Alert,
    delays: number[],
  ): Promise<Delivery> {
    if (channel.kind === "email")
      return this.deliverEmail(channel, alert, delays);
    const url = this.deps.vault.get(channelSecret(channel.id))?.apiKey;
    const base = { channelId: channel.id, channelName: channel.name };
    if (!url)
      return { ...base, ok: false, attempts: 0, error: "No URL is saved." };
    const body = JSON.stringify(format(channel.kind, alert));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "ROAI-Purser",
    };
    if (channel.kind === "webhook") {
      const secret = this.deps.vault.get(signingSecret(channel.id))?.apiKey;
      const timestamp = String(Math.floor(Date.parse(alert.at) / 1000));
      headers["x-purser-event"] = alert.type;
      headers["x-purser-timestamp"] = timestamp;
      if (secret) {
        headers["x-purser-signature"] =
          `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
      }
    }
    let last: Delivery = { ...base, ok: false, attempts: 0 };
    for (const [i, delay] of delays.entries()) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      try {
        const res = await this.deps.fetch(url, {
          method: "POST",
          headers,
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        await res.body?.cancel().catch(() => undefined);
        if (res.ok)
          return { ...base, ok: true, attempts: i + 1, status: res.status };
        last = {
          ...base,
          ok: false,
          attempts: i + 1,
          status: res.status,
          error: `The receiver answered ${res.status}.`,
        };
        // A 4xx other than rate limiting won't get better by trying again.
        if (res.status < 500 && res.status !== 429) return last;
      } catch (err) {
        last = {
          ...base,
          ok: false,
          attempts: i + 1,
          error:
            err instanceof Error && err.name === "TimeoutError"
              ? "No answer within 5 seconds."
              : "Could not reach the receiver.",
        };
      }
    }
    return last;
  }

  private async deliverEmail(
    channel: Channel,
    alert: Alert,
    delays: number[],
  ): Promise<Delivery> {
    const base = { channelId: channel.id, channelName: channel.name };
    const smtp = this.smtpValue;
    if (!smtp) {
      return {
        ...base,
        ok: false,
        attempts: 0,
        error: "Set up the mail server first.",
      };
    }
    if (!channel.to || channel.to.length === 0) {
      return { ...base, ok: false, attempts: 0, error: "No one to send to." };
    }
    const send = this.deps.sendMail ?? nodemailerSend;
    const password = this.deps.vault.get(SMTP_SECRET)?.apiKey;
    const message = formatEmail(alert, channel.to);
    let last: Delivery = { ...base, ok: false, attempts: 0 };
    for (const [i, delay] of delays.entries()) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      try {
        await send({ ...smtp, password }, message);
        return { ...base, ok: true, attempts: i + 1 };
      } catch (err) {
        const problem =
          err instanceof MailError
            ? err
            : new MailError("Could not reach the mail server.", false);
        last = { ...base, ok: false, attempts: i + 1, error: problem.message };
        // A refused password or address won't get better by trying again.
        if (problem.permanent) return last;
      }
    }
    return last;
  }

  // Bookkeeping

  private readonly lastDelivery = new Map<
    string,
    { at: string; ok: boolean; error?: string | undefined }
  >();

  private noteDelivery(channelId: string, at: string, d: Delivery): void {
    this.lastDelivery.set(channelId, { at, ok: d.ok, error: d.error });
  }

  private present(channel: Channel): PublicChannel {
    if (channel.kind === "email") {
      return {
        ...channel,
        urlHint: "",
        signed: false,
        lastDelivery: this.lastDelivery.get(channel.id),
      };
    }
    const url = this.deps.vault.get(channelSecret(channel.id))?.apiKey ?? "";
    let urlHint: string;
    try {
      const parsed = new URL(url);
      urlHint = `${parsed.protocol}//${parsed.host}/…${secretHint(url).slice(-4)}`;
    } catch {
      urlHint = "";
    }
    return {
      ...channel,
      urlHint,
      signed: channel.kind === "webhook",
      lastDelivery: this.lastDelivery.get(channel.id),
    };
  }

  private agentData(agent: Agent) {
    return {
      id: agent.id,
      name: agent.name,
      owner: agent.owner,
      ...(agent.team ? { team: agent.team } : {}),
    };
  }

  /** True the first time a marker is seen, false after. */
  private once(marker: string): boolean {
    if (this.fired.has(marker)) return false;
    this.fired.set(marker, this.deps.now().toISOString());
    return true;
  }

  private remember(record: AlertRecord): void {
    this.history.push(record);
    if (this.history.length > HISTORY_KEPT) this.history.shift();
    if (this.dataDir) {
      appendFileSync(
        join(this.dataDir, "alerts-history.jsonl"),
        `${JSON.stringify(record)}\n`,
        { mode: 0o600 },
      );
    }
  }

  private load(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "alerts.json");
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf8")) as Partial<
        AlertsFile & { fired: Record<string, string> }
      >;
      this.settingsValue = { ...DEFAULT_ALERT_SETTINGS, ...data.settings };
      this.channelsList = data.channels ?? [];
      this.smtpValue = data.smtp;
      for (const [marker, at] of Object.entries(data.fired ?? {})) {
        this.fired.set(marker, at);
        if (marker.startsWith("workflow.stop|")) {
          this.stopped.add(marker.slice("workflow.stop|".length));
        }
      }
    }
    const history = join(dir, "alerts-history.jsonl");
    if (existsSync(history)) {
      const lines = readFileSync(history, "utf8").split("\n").filter(Boolean);
      // Only the newest are ever shown, so an old file is cut back to them.
      if (lines.length > HISTORY_KEPT * 5) {
        writeAtomic(history, `${lines.slice(-HISTORY_KEPT).join("\n")}\n`);
      }
      for (const line of lines.slice(-HISTORY_KEPT)) {
        try {
          const record = JSON.parse(line) as AlertRecord;
          this.history.push(record);
          for (const d of record.deliveries)
            this.noteDelivery(d.channelId, record.at, d);
        } catch {
          // A line torn by a crash mid-write.
        }
      }
    }
  }

  private save(): void {
    if (!this.dataDir) return;
    const cutoff = this.deps.now().getTime() - DEDUPE_DAYS * DAY_MS;
    for (const [marker, at] of this.fired) {
      if (Date.parse(at) < cutoff) this.fired.delete(marker);
    }
    writeAtomic(
      join(this.dataDir, "alerts.json"),
      JSON.stringify(
        {
          settings: this.settingsValue,
          channels: this.channelsList,
          ...(this.smtpValue ? { smtp: this.smtpValue } : {}),
          fired: Object.fromEntries(this.fired),
        },
        null,
        2,
      ),
    );
  }
}

/** One alert per event, or one summary for a burst of the same type. */
export function summarize(
  batch: Pending[],
  at: string,
  baseUrl: string,
): Alert[] {
  const byType = new Map<AlertType, Pending[]>();
  for (const event of batch) {
    byType.set(event.type, [...(byType.get(event.type) ?? []), event]);
  }
  const out: Alert[] = [];
  for (const [type, events] of byType) {
    const one = (e: Pending): Alert => ({
      id: newId("alr"),
      type,
      severity: SEVERITY[type],
      at,
      title: e.title,
      text: e.text,
      url: `${baseUrl}${e.path}`,
      count: 1,
      data: e.data,
    });
    if (events.length <= SUMMARY_AFTER) {
      out.push(...events.map(one));
      continue;
    }
    const names = events.slice(0, 10).map((e) => e.label);
    const more = events.length - names.length;
    out.push({
      id: newId("alr"),
      type,
      severity: SEVERITY[type],
      at,
      title: `${ALERT_TYPE_WORDS[type]}: ${events.length} at once`,
      text: `${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`,
      url: `${baseUrl}${type === "request.waiting" ? "/approvals" : type === "workflow.stop" ? "/workflows" : "/agents"}`,
      count: events.length,
      data: { items: events.map((e) => e.data) },
    });
  }
  return out;
}

/** Slack's mrkdwn treats &, < and > as markup, so names are escaped. */
const slackEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The body a channel gets. */
export function format(
  kind: Exclude<ChannelKind, "email">,
  alert: Alert,
): unknown {
  if (kind === "slack") {
    return {
      text: `*${slackEscape(alert.title)}*\n${slackEscape(alert.text)}\n<${alert.url}|Open in Purser>`,
    };
  }
  if (kind === "discord") {
    const content = `**${alert.title}**\n${alert.text}\n${alert.url}`;
    return {
      content: content.length > 2000 ? `${content.slice(0, 1997)}...` : content,
      // Names are typed by people: never let one ping @everyone.
      allowed_mentions: { parse: [] },
    };
  }
  return {
    id: alert.id,
    type: alert.type,
    severity: alert.severity,
    at: alert.at,
    title: alert.title,
    text: alert.text,
    url: alert.url,
    count: alert.count,
    data: alert.data,
  };
}

const htmlEscape = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** The email an alert becomes: plain text, with a simple escaped HTML twin. */
export function formatEmail(alert: Alert, to: string[]): MailMessage {
  // Names are typed by people: a line break in a subject could add a header.
  const oneLine = alert.title.replace(/[\r\n]+/g, " ").trim();
  const subject = `[Purser] ${oneLine.length > 180 ? `${oneLine.slice(0, 177)}...` : oneLine}`;
  const footer =
    "Sent by ROAI Purser. Choose which alerts come to this address on the Alerts page.";
  return {
    to,
    subject,
    text: `${alert.title}\n\n${alert.text}\n\nOpen in Purser: ${alert.url}\n\n-- \n${footer}\n`,
    html: [
      '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#1a2233;max-width:560px">',
      `<p style="font-size:17px;font-weight:600;margin:0 0 8px">${htmlEscape(alert.title)}</p>`,
      `<p style="margin:0 0 16px">${htmlEscape(alert.text)}</p>`,
      `<p style="margin:0 0 24px"><a href="${htmlEscape(alert.url)}">Open in Purser</a></p>`,
      `<p style="margin:0;font-size:12px;color:#667085">${htmlEscape(footer)}</p>`,
      "</div>",
    ].join(""),
    headers: {
      "X-Purser-Event": alert.type,
      // Asks out-of-office replies not to answer an automatic message.
      "Auto-Submitted": "auto-generated",
    },
  };
}
