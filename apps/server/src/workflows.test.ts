import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import type { RoiReport } from "./roi.js";
import { chatBody, harness, type Harness } from "./test/helpers.js";
import { Workflows, type Outcome, type Workflow } from "./workflows.js";

const newWorkflow = (over: Record<string, unknown> = {}) => ({
  name: "support replies",
  unit: "support ticket answered",
  owner: "Dana Ortiz",
  agents: ["support-bot"],
  baseline: {
    minutesPerUnit: 30,
    hourlyCostUsd: 60,
    measuredOn: "2026-10-01",
    method: "Two weeks of ticket timestamps",
    source: "measured",
  },
  attribution: "before_after",
  defaultReviewMinutes: 5,
  costs: { monthlyMaintenanceUsd: 300 },
  stopIf: { metric: "cost_per_accepted_unit", when: "above", value: 25 },
  scaleIf: { metric: "acceptance_rate", when: "above", value: 0.75 },
  minUnits: 2,
  ...over,
});

type Detail = { workflow: Workflow; agents: unknown[]; report: RoiReport };

async function setUp() {
  const h = harness();
  const bot = h.addAgent("support-bot");
  const res = await h.admin("POST", "/workflows", newWorkflow());
  expect(res.status).toBe(201);
  const { workflow } = (await res.json()) as { workflow: Workflow };
  return { h, bot, workflow };
}

const report = (h: Harness, from = "2026-11-01", to = "2026-11-30") =>
  h.admin("GET", `/workflows/support%20replies/report?from=${from}&to=${to}`);

const agentPost = (h: Harness, key: string | null, body: unknown) =>
  Promise.resolve(
    h.app.request("/v1/outcomes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

describe("workflows in the admin API", () => {
  it("creates a workflow with defaults, and lists it with a summary", async () => {
    const { h, bot, workflow } = await setUp();
    expect(workflow).toMatchObject({
      name: "support replies",
      agents: [bot.id],
      status: "active",
      createdBy: "admin",
      costs: {
        implementationUsd: 0,
        monthlyMaintenanceUsd: 300,
        monthlyEvaluationUsd: 0,
        discountRate: 0.1,
      },
    });
    expect(workflow.lockedAt).toBeUndefined();
    expect(h.store.listAudit().at(-1)?.type).toBe("workflow.created");

    const list = (await (await h.admin("GET", "/workflows")).json()) as {
      workflows: (Workflow & {
        summary: { verdict: string; results: number };
      })[];
    };
    expect(list.workflows).toHaveLength(1);
    expect(list.workflows[0]?.summary).toMatchObject({
      verdict: "too_early",
      results: 0,
    });

    const detail = (await (
      await h.admin("GET", `/workflows/${workflow.id}`)
    ).json()) as Detail;
    expect(detail.agents).toEqual([
      { id: bot.id, name: "support-bot", state: "running" },
    ]);
    expect(detail.report.period.days).toBe(30);
  });

  it("refuses bad input, unknown agents, taken names and shared agents", async () => {
    const { h } = await setUp();
    const bad = await h.admin(
      "POST",
      "/workflows",
      newWorkflow({ stopIf: undefined }),
    );
    expect(bad.status).toBe(400);
    const rate = await h.admin(
      "POST",
      "/workflows",
      newWorkflow({
        name: "x",
        stopIf: { metric: "acceptance_rate", when: "below", value: 50 },
      }),
    );
    expect(rate.status).toBe(400);
    const junk = await h.app.request("/admin/workflows", {
      method: "POST",
      headers: { authorization: "Bearer purser_admin_test" },
      body: "{nope",
    });
    expect(junk.status).toBe(400);
    const unknown = await h.admin(
      "POST",
      "/workflows",
      newWorkflow({ name: "other", agents: ["ghost"] }),
    );
    expect(
      ((await unknown.json()) as { error: { code: string } }).error.code,
    ).toBe("unknown_agent");
    const taken = await h.admin("POST", "/workflows", newWorkflow());
    expect(taken.status).toBe(409);
    const shared = await h.admin(
      "POST",
      "/workflows",
      newWorkflow({ name: "other" }),
    );
    expect(shared.status).toBe(409);
    expect(
      ((await shared.json()) as { error: { code: string } }).error.code,
    ).toBe("agent_in_workflow");
    expect((await h.admin("GET", "/workflows/nope")).status).toBe(404);
  });

  it("needs an admin", async () => {
    const h = harness();
    const res = await h.app.request("/admin/workflows");
    expect(res.status).toBe(401);
  });

  it("locks the rules at the first result, and shows later number changes", async () => {
    const { h, workflow } = await setUp();
    // Before any result, everything can change.
    const early = await h.admin("PATCH", `/workflows/${workflow.id}`, {
      stopIf: { metric: "cost_per_accepted_unit", when: "above", value: 20 },
    });
    expect(early.status).toBe(200);

    const first = await h.admin("POST", `/workflows/${workflow.id}/outcomes`, {
      result: "accepted",
      count: 3,
      reviewMinutes: 12,
    });
    expect(first.status).toBe(201);
    expect(((await first.json()) as { locked: boolean }).locked).toBe(true);
    const types = h.store.listAudit().map((e) => e.type);
    expect(types).toContain("workflow.locked");
    expect(types.at(-1)).toBe("outcome.recorded");

    const second = await h.admin("POST", `/workflows/${workflow.id}/outcomes`, {
      result: "discarded",
    });
    expect(((await second.json()) as { locked: boolean }).locked).toBe(false);

    const locked = await h.admin("PATCH", `/workflows/${workflow.id}`, {
      baseline: { ...newWorkflow().baseline, minutesPerUnit: 60 },
      scaleIf: null,
    });
    expect(locked.status).toBe(409);
    const body = (await locked.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("locked");
    expect(body.error.message).toMatch(
      /^baseline, scaleIf locked on 2026-11-07/,
    );

    // The same values sent back, as a form does, are not a change.
    const unchanged = await h.admin("PATCH", `/workflows/${workflow.id}`, {
      unit: "support ticket answered",
      baseline: newWorkflow().baseline,
      attribution: "before_after",
      minUnits: 2,
    });
    expect(unchanged.status).toBe(200);

    // Costs can still be corrected, and the report says so.
    h.clock.now = new Date("2026-11-08T09:00:00Z");
    const costs = await h.admin("PATCH", `/workflows/${workflow.id}`, {
      costs: { monthlyEvaluationUsd: 50 },
      owner: "Sam Lee",
    });
    const changed = ((await costs.json()) as { workflow: Workflow }).workflow;
    expect(changed.costs.monthlyMaintenanceUsd).toBe(300);
    expect(changed.costs.monthlyEvaluationUsd).toBe(50);
    expect(changed.changedAfterLock).toEqual([
      { at: "2026-11-08T09:00:00.000Z", by: "admin", fields: ["costs"] },
    ]);
    const r = (await (await report(h)).json()) as Detail;
    expect(r.report.caveats).toContain(
      "Changed after results arrived, on 2026-11-08 by admin: costs.",
    );

    // A change that changes nothing is not written down.
    const same = await h.admin("PATCH", `/workflows/${workflow.id}`, {
      owner: "Sam Lee",
    });
    expect(same.status).toBe(200);
    expect(
      h.store.listAudit().filter((e) => e.type === "workflow.updated"),
    ).toHaveLength(2);
  });

  it("renames, relinks, archives and reopens", async () => {
    const { h, workflow } = await setUp();
    const other = h.addAgent("triage-bot");
    expect(
      (
        await h.admin("PATCH", `/workflows/${workflow.id}`, {
          name: "support replies",
        })
      ).status,
    ).toBe(200);
    await h.admin(
      "POST",
      "/workflows",
      newWorkflow({ name: "triage", agents: [] }),
    );
    expect(
      (await h.admin("PATCH", `/workflows/${workflow.id}`, { name: "triage" }))
        .status,
    ).toBe(409);
    expect(
      (
        await h.admin("PATCH", `/workflows/${workflow.id}`, {
          agents: ["ghost"],
        })
      ).status,
    ).toBe(400);
    expect(
      (await h.admin("PATCH", `/workflows/${workflow.id}`, { team: 5 })).status,
    ).toBe(400);

    const moved = await h.admin("PATCH", `/workflows/${workflow.id}`, {
      name: "support",
      agents: ["support-bot", other.id, "support-bot"],
      team: "Support",
      ownerEmail: "dana@example.com",
    });
    const next = ((await moved.json()) as { workflow: Workflow }).workflow;
    expect(next.agents).toHaveLength(2);
    expect(next.team).toBe("Support");
    const cleared = await h.admin("PATCH", "/workflows/support", {
      team: null,
    });
    expect(
      ((await cleared.json()) as { workflow: Workflow }).workflow.team,
    ).toBeUndefined();

    await h.admin("PATCH", "/workflows/support", { status: "archived" });
    const active = (await (await h.admin("GET", "/workflows")).json()) as {
      workflows: Workflow[];
    };
    expect(active.workflows.map((w) => w.name)).toEqual(["triage"]);
    const all = (await (
      await h.admin("GET", "/workflows?status=all")
    ).json()) as {
      workflows: Workflow[];
    };
    expect(all.workflows).toHaveLength(2);
    expect(
      (
        await h.admin("POST", "/workflows/support/outcomes", {
          result: "accepted",
        })
      ).status,
    ).toBe(409);

    // While archived, its agent joined another workflow: it can't reopen.
    await h.admin("PATCH", "/workflows/triage", { agents: ["triage-bot"] });
    const reopen = await h.admin("PATCH", "/workflows/support", {
      status: "active",
    });
    expect(reopen.status).toBe(409);
    await h.admin("PATCH", "/workflows/triage", { agents: [] });
    expect(
      (await h.admin("PATCH", "/workflows/support", { status: "active" }))
        .status,
    ).toBe(200);
  });

  it("reports over a chosen period, with the agents' metered spend", async () => {
    const { h, bot, workflow } = await setUp();
    const spent = await h.call("/openai/v1/chat/completions", {
      method: "POST",
      key: bot.key,
      body: chatBody(),
    });
    expect(spent.status).toBe(200);
    await h.admin("POST", `/workflows/${workflow.id}/outcomes`, {
      result: "accepted",
      count: 4,
      reviewMinutes: 20,
    });
    const r = ((await (await report(h)).json()) as Detail).report;
    expect(r.cost.calls).toBe(1);
    expect(r.cost.inference.value).toBeGreaterThan(0);
    expect(r.results.accepted).toBe(4);
    // $300 a month of upkeep over four accepted tickets is far above $25 each.
    expect(r.perUnit.costPerAcceptedUnit.value).toBeGreaterThan(25);
    expect(r.verdict).toBe("stop");

    const october = (
      (await (await report(h, "2026-10-01", "2026-10-31")).json()) as Detail
    ).report;
    expect(october.results.total).toBe(0);

    const fromOnly = (await (
      await h.admin("GET", `/workflows/${workflow.id}/report?to=2026-11-07`)
    ).json()) as Detail;
    expect(fromOnly.report.period).toEqual({
      from: "2026-10-09",
      to: "2026-11-07",
      days: 30,
    });
    for (const q of [
      "from=2026-1-01",
      "from=2026-11-31",
      "from=2026-11-10&to=2026-11-01",
      "from=2025-01-01&to=2026-11-01",
    ]) {
      expect(
        (await h.admin("GET", `/workflows/${workflow.id}/report?${q}`)).status,
      ).toBe(400);
    }
  });

  it("takes tallies for past days, but not before the rules were set or in the future", async () => {
    const { h, workflow } = await setUp();
    h.clock.now = new Date("2026-11-20T12:00:00Z");
    const backdated = await h.admin(
      "POST",
      `/workflows/${workflow.id}/outcomes`,
      {
        result: "accepted",
        count: 40,
        at: "2026-11-10T00:00:00+02:00",
        note: "week 1",
      },
    );
    expect(backdated.status).toBe(201);
    const dated = ((await backdated.json()) as { outcome: Outcome }).outcome;
    expect(dated.at).toBe("2026-11-09T22:00:00.000Z");
    expect(dated.recordedAt).toBe("2026-11-20T12:00:00.000Z");
    // The rules lock when the result is entered, not on the day it is dated.
    expect(h.workflows.get(workflow.id)?.lockedAt).toBe(
      "2026-11-20T12:00:00.000Z",
    );
    for (const at of ["2026-11-21T00:00:00Z", "2026-11-01T00:00:00Z"]) {
      expect(
        (
          await h.admin("POST", `/workflows/${workflow.id}/outcomes`, {
            result: "accepted",
            at,
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await h.admin("POST", `/workflows/${workflow.id}/outcomes`, {
          result: "maybe",
        })
      ).status,
    ).toBe(400);
  });

  it("voids a result, keeps it on file, and lists results newest first", async () => {
    const { h, workflow } = await setUp();
    const made = await h.admin("POST", `/workflows/${workflow.id}/outcomes`, {
      result: "accepted",
      count: 4000,
      ref: "typo",
    });
    const { outcome } = (await made.json()) as { outcome: Outcome };
    const again = await h.admin("POST", `/workflows/${workflow.id}/outcomes`, {
      result: "accepted",
      count: 4000,
      ref: "typo",
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { duplicate: boolean }).duplicate).toBe(
      true,
    );
    await h.admin("POST", `/workflows/${workflow.id}/outcomes`, {
      result: "accepted",
      count: 40,
    });

    const voided = await h.admin(
      "POST",
      `/workflows/${workflow.id}/outcomes/${outcome.id}/void`,
    );
    expect(
      ((await voided.json()) as { outcome: Outcome }).outcome.voidedBy,
    ).toBe("admin");
    await h.admin(
      "POST",
      `/workflows/${workflow.id}/outcomes/${outcome.id}/void`,
    );
    expect(
      h.store.listAudit().filter((e) => e.type === "outcome.voided"),
    ).toHaveLength(1);
    expect(
      (await h.admin("POST", `/workflows/${workflow.id}/outcomes/out_x/void`))
        .status,
    ).toBe(404);

    const r = ((await (await report(h)).json()) as Detail).report;
    expect(r.results.accepted).toBe(40);
    expect(r.results.voided).toBe(4000);

    const listed = (await (
      await h.admin("GET", `/workflows/${workflow.id}/outcomes?limit=1`)
    ).json()) as { outcomes: Outcome[]; total: number };
    expect(listed.total).toBe(2);
    expect(listed.outcomes.map((o) => o.count)).toEqual([40]);
  });
});

describe("POST /v1/outcomes", () => {
  it("records a result with the agent's own key, marked as the agent's", async () => {
    const { h, bot, workflow } = await setUp();
    const res = await agentPost(h, bot.key, {
      result: "accepted",
      reviewMinutes: 3,
      ref: "TICKET-1",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      outcome: Outcome;
      workflow: { id: string; name: string };
    };
    expect(body.workflow).toEqual({ id: workflow.id, name: "support replies" });
    expect(body.outcome).toMatchObject({
      source: "agent",
      by: bot.id,
      agentId: bot.id,
      count: 1,
    });

    const retry = await agentPost(h, bot.key, {
      result: "discarded",
      ref: "TICKET-1",
    });
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { outcome: Outcome }).outcome.result).toBe(
      "accepted",
    );

    const named = await agentPost(h, bot.key, {
      workflow: "support replies",
      result: "reworked",
    });
    expect(named.status).toBe(201);

    const r = ((await (await report(h)).json()) as Detail).report;
    expect(r.results.byAgents).toBe(2);
    expect(r.caveats).toContain(
      "100% of results were reported by the agents themselves, not by a person.",
    );
  });

  it("turns away missing and wrong keys, bad bodies and big tallies", async () => {
    const { h, bot } = await setUp();
    expect((await agentPost(h, null, { result: "accepted" })).status).toBe(401);
    expect((await agentPost(h, "sk-nope", { result: "accepted" })).status).toBe(
      401,
    );
    expect((await agentPost(h, bot.key, "{oops")).status).toBe(400);
    expect(
      (await agentPost(h, bot.key, { result: "accepted", count: 1001 })).status,
    ).toBe(400);
    expect(
      (await agentPost(h, bot.key, { result: "accepted", extra: 1 })).status,
    ).toBe(400);
    expect((await agentPost(h, bot.key, "x".repeat(20_000))).status).toBe(413);
    const byHeader = await h.app.request("/v1/outcomes", {
      method: "POST",
      headers: { "x-api-key": bot.key, "content-type": "application/json" },
      body: JSON.stringify({ result: "accepted" }),
    });
    expect(byHeader.status).toBe(201);
    expect((await h.app.request("/v1/nothing")).status).toBe(404);
  });

  it("refuses an expired key", async () => {
    const { h, bot } = await setUp();
    h.store.updateAgent(bot.id, { keyExpiresAt: "2026-11-01T00:00:00Z" });
    const res = await agentPost(h, bot.key, { result: "accepted" });
    expect(res.status).toBe(403);
    expect(h.store.listAudit().at(-1)?.type).toBe("key.expired");
  });

  it("needs the agent to be in the workflow, and the workflow to be open", async () => {
    const { h, bot, workflow } = await setUp();
    const loner = h.addAgent("loner");
    const none = await agentPost(h, loner.key, { result: "accepted" });
    expect(none.status).toBe(404);
    expect(
      ((await none.json()) as { error: { code: string } }).error.code,
    ).toBe("no_workflow");
    await h.admin(
      "POST",
      "/workflows",
      newWorkflow({ name: "other", agents: ["loner"] }),
    );
    expect(
      (await agentPost(h, bot.key, { workflow: "other", result: "accepted" }))
        .status,
    ).toBe(404);
    expect(
      (await agentPost(h, bot.key, { workflow: "ghost", result: "accepted" }))
        .status,
    ).toBe(404);

    await h.admin("PATCH", `/workflows/${workflow.id}`, { status: "archived" });
    expect(
      (
        await agentPost(h, bot.key, {
          workflow: workflow.id,
          result: "accepted",
        })
      ).status,
    ).toBe(409);
    // No active workflow left for it.
    expect((await agentPost(h, bot.key, { result: "accepted" })).status).toBe(
      404,
    );
  });

  it("asks which workflow when an agent is in more than one", async () => {
    const { h, bot, workflow } = await setUp();
    await h.admin(
      "POST",
      "/workflows",
      newWorkflow({ name: "other", agents: [] }),
    );
    // The API keeps an agent in one workflow; data edited by hand may not.
    const other = h.workflows.resolve("other");
    h.workflows.update(other?.id ?? "", { agents: [bot.id] });
    const res = await agentPost(h, bot.key, { result: "accepted" });
    expect(res.status).toBe(400);
    expect(
      ((await res.json()) as { error: { message: string } }).error.message,
    ).toBe(
      "This agent is in more than one workflow. Say which: support replies, other.",
    );
    expect(
      (
        await agentPost(h, bot.key, {
          workflow: workflow.name,
          result: "accepted",
        })
      ).status,
    ).toBe(201);
  });
});

describe("report_outcome over MCP", () => {
  it("records a result for the agent's workflow, and explains refusals", async () => {
    const { h, bot } = await setUp();
    const client = new Client({ name: "test-agent", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://purser.test/mcp"), {
        fetch: (url, init) => Promise.resolve(h.app.request(String(url), init)),
        requestInit: { headers: { authorization: `Bearer ${bot.key}` } },
      }),
    );
    const done = (await client.callTool({
      name: "report_outcome",
      arguments: {
        result: "accepted",
        count: 2,
        review_minutes: 6,
        ref: "PR-9",
      },
    })) as {
      content: { text: string }[];
      structuredContent?: Record<string, unknown>;
    };
    expect(done.structuredContent?.duplicate).toBe(false);
    expect(done.content[0]?.text).toBe(
      "Recorded 2 accepted for support replies.",
    );
    const again = (await client.callTool({
      name: "report_outcome",
      arguments: { result: "accepted", ref: "PR-9" },
    })) as { content: { text: string }[] };
    expect(again.content[0]?.text).toMatch(/^Already recorded as out_/);

    const loner = h.addAgent("loner");
    const other = new Client({ name: "loner", version: "1.0.0" });
    await other.connect(
      new StreamableHTTPClientTransport(new URL("http://purser.test/mcp"), {
        fetch: (url, init) => Promise.resolve(h.app.request(String(url), init)),
        requestInit: { headers: { authorization: `Bearer ${loner.key}` } },
      }),
    );
    const refused = (await other.callTool({
      name: "report_outcome",
      arguments: { result: "accepted" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toMatch(/isn't part of any workflow/);
  });
});

describe("Workflows on disk", () => {
  it("keeps workflows and results, voids included, across a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "purser-wf-"));
    const first = new Workflows(dir);
    const wf = first.create(
      {
        name: "support replies",
        unit: "ticket",
        owner: "Dana",
        agents: ["ag_1"],
        baseline: {
          minutesPerUnit: 30,
          hourlyCostUsd: 60,
          measuredOn: "2026-10-01",
          method: "timestamps",
          source: "measured",
        },
        attribution: "holdout",
        defaultReviewMinutes: 5,
        costs: {
          implementationUsd: 0,
          monthlyMaintenanceUsd: 0,
          monthlyEvaluationUsd: 0,
          discountRate: 0.1,
        },
        stopIf: { metric: "acceptance_rate", when: "below", value: 0.5 },
        minUnits: 30,
        createdBy: "admin",
      },
      "2026-11-01T00:00:00.000Z",
    );
    expect(() =>
      first.create(
        { ...wf, name: "support replies" },
        "2026-11-01T00:00:00.000Z",
      ),
    ).toThrow(/already exists/);
    const { outcome } = first.record({
      workflowId: wf.id,
      at: "2026-11-01T00:00:00.000Z",
      recordedAt: "2026-11-02T00:00:00.000Z",
      result: "accepted",
      count: 3,
      ref: "r1",
      source: "person",
      by: "admin",
    });
    first.record({
      workflowId: wf.id,
      at: "2026-11-03T00:00:00.000Z",
      recordedAt: "2026-11-03T00:00:00.000Z",
      result: "discarded",
      count: 1,
      source: "person",
      by: "admin",
    });
    first.void(outcome.id, "2026-11-04T00:00:00.000Z", "admin");
    expect(() => first.void("out_missing", "x", "y")).toThrow(/No result/);
    expect(() =>
      first.record({ ...outcome, workflowId: "wf_missing" }),
    ).toThrow(/No workflow/);
    expect(() => first.update("wf_missing", {})).toThrow(/No workflow/);

    // A torn last line from a crash is skipped, not fatal.
    const file = join(dir, "outcomes.jsonl");
    const lines = readFileSync(file, "utf8");
    expect(lines.trim().split("\n")).toHaveLength(3);
    appendFileSync(file, '{"id":"out_torn",');

    const second = new Workflows(dir);
    expect(second.get(wf.id)?.lockedAt).toBe("2026-11-02T00:00:00.000Z");
    expect(second.forAgent("ag_1")?.id).toBe(wf.id);
    expect(second.resolve("support replies")?.id).toBe(wf.id);
    const kept = second.outcomesOf(wf.id);
    expect(kept).toHaveLength(2);
    expect(kept[0]?.voidedBy).toBe("admin");
    expect(second.byRef(wf.id, "r1")?.id).toBe(outcome.id);
    expect(second.outcomesOf("wf_none")).toEqual([]);
  });

  it("works with nothing on disk yet, or no directory at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "purser-wf-"));
    expect(new Workflows(dir).list()).toEqual([]);
    expect(new Workflows().list()).toEqual([]);
  });
});
