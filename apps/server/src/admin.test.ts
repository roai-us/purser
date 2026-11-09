import { describe, expect, it } from "vitest";
import { chatBody, harness } from "./test/helpers.js";
import type { PublicAgent } from "./types.js";

describe("admin API", () => {
  it("requires the admin token and refuses agent keys", async () => {
    const h = harness();
    const { key } = h.addAgent();
    expect((await h.app.request("/admin/agents")).status).toBe(401);
    const asAgent = await h.app.request("/admin/agents", {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(asAgent.status).toBe(401);
    const raise = await h.app.request("/admin/agents/support-bot/limits", {
      method: "PATCH",
      headers: { authorization: `Bearer ${key}` },
      body: JSON.stringify({ dailyUsd: 1000 }),
    });
    expect(raise.status).toBe(401);
  });

  it("registers an agent, shows the key once and never returns its hash", async () => {
    const h = harness();
    const res = await h.admin("POST", "/agents", {
      name: "invoice-reader",
      owner: "Sam Lee",
      purpose: "Reads supplier invoices",
      limits: { dailyUsd: 5, monthlyUsd: 50, models: ["gpt-4o-mini"] },
      endsAt: "2027-01-31T00:00:00Z",
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { agent: PublicAgent; key: string };
    expect(created.key).toMatch(/^purser_/);
    expect(created.agent.keyHint).toMatch(/^purser_..\.\.\./);
    expect(JSON.stringify(created.agent)).not.toContain("keyHash");

    const list = await (await h.admin("GET", "/agents")).text();
    expect(list).not.toContain(created.key);
    expect(list).not.toContain("keyHash");

    const call = await h.call("/openai/v1/chat/completions", {
      method: "POST",
      body: chatBody(),
      key: created.key,
    });
    expect(call.status).toBe(200);
    const one = (await (
      await h.admin("GET", "/agents/invoice-reader")
    ).json()) as PublicAgent;
    expect(one.spend.today).toBeGreaterThan(0);
    expect(one.spend.month).toBe(one.spend.today);
    expect(one.requests.today).toBe(1);
    expect(one.state).toBe("running");
    expect(one.lastUsedAt).toBe("2026-11-07T12:00:00.000Z");
  });

  it("will not register an agent without an owner, or with a taken name", async () => {
    const h = harness();
    expect((await h.admin("POST", "/agents", { name: "x" })).status).toBe(400);
    expect(
      (await h.admin("POST", "/agents", { name: "bad name!", owner: "a" }))
        .status,
    ).toBe(400);
    expect(
      (
        await h.admin("POST", "/agents", {
          name: "x",
          owner: "a",
          limits: { dailyUsd: -1 },
        })
      ).status,
    ).toBe(400);
    const notJson = await h.app.request("/admin/agents", {
      method: "POST",
      headers: { authorization: "Bearer purser_admin_test" },
      body: "{",
    });
    expect(notJson.status).toBe(400);
    expect(
      (await h.admin("POST", "/agents", { name: "x", owner: "a" })).status,
    ).toBe(201);
    expect(
      (await h.admin("POST", "/agents", { name: "x", owner: "b" })).status,
    ).toBe(409);
  });

  it("pauses, resumes and records who did it", async () => {
    const h = harness();
    const { id, key } = h.addAgent();
    const killed = (await (
      await h.admin("POST", "/agents/support-bot/kill", { by: "Dana" })
    ).json()) as {
      agent: PublicAgent;
      elapsedMs: number;
    };
    expect(killed.agent).toMatchObject({ status: "paused", pausedBy: "Dana" });
    expect(killed.elapsedMs).toBeLessThan(1000);
    const resumed = (await (
      await h.admin("POST", `/agents/${id}/resume`)
    ).json()) as { agent: PublicAgent };
    expect(resumed.agent.status).toBe("active");
    expect(resumed.agent.pausedBy).toBeUndefined();
    const call = await h.call("/openai/v1/chat/completions", {
      method: "POST",
      body: chatBody(),
      key,
    });
    expect(call.status).toBe(200);
    const audit = (await (await h.admin("GET", "/audit")).json()) as {
      items: { type: string }[];
    };
    expect(audit.items.map((e) => e.type)).toEqual([
      "agent.resumed",
      "agent.paused",
      "agent.created",
    ]);
  });

  it("reports which agents can't run, and searches by provider name", async () => {
    const h = harness();
    h.addAgent("invoice-bot", {}, { providers: ["openai"] });
    h.addAgent("hr-helper");
    await h.admin("POST", "/agents/hr-helper/kill");

    const board = (await (await h.admin("GET", "/status?limit=5")).json()) as {
      total: number;
      running: number;
      notRunning: number;
      stopped: { name: string; state: string; by?: string }[];
    };
    expect(board).toMatchObject({ total: 2, running: 1, notRunning: 1 });
    expect(board.stopped).toEqual([
      expect.objectContaining({ name: "hr-helper", state: "paused" }),
    ]);
    const junk = await h.admin("GET", "/status?limit=lots");
    expect(junk.status).toBe(200);

    const red = (await (
      await h.admin("GET", "/agents?state=not_running")
    ).json()) as { items: PublicAgent[] };
    expect(red.items.map((a) => a.name)).toEqual(["hr-helper"]);
    // "OpenAI" is the connector's display name; the agent stores its id.
    const byName = (await (
      await h.admin("GET", "/agents?q=OpenAI&in=provider")
    ).json()) as { items: PublicAgent[] };
    expect(byName.items.map((a) => a.name)).toEqual(["invoice-bot"]);
    expect((await h.admin("GET", "/agents?in=purpose")).status).toBe(400);
  });

  it("pauses every agent at once", async () => {
    const h = harness();
    h.addAgent("a");
    h.addAgent("b");
    const result = (await (await h.admin("POST", "/kill-all")).json()) as {
      paused: number;
    };
    expect(result.paused).toBe(2);
    expect(h.store.listAgents().every((a) => a.status === "paused")).toBe(true);
    const again = (await (await h.admin("POST", "/kill-all")).json()) as {
      paused: number;
    };
    expect(again.paused).toBe(0);
  });

  it("rotates a key: the old one stops working at once", async () => {
    const h = harness();
    const { key } = h.addAgent();
    const rotated = (await (
      await h.admin("POST", "/agents/support-bot/rotate-key")
    ).json()) as { key: string };
    expect(rotated.key).not.toBe(key);
    expect((await h.call("/openai/v1/models", { key })).status).toBe(401);
    expect(
      (await h.call("/openai/v1/models", { key: rotated.key })).status,
    ).toBe(200);
  });

  it("changes limits and keeps the ones not mentioned", async () => {
    const h = harness();
    h.addAgent("bot", { dailyUsd: 1, models: ["gpt-4o"] });
    const res = await h.admin("PATCH", "/agents/bot/limits", {
      monthlyUsd: 20,
    });
    const { agent } = (await res.json()) as { agent: PublicAgent };
    expect(agent.limits).toEqual({
      dailyUsd: 1,
      monthlyUsd: 20,
      models: ["gpt-4o"],
    });
    expect(
      (await h.admin("PATCH", "/agents/bot/limits", { surprise: true })).status,
    ).toBe(400);
  });

  it("lists usage, for one agent or all", async () => {
    const h = harness();
    const a = h.addAgent("a");
    const b = h.addAgent("b");
    for (const key of [a.key, b.key, b.key]) {
      await h.call("/openai/v1/chat/completions", {
        method: "POST",
        body: chatBody(),
        key,
      });
    }
    const all = (await (await h.admin("GET", "/usage")).json()) as {
      usage: unknown[];
    };
    expect(all.usage).toHaveLength(3);
    const onlyB = (await (await h.admin("GET", "/usage?agent=b")).json()) as {
      usage: unknown[];
    };
    expect(onlyB.usage).toHaveLength(2);
    expect((await h.admin("GET", "/usage?agent=nobody")).status).toBe(404);
  });

  it("answers 404 for an unknown agent", async () => {
    const h = harness();
    for (const [method, path] of [
      ["GET", "/agents/ghost"],
      ["POST", "/agents/ghost/kill"],
      ["POST", "/agents/ghost/resume"],
      ["POST", "/agents/ghost/rotate-key"],
      ["PATCH", "/agents/ghost/limits"],
    ] as const) {
      expect(
        (await h.admin(method, path, method === "GET" ? undefined : {})).status,
      ).toBe(404);
    }
  });

  it("reports health without a token, and 404 for unknown paths", async () => {
    const h = harness();
    expect(await (await h.app.request("/health")).json()).toMatchObject({
      ok: true,
    });
    expect((await h.app.request("/nowhere")).status).toBe(404);
  });
});
