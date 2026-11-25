import { createHmac } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Alerts,
  channelSecret,
  format,
  signingSecret,
  summarize,
  webhookProblem,
  type Alert,
  type AlertRecord,
  type PublicChannel,
} from "./alerts.js";
import { Store } from "./store.js";
import { harness, type Harness } from "./test/helpers.js";
import type { UsageRecord } from "./types.js";
import { Vault } from "./vault.js";
import { sweepAlerts } from "./workflowapi.js";

let seq = 0;
const usage = (agentId: string, costUsd: number, at: string): UsageRecord => ({
  id: `u_${++seq}`,
  agentId,
  provider: "openai",
  endpoint: "/chat/completions",
  model: "gpt-4o-mini",
  at,
  costUsd,
  priced: "table",
  status: 200,
  durationMs: 10,
  outcome: "complete",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
});

async function addChannel(
  h: Harness,
  kind: "webhook" | "slack" | "discord" = "slack",
  extra: Record<string, unknown> = {},
) {
  const res = await h.admin("POST", "/alerts/channels", {
    name: `${kind} channel`,
    kind,
    url: `https://hooks.test/${kind}/T000/SECRETPART`,
    ...extra,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as {
    channel: PublicChannel;
    signingSecret?: string;
  };
}

const sent = (h: Harness) => h.hooks.calls.map((c) => c.json);
const NOW = "2026-11-07T12:00:00.000Z";

describe("alert channels in the admin API", () => {
  it("adds channels without ever showing their URL, and signs plain webhooks", async () => {
    const h = harness();
    const slack = await addChannel(h, "slack", {
      events: ["agent.at_limit"],
    });
    expect(slack.channel).toMatchObject({
      name: "slack channel",
      kind: "slack",
      events: ["agent.at_limit"],
      enabled: true,
      signed: false,
    });
    expect(slack.channel.urlHint).toMatch(/^https:\/\/hooks\.test\/…/);
    expect(JSON.stringify(slack)).not.toContain("SECRETPART");
    expect(slack.signingSecret).toBeUndefined();

    const hook = await addChannel(h, "webhook");
    expect(hook.signingSecret).toMatch(/^whsec_/);
    expect(hook.channel.signed).toBe(true);

    const listed = (await (await h.admin("GET", "/alerts")).json()) as {
      channels: PublicChannel[];
      settings: Record<string, number>;
      types: { type: string; words: string }[];
      recent: unknown[];
    };
    expect(listed.channels).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain("SECRETPART");
    expect(JSON.stringify(listed)).not.toContain(hook.signingSecret);
    expect(listed.settings).toEqual({
      nearLimitPercent: 80,
      spikeMultiple: 3,
      spikeMinUsd: 5,
      keyExpiringDays: 7,
    });
    expect(listed.types.map((t) => t.type)).toContain("workflow.stop");
    expect(h.store.listAudit().at(-1)).toMatchObject({
      type: "alerts.changed",
      detail: { by: "admin", action: "added", kind: "webhook" },
    });
  });

  it("refuses insecure or broken URLs and bad input", async () => {
    const h = harness();
    const post = (body: Record<string, unknown>) =>
      h.admin("POST", "/alerts/channels", {
        name: "x",
        kind: "slack",
        url: "https://hooks.test/x/y",
        ...body,
      });
    expect((await post({ url: "http://hooks.example.com/x" })).status).toBe(
      400,
    );
    expect((await post({ url: "not a url at all" })).status).toBe(400);
    expect((await post({ url: "ftp://hooks.example.com/x" })).status).toBe(400);
    expect((await post({ kind: "email" })).status).toBe(400);
    expect((await post({ events: ["agent.dancing"] })).status).toBe(400);
    expect((await post({ url: "http://localhost:9000/hook" })).status).toBe(
      201,
    );
    const junk = await h.app.request("/admin/alerts/channels", {
      method: "POST",
      headers: { authorization: "Bearer purser_admin_test" },
      body: "{",
    });
    expect(junk.status).toBe(400);
    expect(webhookProblem("http://[::1]:9/x")).toBeNull();
    expect(webhookProblem("http://127.0.0.1/x")).toBeNull();
  });

  it("changes, pauses and removes a channel, and the vault forgets it", async () => {
    const h = harness();
    const { channel } = await addChannel(h, "webhook");
    const patched = await h.admin("PATCH", `/alerts/channels/${channel.id}`, {
      name: "ops",
      enabled: false,
      events: ["workflow.stop"],
      url: "https://hooks.test/webhook/NEW",
    });
    expect(
      ((await patched.json()) as { channel: PublicChannel }).channel,
    ).toMatchObject({
      name: "ops",
      enabled: false,
      events: ["workflow.stop"],
    });
    expect(h.vault.get(channelSecret(channel.id))?.apiKey).toBe(
      "https://hooks.test/webhook/NEW",
    );
    expect(
      (
        await h.admin("PATCH", `/alerts/channels/${channel.id}`, {
          url: "http://x.example",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.admin("PATCH", `/alerts/channels/${channel.id}`, {
          colour: "red",
        })
      ).status,
    ).toBe(400);
    expect(
      (await h.admin("PATCH", "/alerts/channels/ch_nope", {})).status,
    ).toBe(404);
    expect(
      (await h.admin("DELETE", `/alerts/channels/${channel.id}`)).status,
    ).toBe(200);
    expect(h.vault.get(channelSecret(channel.id))?.apiKey).toBeUndefined();
    expect(h.vault.get(signingSecret(channel.id))?.apiKey).toBeUndefined();
    expect(
      (await h.admin("DELETE", `/alerts/channels/${channel.id}`)).status,
    ).toBe(404);
    expect(() => h.alerts.updateChannel("ch_nope", {})).toThrow(/No channel/);
  });

  it("changes thresholds within sensible bounds", async () => {
    const h = harness();
    const res = await h.admin("PUT", "/alerts/settings", {
      nearLimitPercent: 90,
      keyExpiringDays: 14,
    });
    expect(
      ((await res.json()) as { settings: Record<string, number> }).settings,
    ).toMatchObject({
      nearLimitPercent: 90,
      keyExpiringDays: 14,
      spikeMultiple: 3,
    });
    for (const bad of [
      { nearLimitPercent: 100 },
      { spikeMultiple: 1 },
      { keyExpiringDays: 0 },
    ]) {
      expect((await h.admin("PUT", "/alerts/settings", bad)).status).toBe(400);
    }
  });

  it("sends a test message on demand and reports how it went", async () => {
    const h = harness();
    const { channel } = await addChannel(h, "discord");
    const ok = (await (
      await h.admin("POST", `/alerts/channels/${channel.id}/test`)
    ).json()) as { delivery: { ok: boolean; attempts: number } };
    expect(ok.delivery).toMatchObject({ ok: true, attempts: 1 });
    expect(String(sent(h)[0]?.content)).toContain("A test from ROAI Purser");

    h.hooks.replies.push(500);
    const bad = (await (
      await h.admin("POST", `/alerts/channels/${channel.id}/test`)
    ).json()) as { delivery: { ok: boolean; error: string } };
    expect(bad.delivery).toMatchObject({
      ok: false,
      error: "The receiver answered 500.",
    });
    const listed = (await (await h.admin("GET", "/alerts")).json()) as {
      channels: PublicChannel[];
    };
    expect(listed.channels[0]?.lastDelivery?.ok).toBe(false);
    expect(
      (await h.admin("POST", "/alerts/channels/ch_nope/test")).status,
    ).toBe(404);
    await expect(h.alerts.test("ch_nope")).rejects.toThrow(/No channel/);
  });
});

describe("spending alerts", () => {
  it("warns near a cap and again at it, once per window and cap", async () => {
    const h = harness();
    await addChannel(h, "slack");
    const bot = h.addAgent("support-bot", { dailyUsd: 10, monthlyUsd: 1000 });
    h.store.recordUsage(usage(bot.id, 7, NOW));
    h.store.recordUsage(usage(bot.id, 1, NOW));
    await h.alerts.flush();
    expect(sent(h)).toHaveLength(1);
    expect(String(sent(h)[0]?.text)).toContain(
      "*support-bot has used 80% of its daily limit*",
    );

    h.store.recordUsage(usage(bot.id, 2.5, NOW));
    h.store.recordUsage(usage(bot.id, 1, NOW));
    await h.alerts.flush();
    expect(sent(h)).toHaveLength(2);
    expect(String(sent(h)[1]?.text)).toContain(
      "support-bot reached its daily limit",
    );
    expect(String(sent(h)[1]?.text)).toContain(
      "$10.50 of its $10.00 daily limit",
    );

    // A one-time raise moves the cap, so reaching the new one alerts again.
    await h.admin("POST", `/agents/${bot.id}/raise-limit`, {
      window: "day",
      amountUsd: 5,
    });
    h.store.recordUsage(usage(bot.id, 4, NOW));
    await h.alerts.flush();
    expect(sent(h).map((s) => String(s.text).split("\n")[0])).toEqual([
      "*support-bot has used 80% of its daily limit*",
      "*support-bot reached its daily limit*",
      "*support-bot reached its daily limit*",
    ]);
    // An agent with no caps, or a record for a vanished agent, says nothing.
    const free = h.addAgent("free-bot");
    h.store.recordUsage(usage(free.id, 50, NOW));
    h.store.recordUsage(usage("agt_gone", 50, NOW));
    await h.alerts.flush();
    expect(sent(h)).toHaveLength(3);
  });

  it("notices a spike against the agent's own 7-day normal", async () => {
    const h = harness();
    await addChannel(h, "webhook");
    const bot = h.addAgent("report-bot");
    const day = (n: number) =>
      new Date(Date.parse(NOW) - n * 86_400_000).toISOString();
    for (let n = 1; n <= 7; n++) h.store.recordUsage(usage(bot.id, 1, day(n)));
    // A brand-new agent has no normal yet.
    const fresh = h.addAgent("fresh-bot");
    h.store.recordUsage(usage(fresh.id, 1, day(1)));
    h.store.recordUsage(usage(fresh.id, 50, NOW));
    h.store.recordUsage(usage(bot.id, 2.9, NOW));
    await h.alerts.flush();
    expect(sent(h)).toHaveLength(0);
    h.store.recordUsage(usage(bot.id, 3, NOW));
    h.store.recordUsage(usage(bot.id, 3, NOW));
    await h.alerts.flush();
    expect(sent(h)).toHaveLength(1);
    expect(sent(h)[0]).toMatchObject({
      type: "agent.spend_spike",
      severity: "warning",
      title: "report-bot is spending 6 times its usual rate",
      url: `http://127.0.0.1:4141/agents?agent=${bot.id}`,
      data: { todayUsd: 5.9, averageUsd: 1 },
    });
  });
});

describe("audit-driven alerts", () => {
  it("says who stopped an agent, and sums up a burst", async () => {
    const h = harness();
    await addChannel(h, "discord");
    const one = h.addAgent("one-bot");
    await h.admin("POST", `/agents/${one.id}/kill`, { by: "dana@example.com" });
    await h.alerts.flush();
    expect(String(sent(h)[0]?.content)).toContain(
      "dana@example.com stopped one-bot (owner Dana Ortiz)",
    );

    const ids = ["a", "b", "c", "d", "e"].map(
      (n) => h.addAgent(`bulk-${n}`).id,
    );
    await h.admin("POST", "/agents/bulk", { action: "kill", ids });
    await h.alerts.flush();
    expect(sent(h)).toHaveLength(2);
    const summary = String(sent(h)[1]?.content);
    expect(summary).toContain("An agent was stopped: 5 at once");
    expect(summary).toContain("bulk-a, bulk-b, bulk-c, bulk-d, bulk-e.");
    expect(h.alerts.recent(1)[0]).toMatchObject({ count: 5 });
  });

  it("names more than ten in a burst briefly", () => {
    const batch = Array.from({ length: 12 }, (_, i) => ({
      type: "key.expired" as const,
      title: "t",
      text: "x",
      path: "/agents",
      data: {},
      label: `bot-${i}`,
    }));
    const [alert] = summarize(batch, NOW, "http://p");
    expect(alert?.text).toBe(
      "bot-0, bot-1, bot-2, bot-3, bot-4, bot-5, bot-6, bot-7, bot-8, bot-9 and 2 more.",
    );
    expect(alert?.url).toBe("http://p/agents");
    expect(
      summarize(
        [...batch.map((b) => ({ ...b, type: "request.waiting" as const }))],
        NOW,
        "http://p",
      )[0]?.url,
    ).toBe("http://p/approvals");
    expect(
      summarize(
        [...batch.map((b) => ({ ...b, type: "workflow.stop" as const }))],
        NOW,
        "http://p",
      )[0]?.url,
    ).toBe("http://p/workflows");
  });

  it("alerts when a key expires, and before it does, once per key", async () => {
    const h = harness();
    await addChannel(h, "slack");
    const bot = h.addAgent("old-key-bot");
    h.store.updateAgent(bot.id, { keyExpiresAt: "2026-11-10T00:00:00.000Z" });
    h.addAgent("no-expiry");
    const later = h.addAgent("later-bot");
    h.store.updateAgent(later.id, { keyExpiresAt: "2027-01-01T00:00:00.000Z" });
    h.alerts.sweep();
    h.alerts.sweep();
    await h.alerts.flush();
    expect(sent(h)).toHaveLength(1);
    expect(String(sent(h)[0]?.text)).toContain(
      "old-key-bot's key expires in 3 days",
    );

    h.clock.now = new Date("2026-11-11T00:00:00Z");
    const res = await h.app.request("/v1/outcomes", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bot.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ result: "accepted" }),
    });
    expect(res.status).toBe(403);
    h.alerts.sweep();
    await h.alerts.flush();
    expect(sent(h)).toHaveLength(2);
    expect(String(sent(h)[1]?.text)).toContain("old-key-bot's key expired");
  });

  it("alerts on a waiting request, not on one the rules approved at once", async () => {
    const h = harness();
    await addChannel(h, "slack", { events: ["request.waiting"] });
    const person = h.org.addPerson({
      email: "finn@example.com",
      name: "finn",
      role: "member",
      department: "Finance",
      source: "admin",
    });
    const ask = (dailyUsd: number, name: string) =>
      h.as(person, "POST", "/me/agents", {
        name,
        purpose: "Summaries",
        dailyUsd,
      });
    expect((await ask(0.5, "small-bot")).status).toBe(201);
    expect((await ask(5, "big-bot")).status).toBe(202);
    await Promise.resolve();
    await h.alerts.flush();
    expect(sent(h)).toHaveLength(1);
    expect(String(sent(h)[0]?.text)).toContain(
      "finn@example.com is asking for a new agent, big-bot",
    );
  });
});

describe("the workflow stop line", () => {
  it("alerts once when crossed, and again only after it recovers", async () => {
    const h = harness();
    await addChannel(h, "webhook", { events: ["workflow.stop"] });
    h.addAgent("support-bot");
    await h.admin("POST", "/workflows", {
      name: "support replies",
      unit: "ticket",
      owner: "Dana",
      agents: ["support-bot"],
      baseline: {
        minutesPerUnit: 10,
        hourlyCostUsd: 60,
        measuredOn: "2026-10-01",
        method: "timed",
        source: "measured",
      },
      attribution: "before_after",
      stopIf: { metric: "acceptance_rate", when: "below", value: 0.5 },
      minUnits: 2,
    });
    const deps = { ...h, now: () => h.clock.now, workflows: h.workflows };
    const record = async (result: string, count: number) =>
      (
        (await (
          await h.admin("POST", "/workflows/support%20replies/outcomes", {
            result,
            count,
            reviewMinutes: 1,
          })
        ).json()) as { outcome: { id: string } }
      ).outcome.id;
    const bad = await record("discarded", 10);
    sweepAlerts(deps);
    sweepAlerts(deps);
    await h.alerts.flush();
    expect(sent(h)).toHaveLength(1);
    expect(sent(h)[0]).toMatchObject({
      type: "workflow.stop",
      severity: "critical",
      title: "support replies crossed its stop line",
      url: "http://127.0.0.1:4141/workflows/support%20replies/report",
    });
    expect(String(sent(h)[0]?.text)).toContain(
      '"Stop if acceptance rate is below 50%"',
    );

    await h.admin("POST", `/workflows/support%20replies/outcomes/${bad}/void`);
    await record("accepted", 10);
    sweepAlerts(deps);
    await record("discarded", 30);
    sweepAlerts(deps);
    await h.alerts.flush();
    expect(sent(h)).toHaveLength(2);
  });
});

describe("delivery", () => {
  const alert: Alert = {
    id: "alr_1",
    type: "agent.at_limit",
    severity: "warning",
    at: NOW,
    title: "<!channel> & bot",
    text: "Owner <b>",
    url: "http://p/agents",
    count: 1,
    data: {},
  };

  it("formats for Slack, Discord and plain webhooks, safely", () => {
    expect(format("slack", alert)).toEqual({
      text: "*&lt;!channel&gt; &amp; bot*\nOwner &lt;b&gt;\n<http://p/agents|Open in Purser>",
    });
    const long = format("discord", { ...alert, text: "x".repeat(3000) }) as {
      content: string;
      allowed_mentions: unknown;
    };
    expect(long.content).toHaveLength(2000);
    expect(long.allowed_mentions).toEqual({ parse: [] });
    expect(format("webhook", alert)).toMatchObject({
      id: "alr_1",
      type: "agent.at_limit",
    });
  });

  it("signs plain webhooks so the receiver can check them", async () => {
    const h = harness();
    const { signingSecret: secret } = await addChannel(h, "webhook");
    await h.admin("POST", `/agents/${h.addAgent().id}/kill`);
    await h.alerts.flush();
    const call = h.hooks.calls[0];
    expect(call?.headers["x-purser-event"]).toBe("agent.stopped");
    const ts = call?.headers["x-purser-timestamp"] ?? "";
    const expected = createHmac("sha256", secret ?? "")
      .update(`${ts}.${call?.body ?? ""}`)
      .digest("hex");
    expect(call?.headers["x-purser-signature"]).toBe(`sha256=${expected}`);
  });

  it("retries server errors, gives up on client errors, and records failures", async () => {
    const h = harness();
    await addChannel(h, "slack");
    await h.admin("POST", `/agents/${h.addAgent("a-bot").id}/kill`);
    h.hooks.replies.push(503, "network");
    await h.alerts.flush();
    expect(h.hooks.calls).toHaveLength(3);
    expect(h.alerts.recent(1)[0]?.deliveries[0]).toMatchObject({
      ok: true,
      attempts: 3,
    });

    await h.admin("POST", `/agents/${h.addAgent("b-bot").id}/kill`);
    h.hooks.replies.push(404);
    await h.alerts.flush();
    expect(h.alerts.recent(1)[0]?.deliveries[0]).toMatchObject({
      ok: false,
      attempts: 1,
      status: 404,
    });
    expect(h.store.listAudit().at(-1)).toMatchObject({
      type: "alert.failed",
      detail: { channel: "slack channel", alert: "agent.stopped" },
    });

    await h.admin("POST", `/agents/${h.addAgent("c-bot").id}/kill`);
    h.hooks.replies.push("timeout", "timeout", "timeout");
    await h.alerts.flush();
    expect(h.alerts.recent(1)[0]?.deliveries[0]).toMatchObject({
      ok: false,
      attempts: 3,
      error: "No answer within 5 seconds.",
    });
  });

  it("sends each channel only what it asked for, and nothing when paused", async () => {
    const h = harness();
    const stops = await addChannel(h, "slack", { events: ["agent.stopped"] });
    await addChannel(h, "discord", { events: ["key.expired"] });
    const paused = await addChannel(h, "webhook");
    await h.admin("PATCH", `/alerts/channels/${paused.channel.id}`, {
      enabled: false,
    });
    await h.admin("POST", `/agents/${h.addAgent().id}/kill`);
    await h.alerts.flush();
    expect(h.hooks.calls.map((c) => c.url)).toEqual([
      "https://hooks.test/slack/T000/SECRETPART",
    ]);
    expect(h.alerts.recent(1)[0]?.deliveries.map((d) => d.channelId)).toEqual([
      stops.channel.id,
    ]);
    // Without a saved URL, a channel can't send.
    h.vault.removeKey(channelSecret(stops.channel.id));
    expect(await h.alerts.test(stops.channel.id)).toMatchObject({
      ok: false,
      error: "No URL is saved.",
    });
  });

  it("does nothing with an empty batch, and a timer sends a waiting one", async () => {
    const store = new Store();
    const alerts = new Alerts({
      store,
      vault: new Vault(),
      fetch: () => Promise.resolve(new Response("ok")),
      now: () => new Date(NOW),
      baseUrl: "http://p",
      batchMs: 1,
    });
    await alerts.flush();
    expect(alerts.recent()).toEqual([]);
    store.createAgent({
      id: "agt_1",
      name: "x",
      owner: "o",
      keyHash: "h",
      keyHint: "k",
      status: "active",
      limits: {},
      createdAt: NOW,
    });
    store.audit({
      at: NOW,
      type: "agent.paused",
      agentId: "agt_1",
      detail: {},
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(alerts.recent(1)[0]?.text).toContain("someone stopped x");
  });
});

describe("Alerts on disk", () => {
  it("keeps channels, settings, history and what already fired", async () => {
    const dir = mkdtempSync(join(tmpdir(), "purser-alerts-"));
    const store = new Store();
    const vault = new Vault(dir);
    const calls: string[] = [];
    const make = () =>
      new Alerts(
        {
          store,
          vault,
          fetch: (input) => {
            calls.push(String(input));
            return Promise.resolve(new Response("ok"));
          },
          now: () => new Date(NOW),
          baseUrl: "http://p",
          retryDelaysMs: [0],
        },
        dir,
      );
    const first = make();
    first.setSettings({ keyExpiringDays: 30 });
    const { channel } = first.addChannel({
      name: "ops",
      kind: "slack",
      url: "https://hooks.test/s/1",
      events: [],
    });
    store.createAgent({
      id: "agt_1",
      name: "old",
      owner: "o",
      keyHash: "abcdef0123456789zz",
      keyHint: "k",
      status: "active",
      limits: {},
      createdAt: NOW,
      keyExpiresAt: "2026-11-20T00:00:00.000Z",
    });
    first.sweep([{ id: "wf_1", name: "w", verdict: "stop", stopRule: "r" }]);
    await first.flush();
    expect(calls).toHaveLength(2);

    const second = make();
    expect(second.settings().keyExpiringDays).toBe(30);
    expect(second.channels()[0]).toMatchObject({
      id: channel.id,
      lastDelivery: { ok: true },
    });
    expect(second.recent()).toHaveLength(2);
    second.sweep([{ id: "wf_1", name: "w", verdict: "stop", stopRule: "r" }]);
    await second.flush();
    expect(calls).toHaveLength(2);
    second.removeChannel(channel.id);
    expect(make().channels()).toEqual([]);
    // A long history file is cut back to the newest on start.
    const line = `${JSON.stringify(second.recent(1)[0])}\n`;
    appendFileSync(join(dir, "alerts-history.jsonl"), line.repeat(1100));
    make();
    expect(
      readFileSync(join(dir, "alerts-history.jsonl"), "utf8")
        .trim()
        .split("\n"),
    ).toHaveLength(200);
    const records: AlertRecord[] = second.recent();
    expect(records.map((r) => r.type).sort()).toEqual([
      "key.expiring",
      "workflow.stop",
    ]);
  });
});

describe("store listeners", () => {
  it("never let a listener's mistake fail the record", () => {
    const store = new Store();
    store.subscribe({
      usage: () => {
        throw new Error("boom");
      },
    });
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (e: unknown) => errors.push(e);
    try {
      store.recordUsage(usage("agt_1", 1, NOW));
    } finally {
      console.error = original;
    }
    expect(store.listUsage()).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });
});
