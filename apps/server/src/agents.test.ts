import { describe, expect, it } from "vitest";
import { chatBody, harness, routerBody } from "./test/helpers.js";
import type { PublicAgent } from "./types.js";

const post = (body: string) => ({ method: "POST", body });
const DAY = 86_400_000;

describe("agent details", () => {
  it("creates agents with a team, a name with spaces and a provider allowlist", async () => {
    const h = harness();
    const res = await h.admin("POST", "/agents", {
      name: "Newsletter writer",
      owner: "Sam Lee",
      team: "Marketing EMEA",
      providers: ["openrouter"],
    });
    expect(res.status).toBe(201);
    const { agent } = (await res.json()) as { agent: PublicAgent };
    expect(agent).toMatchObject({
      team: "Marketing EMEA",
      providers: ["openrouter"],
      state: "running",
      keyState: "ok",
      spend: { today: 0, month: 0 },
      requests: { today: 0 },
    });
    expect(
      (
        await h.admin("POST", "/agents", {
          name: "x",
          owner: "a",
          providers: ["nope"],
        })
      ).status,
    ).toBe(400);
    expect(
      (await h.admin("POST", "/agents", { name: "two  spaces", owner: "a" }))
        .status,
    ).toBe(400);
  });

  it("refuses a connector outside the agent's allowlist", async () => {
    const h = harness();
    const { key } = h.addAgent(
      "router-only",
      {},
      { providers: ["openrouter"] },
    );
    const denied = await h.call("/openai/v1/chat/completions", {
      ...post(chatBody()),
      key,
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("x-purser-denied")).toBe("provider_not_allowed");
    const allowed = await h.call("/openrouter/api/v1/chat/completions", {
      ...post(routerBody()),
      key,
    });
    expect(allowed.status).toBe(200);
  });

  it("patches details, clears them with null, and audits the change", async () => {
    const h = harness();
    h.addAgent("bot", { dailyUsd: 1 }, { team: "Ops", providers: ["openai"] });
    const res = await h.admin("PATCH", "/agents/bot", {
      owner: "New Owner",
      team: null,
      providers: null,
      purpose: "Sorts mail",
      limits: { monthlyUsd: 9 },
      endsAt: "2027-01-01T00:00:00Z",
    });
    const agent = (await res.json()) as PublicAgent;
    expect(agent).toMatchObject({
      owner: "New Owner",
      purpose: "Sorts mail",
      endsAt: "2027-01-01T00:00:00Z",
    });
    // PATCH replaces limits as a whole: the daily cap left out is removed.
    expect(agent.limits).toEqual({ monthlyUsd: 9 });
    expect(agent.team).toBeUndefined();
    expect(agent.providers).toBeUndefined();
    const cleared = (await (
      await h.admin("PATCH", "/agents/bot", { endsAt: null, providers: [] })
    ).json()) as PublicAgent;
    expect(cleared.endsAt).toBeUndefined();
    expect(h.store.listAudit().at(-2)).toMatchObject({
      type: "agent.updated",
      detail: { by: "admin" },
    });
    expect(
      (await h.admin("PATCH", "/agents/bot", { providers: ["nope"] })).status,
    ).toBe(400);
    expect((await h.admin("PATCH", "/agents/bot", { evil: 1 })).status).toBe(
      400,
    );
    expect((await h.admin("PATCH", "/agents/ghost", {})).status).toBe(404);
  });

  it("shows each agent's state: running, paused, at its limit or expired", async () => {
    const h = harness();
    const capped = h.addAgent("capped", { dailyUsd: 0.000001 });
    h.addAgent("ended", {}, { endsAt: "2026-11-01T00:00:00Z" });
    h.addAgent("stopped");
    h.addAgent("fine");
    await h.call("/openai/v1/chat/completions", {
      ...post(chatBody()),
      key: capped.key,
    });
    await h.admin("POST", "/agents/stopped/kill");
    const states = async (state: string) =>
      (
        (await (await h.admin("GET", `/agents?state=${state}`)).json()) as {
          items: PublicAgent[];
        }
      ).items.map((a) => a.name);
    expect(await states("at_limit")).toEqual(["capped"]);
    expect(await states("expired")).toEqual(["ended"]);
    expect(await states("paused")).toEqual(["stopped"]);
    expect(await states("running")).toEqual(["fine"]);
  });
});

describe("bulk actions", () => {
  it("stops, resumes and rotates many agents at once", async () => {
    const h = harness();
    const a = h.addAgent("a");
    const b = h.addAgent("b");
    const killed = (await (
      await h.admin("POST", "/agents/bulk", {
        action: "kill",
        ids: [a.id, "b", "ghost", a.id],
      })
    ).json()) as {
      results: { id: string; ok: boolean; error?: string }[];
      abortedRequests: number;
    };
    expect(killed.results.map((r) => r.ok)).toEqual([true, true, false]);
    expect(killed.abortedRequests).toBe(0);
    expect((await h.call("/openai/v1/models", { key: b.key })).status).toBe(
      403,
    );
    await h.admin("POST", "/agents/bulk", {
      action: "resume",
      ids: [a.id, b.id],
    });
    expect((await h.call("/openai/v1/models", { key: b.key })).status).toBe(
      200,
    );
    const rotated = (await (
      await h.admin("POST", "/agents/bulk", {
        action: "rotate-key",
        ids: [a.id, b.id],
        graceMinutes: 0,
      })
    ).json()) as { results: { key: string }[] };
    expect(rotated.results.every((r) => r.key.startsWith("purser_"))).toBe(
      true,
    );
    expect((await h.call("/openai/v1/models", { key: a.key })).status).toBe(
      401,
    );
    expect(
      (
        await h.call("/openai/v1/models", {
          key: rotated.results[0]?.key ?? "",
        })
      ).status,
    ).toBe(200);
    expect(
      (await h.admin("POST", "/agents/bulk", { action: "explode", ids: ["a"] }))
        .status,
    ).toBe(400);
    expect(
      (await h.admin("POST", "/agents/bulk", { action: "kill", ids: [] }))
        .status,
    ).toBe(400);
  });
});

describe("key rotation with a grace period", () => {
  it("keeps the old key working until the grace period ends", async () => {
    const h = harness();
    const { id, key: oldKey } = h.addAgent();
    const res = (await (
      await h.admin("POST", "/agents/support-bot/rotate-key", {
        graceMinutes: 60,
      })
    ).json()) as {
      key: string;
      previousKeyValidUntil: string;
      agent: PublicAgent;
    };
    expect(res.previousKeyValidUntil).toBe("2026-11-07T13:00:00.000Z");
    expect(res.agent.previousKeyValidUntil).toBe(res.previousKeyValidUntil);
    expect(JSON.stringify(res.agent)).not.toContain("previousKeyHash");

    const withOld = await h.call("/openai/v1/chat/completions", {
      ...post(chatBody()),
      key: oldKey,
    });
    expect(withOld.status).toBe(200);
    const withNew = await h.call("/openai/v1/chat/completions", {
      ...post(chatBody()),
      key: res.key,
    });
    expect(withNew.status).toBe(200);
    expect(h.store.listUsage(id).map((u) => u.key)).toEqual([
      "previous",
      "current",
    ]);

    h.clock.now = new Date("2026-11-07T13:00:00Z");
    expect((await h.call("/openai/v1/models", { key: oldKey })).status).toBe(
      401,
    );
    const later = (await (
      await h.admin("GET", "/agents/support-bot")
    ).json()) as PublicAgent;
    expect(later.previousKeyValidUntil).toBeUndefined();
  });

  it("revokes the old key on a kill or a second rotation", async () => {
    const h = harness();
    const { key: first } = h.addAgent();
    const second = (await (
      await h.admin("POST", "/agents/support-bot/rotate-key", {
        graceMinutes: 60,
      })
    ).json()) as { key: string };
    await h.admin("POST", "/agents/support-bot/rotate-key", {
      graceMinutes: 60,
    });
    expect((await h.call("/openai/v1/models", { key: first })).status).toBe(
      401,
    );
    expect(
      (await h.call("/openai/v1/models", { key: second.key })).status,
    ).toBe(200);
    await h.admin("POST", "/agents/support-bot/kill");
    await h.admin("POST", "/agents/support-bot/resume");
    expect(
      (await h.call("/openai/v1/models", { key: second.key })).status,
    ).toBe(401);
    expect(
      (
        await h.admin("POST", "/agents/support-bot/rotate-key", {
          graceMinutes: 999_999,
        })
      ).status,
    ).toBe(400);
  });
});

describe("key expiry and rotation schedules", () => {
  it("sets the first expiry from the policy and shows when a key is expiring", async () => {
    const h = harness();
    const { agent } = (await (
      await h.admin("POST", "/agents", {
        name: "scheduled",
        owner: "a",
        rotation: { everyDays: 90, graceDays: 7 },
      })
    ).json()) as { agent: PublicAgent };
    expect(agent.keyExpiresAt).toBe("2027-02-05T12:00:00.000Z");
    expect(agent.keyState).toBe("ok");
    h.clock.now = new Date(Date.parse("2027-02-05T12:00:00Z") - 10 * DAY);
    const soon = (await (
      await h.admin("GET", "/agents/scheduled")
    ).json()) as PublicAgent;
    expect(soon.keyState).toBe("expiring");
    expect(
      (
        await h.admin("POST", "/agents", {
          name: "bad-policy",
          owner: "a",
          rotation: { everyDays: 0, graceDays: 7 },
        })
      ).status,
    ).toBe(400);
  });

  it("refuses an expired key once-audited, without pausing the agent, until it is rotated", async () => {
    const h = harness();
    const { key } = h.addAgent();
    await h.admin("PATCH", "/agents/support-bot", {
      keyExpiresAt: "2026-11-08T00:00:00Z",
    });
    h.clock.now = new Date("2026-11-09T00:00:00Z");
    for (let i = 0; i < 2; i++) {
      const res = await h.call("/openai/v1/models", { key });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: {
          code: "key_expired",
          message:
            "This agent's key expired on 2026-11-08. Ask its owner to rotate it.",
        },
      });
    }
    expect(
      h.store.listAudit().filter((e) => e.type === "key.expired"),
    ).toHaveLength(1);
    const agent = (await (
      await h.admin("GET", "/agents/support-bot")
    ).json()) as PublicAgent;
    expect(agent).toMatchObject({ status: "active", keyState: "expired" });

    const rotated = (await (
      await h.admin("POST", "/agents/support-bot/rotate-key", {})
    ).json()) as {
      key: string;
      agent: PublicAgent;
      previousKeyValidUntil?: string;
    };
    expect(rotated.agent.keyExpiresAt).toBeUndefined();
    // An expired key gets no grace period.
    expect(rotated.previousKeyValidUntil).toBeUndefined();
    expect(
      (await h.call("/openai/v1/models", { key: rotated.key })).status,
    ).toBe(200);
  });

  it("applies the policy on rotation: new expiry and default grace, capped by the old key's expiry", async () => {
    const h = harness();
    const { key: oldKey } = h.addAgent();
    await h.admin("PATCH", "/agents/support-bot", {
      rotation: { everyDays: 30, graceDays: 7 },
      keyExpiresAt: "2026-11-10T12:00:00Z",
    });
    const rotated = (await (
      await h.admin("POST", "/agents/support-bot/rotate-key", {})
    ).json()) as {
      key: string;
      agent: PublicAgent;
      previousKeyValidUntil: string;
    };
    expect(rotated.agent.keyExpiresAt).toBe("2026-12-07T12:00:00.000Z");
    // Seven days of grace would run past the old key's own expiry, so it stops there.
    expect(rotated.previousKeyValidUntil).toBe("2026-11-10T12:00:00.000Z");
    h.clock.now = new Date("2026-11-10T11:59:00Z");
    expect((await h.call("/openai/v1/models", { key: oldKey })).status).toBe(
      200,
    );
    h.clock.now = new Date("2026-11-10T12:00:00Z");
    expect((await h.call("/openai/v1/models", { key: oldKey })).status).toBe(
      401,
    );
    expect(
      (await h.call("/openai/v1/models", { key: rotated.key })).status,
    ).toBe(200);
  });

  it("lets a rotation override the expiry, and refuses one in the past", async () => {
    const h = harness();
    h.addAgent();
    await h.admin("PATCH", "/agents/support-bot", {
      rotation: { everyDays: 30, graceDays: 0 },
    });
    const custom = (await (
      await h.admin("POST", "/agents/support-bot/rotate-key", {
        keyExpiresAt: "2027-06-01T00:00:00Z",
      })
    ).json()) as { agent: PublicAgent; previousKeyValidUntil?: string };
    expect(custom.agent.keyExpiresAt).toBe("2027-06-01T00:00:00Z");
    expect(custom.previousKeyValidUntil).toBeUndefined();
    for (const [method, path, body] of [
      [
        "POST",
        "/agents/support-bot/rotate-key",
        { keyExpiresAt: "2020-01-01T00:00:00Z" },
      ],
      [
        "PATCH",
        "/agents/support-bot",
        { keyExpiresAt: "2020-01-01T00:00:00Z" },
      ],
      [
        "POST",
        "/agents",
        { name: "late", owner: "a", keyExpiresAt: "2020-01-01T00:00:00Z" },
      ],
      [
        "POST",
        "/agents/bulk",
        {
          action: "rotate-key",
          ids: ["support-bot"],
          keyExpiresAt: "2020-01-01T00:00:00Z",
        },
      ],
    ] as const) {
      expect((await h.admin(method, path, body)).status, path).toBe(400);
    }
    const cleared = (await (
      await h.admin("PATCH", "/agents/support-bot", {
        keyExpiresAt: null,
        rotation: null,
      })
    ).json()) as PublicAgent;
    expect(cleared.keyExpiresAt).toBeUndefined();
    expect(cleared.rotation).toBeUndefined();
  });

  it("uses each agent's own policy in a bulk rotation", async () => {
    const h = harness();
    h.addAgent("with-policy");
    h.addAgent("without");
    await h.admin("PATCH", "/agents/with-policy", {
      rotation: { everyDays: 10, graceDays: 1 },
    });
    await h.admin("POST", "/agents/bulk", {
      action: "rotate-key",
      ids: ["with-policy", "without"],
    });
    const get = async (n: string) =>
      (await (await h.admin("GET", `/agents/${n}`)).json()) as PublicAgent;
    expect(await get("with-policy")).toMatchObject({
      keyExpiresAt: "2026-11-17T12:00:00.000Z",
      previousKeyValidUntil: "2026-11-08T12:00:00.000Z",
    });
    const plain = await get("without");
    expect(plain.keyExpiresAt).toBeUndefined();
    expect(plain.previousKeyValidUntil).toBeUndefined();
  });

  it("filters and sorts by key state, and counts keys in the overview", async () => {
    const h = harness();
    h.addAgent("never");
    h.addAgent("later");
    h.addAgent("soon");
    h.addAgent("gone");
    await h.admin("PATCH", "/agents/later", {
      keyExpiresAt: "2027-06-01T00:00:00Z",
    });
    await h.admin("PATCH", "/agents/soon", {
      keyExpiresAt: "2026-11-15T00:00:00Z",
    });
    await h.admin("PATCH", "/agents/gone", {
      keyExpiresAt: "2026-11-08T00:00:00Z",
    });
    h.clock.now = new Date("2026-11-09T00:00:00Z");
    const names = async (query: string) =>
      (
        (await (await h.admin("GET", `/agents?${query}`)).json()) as {
          items: PublicAgent[];
        }
      ).items.map((a) => a.name);
    expect(await names("keyState=expired")).toEqual(["gone"]);
    expect(await names("keyState=expiring")).toEqual(["soon"]);
    expect(await names("keyState=ok")).toEqual(["later", "never"]);
    expect(await names("sort=key_expires&dir=asc")).toEqual([
      "gone",
      "soon",
      "later",
      "never",
    ]);
    const overview = (await (await h.admin("GET", "/overview")).json()) as {
      keys: { expiring: number; expired: number };
    };
    expect(overview.keys).toEqual({ expiring: 1, expired: 1 });
  });
});
