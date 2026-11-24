import { describe, expect, it } from "vitest";
import { DEFAULT_PRICES } from "./prices.js";
import { buildReport, defaultPeriod } from "./roi.js";
import { generateSeed, rng } from "./seed.js";
import { generateWorkflows } from "./seed-workflows.js";

describe("demo workflows", () => {
  const now = new Date("2026-11-24T15:00:00Z");
  const seed = generateSeed({
    agents: 600,
    days: 30,
    now,
    prices: DEFAULT_PRICES,
  });
  const { workflows, outcomes } = seed.workflows;

  it("show one of each verdict, from the agents' own spend", () => {
    const verdicts = Object.fromEntries(
      workflows.map((w) => {
        const r = buildReport(
          w,
          outcomes.filter((o) => o.workflowId === w.id),
          seed.usage.filter((u) => w.agents.includes(u.agentId)),
          defaultPeriod(now),
        );
        expect(r.cost.calls).toBeGreaterThan(0);
        return [w.name, r.verdict];
      }),
    );
    expect(verdicts).toEqual({
      "Support replies": "scale",
      "Code review": "continue",
      "Invoice matching": "stop",
      "Lead research": "too_early",
    });
  });

  it("lock each workflow at its first result, after it was set up", () => {
    for (const w of workflows) {
      const first = outcomes.find((o) => o.workflowId === w.id);
      expect(w.lockedAt).toBe(first?.recordedAt);
      expect(Date.parse(w.lockedAt ?? "")).toBeGreaterThan(
        Date.parse(w.createdAt),
      );
    }
    expect(seed.audit.filter((e) => e.type === "workflow.locked")).toHaveLength(
      4,
    );
  });

  it("skip a workflow with no agents of its kind", () => {
    expect(generateWorkflows([], now, rng(1)).workflows).toEqual([]);
  });
});
