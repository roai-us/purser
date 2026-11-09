import { describe, expect, it } from "vitest";
import type { Person } from "./org.js";
import { ROTATE_ALL_CONFIRM, type RotateAllResult } from "./security.js";
import { chatBody, harness } from "./test/helpers.js";
import type { PublicAgent } from "./types.js";

function company(demoSignIn = true) {
  const h = harness({ demoSignIn });
  const add = (email: string, role: Person["role"], department: string) =>
    h.org.addPerson({
      email,
      name: email.split("@")[0] ?? email,
      role,
      department,
      source: "admin",
    });
  const people = {
    owner: add("omar@example.com", "member", "Eng"),
    member: add("mo@example.com", "member", "Sales"),
    leaver: add("lee@example.com", "member", "Eng"),
  };
  h.org.updatePerson(people.leaver.id, { status: "disabled" });
  const owned = h.addAgent(
    "owned",
    {},
    { team: "Eng", ownerEmail: "omar@example.com" },
  );
  const leavers = h.addAgent(
    "leavers",
    {},
    { team: "Eng", ownerEmail: "lee@example.com" },
  );
  const shared = h.addAgent("shared", {}, { team: "Sales" });
  return { h, people, owned, leavers, shared };
}

const chat = (h: ReturnType<typeof harness>, key: string) =>
  h.call("/openai/v1/chat/completions", {
    method: "POST",
    key,
    body: chatBody(),
  });

const rotateAll = async (
  h: ReturnType<typeof harness>,
  body: Record<string, unknown> = {},
) =>
  (await (
    await h.admin("POST", "/security/rotate-all", {
      confirm: ROTATE_ALL_CONFIRM,
      reason: "Key seen in a public repo",
      ...body,
    })
  ).json()) as RotateAllResult;

describe("rotating every key", () => {
  it("needs the confirmation and a reason", async () => {
    const { h, owned } = company();
    const noConfirm = await h.admin("POST", "/security/rotate-all", {
      confirm: "yes",
      reason: "Because",
    });
    expect(noConfirm.status).toBe(400);
    expect(
      ((await noConfirm.json()) as { error: { code: string } }).error.code,
    ).toBe("confirm_required");
    const noReason = await h.admin("POST", "/security/rotate-all", {
      confirm: ROTATE_ALL_CONFIRM,
    });
    expect(noReason.status).toBe(400);
    const badJson = await h.app.request("/admin/security/rotate-all", {
      method: "POST",
      headers: {
        authorization: "Bearer purser_admin_test",
        "content-type": "application/json",
      },
      body: "{nope",
    });
    expect(badJson.status).toBe(400);
    expect((await chat(h, owned.key)).status).toBe(200);
  });

  it("only admins can do it", async () => {
    const { h, people } = company();
    const res = await h.as(
      people.member,
      "POST",
      "/admin/security/rotate-all",
      {
        confirm: ROTATE_ALL_CONFIRM,
        reason: "Because",
      },
    );
    expect(res.status).toBe(403);
    expect((await h.as(people.member, "GET", "/admin/security")).status).toBe(
      403,
    );
  });

  it("stops every old key at once", async () => {
    const { h, owned, leavers, shared } = company();
    const result = await rotateAll(h);
    expect(result.rotated).toBe(3);
    for (const a of [owned, leavers, shared]) {
      const res = await chat(h, a.key);
      expect(res.status).toBe(401);
      expect(res.headers.get("x-purser-denied")).toBe("invalid_key");
    }
    expect(result.oldKeysUntil).toBeUndefined();
  });

  it("owners who can sign in collect theirs; the admin gets the rest, once", async () => {
    const { h, people, owned, leavers, shared } = company();
    const result = await rotateAll(h);
    expect(result.waitingForOwners).toBe(1);
    // The agent with no owner, and the one whose owner left.
    const names = result.keys.map((k) => k.name).sort();
    expect(names).toEqual(["leavers", "shared"]);
    expect(result.keys.map((k) => k.id)).not.toContain(owned.id);
    const sharedKey = result.keys.find((k) => k.id === shared.id)?.key ?? "";
    expect((await chat(h, sharedKey)).status).toBe(200);
    expect(h.store.getAgent(leavers.id)?.awaitingKey).toBeUndefined();

    // The owner is told, and their new key works once collected.
    const me = (await (await h.as(people.owner, "GET", "/me")).json()) as {
      keysWaiting: number;
    };
    expect(me.keysWaiting).toBe(1);
    const agent = (await (
      await h.as(people.owner, "GET", `/me/agents/${owned.id}`)
    ).json()) as PublicAgent;
    expect(agent.awaitingKey).toBe(true);
    const collected = (await (
      await h.as(people.owner, "POST", `/me/agents/${owned.id}/rotate-key`, {
        graceMinutes: 0,
      })
    ).json()) as { key: string; agent: PublicAgent };
    expect((await chat(h, collected.key)).status).toBe(200);
    expect(collected.agent.awaitingKey).toBeUndefined();
  });

  it("with no way to sign in, every key comes to the admin", async () => {
    const { h } = company(false);
    const result = await rotateAll(h);
    expect(result.waitingForOwners).toBe(0);
    expect(result.keys).toHaveLength(3);
    const view = (await (await h.admin("GET", "/security")).json()) as {
      peopleCanSignIn: boolean;
      demoKeys: boolean;
      agents: { adminGets: number };
    };
    expect(view.demoKeys).toBe(false);
    expect(view.peopleCanSignIn).toBe(false);
    expect(view.agents.adminGets).toBe(3);
  });

  it("company sign-in lets owners collect", async () => {
    const { h } = company(false);
    h.org.updateSettings({
      signIn: {
        issuer: "https://login.example.com",
        clientId: "abc",
        allowedDomains: ["example.com"],
        adminEmails: [],
      },
    });
    const result = await rotateAll(h);
    expect(result.waitingForOwners).toBe(1);
  });

  it("can give the old keys an overlap, for a planned rotation", async () => {
    const { h, people, owned, shared } = company();
    const result = await rotateAll(h, { graceMinutes: 60 });
    expect(result.oldKeysUntil).toBe("2026-11-07T13:00:00.000Z");
    expect((await chat(h, owned.key)).status).toBe(200);
    expect((await chat(h, shared.key)).status).toBe(200);

    // Collecting the new key doesn't cut the old one short.
    const collected = (await (
      await h.as(people.owner, "POST", `/me/agents/${owned.id}/rotate-key`, {
        graceMinutes: 0,
      })
    ).json()) as { key: string };
    expect((await chat(h, owned.key)).status).toBe(200);
    expect((await chat(h, collected.key)).status).toBe(200);

    h.clock.now = new Date(h.clock.now.getTime() + 61 * 60_000);
    expect((await chat(h, owned.key)).status).toBe(401);
    expect((await chat(h, shared.key)).status).toBe(401);
    expect((await chat(h, collected.key)).status).toBe(200);
  });

  it("collecting after an overlap ended leaves no old key behind", async () => {
    const { h, people, owned } = company();
    await rotateAll(h, { graceMinutes: 60 });
    h.clock.now = new Date(h.clock.now.getTime() + 61 * 60_000);
    await h.as(people.owner, "POST", `/me/agents/${owned.id}/rotate-key`, {
      graceMinutes: 0,
    });
    expect(h.store.getAgent(owned.id)?.previousKeyHash).toBeUndefined();
  });

  it("right away means right away, even during an earlier overlap", async () => {
    const { h, owned, shared } = company();
    await rotateAll(h, { graceMinutes: 1440 });
    expect((await chat(h, owned.key)).status).toBe(200);
    expect((await chat(h, shared.key)).status).toBe(200);
    await rotateAll(h, { reason: "It got worse" });
    expect((await chat(h, owned.key)).status).toBe(401);
    expect((await chat(h, shared.key)).status).toBe(401);
    expect(h.store.getAgent(owned.id)?.previousKeyHash).toBeUndefined();
  });

  it("can cover one department", async () => {
    const { h, owned, shared } = company();
    const result = await rotateAll(h, { department: "Sales" });
    expect(result.rotated).toBe(1);
    expect((await chat(h, shared.key)).status).toBe(401);
    expect((await chat(h, owned.key)).status).toBe(200);
  });

  it("stopped agents get new keys and stay stopped", async () => {
    const { h, shared } = company();
    await h.admin("POST", `/agents/${shared.id}/kill`);
    const result = await rotateAll(h);
    expect(h.store.getAgent(shared.id)?.status).toBe("paused");
    await h.admin("POST", `/agents/${shared.id}/resume`);
    expect((await chat(h, shared.key)).status).toBe(401);
    const key = result.keys.find((k) => k.id === shared.id)?.key ?? "";
    expect((await chat(h, key)).status).toBe(200);
  });

  it("cuts requests running on the old keys, unless they overlap", async () => {
    const { h, shared } = company();
    const controller = new AbortController();
    h.inflight.add(shared.id, controller);
    await rotateAll(h, { graceMinutes: 60 });
    expect(controller.signal.aborted).toBe(false);
    const result = await rotateAll(h);
    expect(result.abortedRequests).toBe(1);
    expect(controller.signal.aborted).toBe(true);
  });

  it("records who, why and how many, never a key", async () => {
    const { h } = company();
    const result = await rotateAll(h);
    const event = h.store
      .listAudit()
      .find((e) => e.type === "keys.rotated_all");
    expect(event?.detail).toMatchObject({
      reason: "Key seen in a public repo",
      rotated: 3,
      waitingForOwners: 1,
      deliveredToAdmin: 2,
      graceMinutes: 0,
    });
    const log = JSON.stringify(h.store.listAudit());
    for (const k of result.keys) expect(log).not.toContain(k.key);
  });
});

describe("the security page's data", () => {
  it("counts what would happen, and what's still waiting", async () => {
    const { h } = company();
    const before = (await (await h.admin("GET", "/security")).json()) as {
      confirm: string;
      agents: Record<string, number>;
      departments: string[];
      providers: { id: string; keyHint?: string; apiKey?: string }[];
      history: unknown[];
    };
    expect(before.confirm).toBe(ROTATE_ALL_CONFIRM);
    expect(before.agents).toEqual({
      total: 3,
      ownerCollects: 1,
      adminGets: 2,
      waiting: 0,
    });
    expect(before.departments).toEqual(["Eng", "Sales"]);
    expect(before.providers.map((p) => p.id)).toContain("openai");
    expect(JSON.stringify(before.providers)).not.toContain("sk-real-openai");
    expect(before.history).toEqual([]);

    const eng = (await (
      await h.admin("GET", "/security?department=Sales")
    ).json()) as { agents: { total: number } };
    expect(eng.agents.total).toBe(1);

    await rotateAll(h);
    const after = (await (await h.admin("GET", "/security")).json()) as {
      agents: { waiting: number };
      history: { reason: string; rotated: number }[];
    };
    expect(after.agents.waiting).toBe(1);
    expect(after.history[0]?.reason).toBe("Key seen in a public repo");
  });

  it("the agents list can show only keys still to collect", async () => {
    const { h, owned } = company();
    await rotateAll(h);
    const page = (await (
      await h.admin("GET", "/agents?awaitingKey=1")
    ).json()) as { items: PublicAgent[]; total: number };
    expect(page.total).toBe(1);
    expect(page.items[0]?.id).toBe(owned.id);
  });
});
