import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  Outcome,
  RoiReport,
  Workflow,
  WorkflowDetail,
  WorkflowSummary,
} from "../api/types";
import {
  readDraft,
  emptyDraft,
  thresholdText,
  type WorkflowDraft,
} from "../components/Roi";
import { mockFetch, renderWithProviders } from "../test/helpers";
import { RoiReportPage } from "./RoiReport";
import { WorkflowDetailPage } from "./WorkflowDetail";
import { WorkflowsPage } from "./Workflows";

afterEach(() => vi.unstubAllGlobals());

function makeWorkflow(over: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf_1",
    name: "Support replies",
    unit: "support ticket answered",
    owner: "Priya Patel",
    team: "Customer Support",
    agents: ["agt_1"],
    baseline: {
      minutesPerUnit: 12,
      hourlyCostUsd: 42,
      measuredOn: "2026-10-01",
      method: "Ticket timestamps for two weeks",
      source: "measured",
    },
    attribution: "holdout",
    defaultReviewMinutes: 2.5,
    costs: {
      implementationUsd: 9000,
      monthlyMaintenanceUsd: 400,
      monthlyEvaluationUsd: 250,
      discountRate: 0.1,
    },
    stopIf: { metric: "cost_per_accepted_unit", when: "above", value: 6 },
    scaleIf: { metric: "acceptance_rate", when: "above", value: 0.8 },
    minUnits: 200,
    status: "active",
    createdAt: "2026-10-10T00:00:00.000Z",
    createdBy: "admin",
    lockedAt: "2026-10-11T17:00:00.000Z",
    ...over,
  };
}

function makeReport(over: Partial<RoiReport> = {}): RoiReport {
  return {
    workflowId: "wf_1",
    period: { from: "2026-10-26", to: "2026-11-24", days: 30 },
    results: {
      accepted: 4400,
      reworked: 360,
      discarded: 240,
      total: 5000,
      acceptanceRate: 0.88,
      byAgents: 0,
      voided: 0,
    },
    cost: {
      inference: { value: 49.53, label: "measured" },
      review: {
        value: 8750,
        label: "measured",
        minutes: 12500,
        minutesDefaulted: 0,
      },
      upkeep: { value: 641, label: "measured" },
      total: { value: 9440.53, label: "measured" },
      estimatedCalls: 0,
      calls: 812,
    },
    perUnit: {
      baseline: { value: 8.4, label: "measured" },
      costPerAcceptedUnit: { value: 2.15, label: "measured" },
    },
    value: { value: 36960, label: "attributed" },
    netReturn: { value: 27519.47, label: "attributed" },
    netMonthlyReturn: { value: 27920, label: "attributed" },
    projection: {
      paybackMonths: { value: 0.32, label: "modelled" },
      year1RoiPercent: { value: 3622, label: "modelled" },
      threeYearNpv: { value: 824000, label: "modelled" },
      mostSensitive: {
        input: "loadedHourlyCost",
        words: "the hourly cost of the people",
        netAnnualIfChanged: 200000,
        delta: 100000,
      },
      calculatorVersion: "1.0.0",
    },
    verdict: "scale",
    thresholds: {
      stop: {
        metric: "cost_per_accepted_unit",
        when: "above",
        value: 6,
        met: false,
      },
      scale: {
        metric: "acceptance_rate",
        when: "above",
        value: 0.8,
        met: true,
      },
    },
    caveats: [],
    ...over,
  };
}

const summary = (w: Workflow, r: RoiReport): WorkflowSummary => ({
  ...w,
  summary: {
    period: r.period,
    verdict: r.verdict,
    results: r.results.total,
    acceptanceRate: r.results.acceptanceRate,
    costPerAcceptedUnit: r.perUnit.costPerAcceptedUnit,
    baselineCostPerUnit: r.perUnit.baseline,
    netMonthlyReturn: r.netMonthlyReturn,
  },
});

const detail = (w = makeWorkflow(), r = makeReport()): WorkflowDetail => ({
  workflow: w,
  agents: [{ id: "agt_1", name: "reply-drafter-001", state: "running" }],
  report: r,
});

function outcome(over: Partial<Outcome> = {}): Outcome {
  return {
    id: "out_1",
    workflowId: "wf_1",
    at: "2026-11-20T17:00:00.000Z",
    recordedAt: "2026-11-20T17:00:00.000Z",
    result: "accepted",
    count: 160,
    reviewMinutes: 400,
    source: "person",
    by: "priya.patel@example.com",
    note: "Daily tally",
    ...over,
  };
}

describe("WorkflowsPage", () => {
  it("lists workflows with their verdict and labelled numbers", async () => {
    const loss = makeReport({
      verdict: "stop",
      results: { ...makeReport().results, acceptanceRate: null, total: 0 },
      netMonthlyReturn: { value: -617, label: "modelled" },
      perUnit: {
        baseline: { value: 3.17, label: "modelled" },
        costPerAcceptedUnit: { value: null, label: "measured" },
      },
    });
    mockFetch({
      "GET /admin/workflows": () => ({
        workflows: [
          summary(makeWorkflow(), makeReport()),
          summary(makeWorkflow({ id: "wf_2", name: "Invoice matching" }), loss),
        ],
      }),
    });
    renderWithProviders(<WorkflowsPage />);
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("Support replies");
    expect(rows[1]).toHaveTextContent("Scale up");
    expect(rows[1]).toHaveTextContent("88%");
    expect(rows[1]).toHaveTextContent("$2.15");
    expect(rows[2]).toHaveTextContent("Stop");
    expect(rows[2]).toHaveTextContent("None yet");
    expect(rows[2]).toHaveTextContent("Not known yet");
    expect(within(rows[2] as HTMLElement).getByText("-$617.00")).toHaveClass(
      "negative",
    );
    expect(
      within(table).getByRole("link", { name: "Invoice matching" }),
    ).toHaveAttribute("href", "/workflows/Invoice%20matching");
  });

  it("explains workflows when there are none, and switches to archived", async () => {
    const { calls } = mockFetch({
      "GET /admin/workflows": () => ({ workflows: [] }),
    });
    renderWithProviders(<WorkflowsPage />);
    expect(await screen.findByText(/No workflows yet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Archived" }));
    expect(
      await screen.findByText("No archived workflows."),
    ).toBeInTheDocument();
    expect(calls.at(-1)?.url).toBe("/admin/workflows?status=archived");
  });

  it("shows an error when the list can't load", async () => {
    mockFetch({
      "GET /admin/workflows": () => ({
        status: 500,
        body: { error: { code: "internal", message: "Internal error." } },
      }),
    });
    renderWithProviders(<WorkflowsPage />);
    expect(await screen.findByText("Internal error.")).toBeInTheDocument();
  });

  it("creates a workflow from the form and opens it", async () => {
    const created = makeWorkflow({ name: "Code review", lockedAt: undefined });
    const { calls } = mockFetch({
      "GET /admin/workflows": () => ({ workflows: [] }),
      "POST /admin/workflows": () => ({
        status: 201,
        body: { workflow: created, agents: [] },
      }),
    });
    renderWithProviders(<WorkflowsPage />);
    await userEvent.click(
      await screen.findByRole("button", { name: "New workflow" }),
    );
    const dialog = screen.getByRole("dialog", { name: "New workflow" });
    const type = (label: string | RegExp, text: string) =>
      userEvent.type(within(dialog).getByLabelText(label), text);

    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create workflow" }),
    );
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Give the workflow a name.",
    );

    await type("Name", "Code review");
    await type("One unit of work", "pull request reviewed");
    await type("Owner", "Sam Lee");
    await type("Team (optional)", "Engineering");
    await type("Agents", "code-review-001, code-review-002");
    await type("Minutes a person spent on one unit", "25");
    await type("Hourly cost of that time ($)", "95");
    await type("How it was measured", "Review time for August");
    await type("Dollars", "30");
    await userEvent.click(
      within(dialog).getByLabelText("Also set a line for scaling up"),
    );
    await type("Percent", "80");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create workflow" }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/workflows/Code%20review",
      ),
    );
    const body = calls.find((c) => c.method === "POST")?.body as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      name: "Code review",
      team: "Engineering",
      agents: ["code-review-001", "code-review-002"],
      baseline: { minutesPerUnit: 25, hourlyCostUsd: 95, source: "measured" },
      attribution: "before_after",
      stopIf: { metric: "cost_per_accepted_unit", when: "above", value: 30 },
      scaleIf: { metric: "acceptance_rate", when: "above", value: 0.8 },
      costs: { discountRate: 0.1 },
      minUnits: 30,
    });
    expect(body.ownerEmail).toBeUndefined();
  });
});

describe("readDraft", () => {
  const good = (): WorkflowDraft => ({
    ...emptyDraft("2026-11-24"),
    name: "x",
    unit: "u",
    owner: "o",
    minutesPerUnit: "10",
    hourlyCostUsd: "50",
    method: "m",
    stop: { metric: "net_monthly_return", when: "below", value: "-100" },
  });

  it("reads a negative net return line and an optional volume", () => {
    const read = readDraft({
      ...good(),
      unitsPerMonth: "1,200",
      ownerEmail: "o@x.com",
    });
    expect(read).toMatchObject({
      stopIf: { metric: "net_monthly_return", value: -100 },
      baseline: { unitsPerMonth: 1200 },
      ownerEmail: "o@x.com",
    });
  });

  it("names the first problem", () => {
    const cases: [Partial<WorkflowDraft>, RegExp][] = [
      [{ unit: " " }, /unit of work/],
      [{ owner: "" }, /owns it/],
      [{ minutesPerUnit: "0" }, /minutes/],
      [{ hourlyCostUsd: "lots" }, /hourly cost/],
      [{ unitsPerMonth: "many" }, /Units a month/],
      [{ measuredOn: "" }, /day the baseline/],
      [{ method: "" }, /how the baseline/],
      [{ defaultReviewMinutes: "-1" }, /review minutes/i],
      [{ monthlyEvaluationUsd: "x" }, /each cost/],
      [{ discountPercent: "200" }, /discount rate/],
      [
        { stop: { metric: "acceptance_rate", when: "below", value: "120" } },
        /percent from 0 to 100/,
      ],
      [
        {
          stop: {
            metric: "cost_per_accepted_unit",
            when: "above",
            value: "-1",
          },
        },
        /can't be negative/,
      ],
      [
        {
          stop: { metric: "cost_per_accepted_unit", when: "above", value: "" },
        },
        /number for the stop line/,
      ],
      [{ scaleOn: true }, /number for the scale line/],
      [{ minUnits: "1.5" }, /whole number/],
    ];
    for (const [patch, problem] of cases) {
      const read = readDraft({ ...good(), ...patch });
      expect("problem" in read && read.problem).toMatch(problem);
    }
  });

  it("writes thresholds in words", () => {
    expect(
      thresholdText("Scale up", {
        metric: "acceptance_rate",
        when: "above",
        value: 0.85,
      }),
    ).toBe("Scale up if acceptance rate is above 85%");
  });
});

describe("WorkflowDetailPage", () => {
  const route = {
    route: "/workflows/Support%20replies",
    path: "/workflows/:ref",
  };

  it("shows the verdict, numbers, rules, caveats and results", async () => {
    mockFetch({
      "GET /admin/workflows/Support%20replies": () =>
        detail(
          makeWorkflow(),
          makeReport({
            caveats: [
              "25% of results were reported by the agents themselves, not by a person.",
            ],
          }),
        ),
      "GET /admin/workflows/wf_1/outcomes": () => ({
        outcomes: [
          outcome(),
          outcome({
            id: "out_2",
            source: "agent",
            by: "agt_1",
            agentId: "agt_1",
            reviewMinutes: undefined,
            note: undefined,
            ref: "PR-9",
          }),
          outcome({
            id: "out_3",
            voidedAt: "2026-11-21T00:00:00.000Z",
            voidedBy: "admin",
          }),
        ],
        total: 120,
      }),
    });
    renderWithProviders(<WorkflowDetailPage />, route);
    expect(
      await screen.findByRole("heading", { name: "Support replies" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/The scale line is crossed/)).toBeInTheDocument();
    expect(
      screen.getByText("Stop if cost per accepted unit is above $6.00"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Scale up if acceptance rate is above 80%"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/25% of results were reported/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Locked on/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "One-page report" }),
    ).toHaveAttribute("href", "/workflows/Support%20replies/report");
    const results = await screen.findByRole("table");
    expect(screen.getByText("Newest 3 of 120")).toBeInTheDocument();
    expect(within(results).getByText("the agent itself")).toBeInTheDocument();
    expect(within(results).getByText("reply-drafter-001")).toBeInTheDocument();
    expect(within(results).getByText("Default")).toBeInTheDocument();
    expect(within(results).getByText("PR-9")).toBeInTheDocument();
    expect(within(results).getByText(/Voided by admin/)).toBeInTheDocument();
    expect(
      within(results).getAllByRole("button", { name: /^Void / }),
    ).toHaveLength(2);
  });

  it("records a tally, and says when that locked the rules", async () => {
    const { calls } = mockFetch({
      "GET /admin/workflows/Support%20replies": () =>
        detail(makeWorkflow({ lockedAt: undefined })),
      "GET /admin/workflows/wf_1/outcomes": () => ({ outcomes: [], total: 0 }),
      "POST /admin/workflows/wf_1/outcomes": () => ({
        status: 201,
        body: {
          outcome: outcome({ count: 40, result: "reworked" }),
          duplicate: false,
          locked: true,
        },
      }),
    });
    renderWithProviders(<WorkflowDetailPage />, route);
    expect(await screen.findByText(/Not locked yet/)).toBeInTheDocument();
    expect(await screen.findByText("No results yet.")).toBeInTheDocument();
    const count = screen.getByLabelText("How many");
    await userEvent.clear(count);
    await userEvent.type(count, "0");
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/whole number/);
    await userEvent.clear(count);
    await userEvent.type(count, "40");
    await userEvent.type(
      screen.getByLabelText("Review minutes, all together"),
      "x",
    );
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Review minutes/);
    await userEvent.clear(
      screen.getByLabelText("Review minutes, all together"),
    );
    await userEvent.type(
      screen.getByLabelText("Review minutes, all together"),
      "200",
    );
    await userEvent.selectOptions(screen.getByLabelText("Result"), "reworked");
    await userEvent.type(screen.getByLabelText("Day (optional)"), "2026-11-20");
    await userEvent.type(screen.getByLabelText("Note (optional)"), "week 3");
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(
      await screen.findByText(
        "Recorded 40 reworked. That was the first result, so the rules are now locked.",
      ),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      result: "reworked",
      count: 40,
      reviewMinutes: 200,
      note: "week 3",
      at: "2026-11-20T12:00:00.000Z",
    });
  });

  it("voids a result after asking", async () => {
    const { calls } = mockFetch({
      "GET /admin/workflows/Support%20replies": () => detail(),
      "GET /admin/workflows/wf_1/outcomes": () => ({
        outcomes: [outcome()],
        total: 1,
      }),
      "POST /admin/workflows/wf_1/outcomes/out_1/void": () => ({
        outcome: outcome({
          voidedAt: "2026-11-24T00:00:00Z",
          voidedBy: "admin",
        }),
      }),
    });
    renderWithProviders(<WorkflowDetailPage />, route);
    await userEvent.click(
      await screen.findByRole("button", { name: /^Void 160 accepted/ }),
    );
    const dialog = screen.getByRole("dialog", { name: "Void this result?" });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /^Void 160 accepted/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Void it" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith("/out_1/void"))).toBe(true),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("edits a locked workflow with the rules shown but not editable, and archives it", async () => {
    const { calls } = mockFetch({
      "GET /admin/workflows/Support%20replies": () => detail(),
      "GET /admin/workflows/wf_1/outcomes": () => ({ outcomes: [], total: 0 }),
      "PATCH /admin/workflows/wf_1": (call) => ({
        workflow: makeWorkflow({
          ...(call.body as Partial<Workflow>),
          name: (call.body as { name?: string }).name ?? "Support replies",
        }),
        agents: [],
      }),
    });
    renderWithProviders(<WorkflowDetailPage />, route);
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Support replies" });
    expect(
      within(dialog).getByLabelText("Minutes a person spent on one unit"),
    ).toBeDisabled();
    expect(within(dialog).getByText(/locked on/)).toBeInTheDocument();
    const maintenance = within(dialog).getByLabelText(
      "Maintenance a month ($)",
    );
    expect(maintenance).toBeEnabled();
    await userEvent.clear(maintenance);
    await userEvent.type(maintenance, "450");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("Saved Support replies."),
    ).toBeInTheDocument();
    const patch = calls.find((c) => c.method === "PATCH")?.body as Record<
      string,
      unknown
    >;
    expect(patch).toMatchObject({
      costs: { monthlyMaintenanceUsd: 450 },
      ownerEmail: null,
      agents: ["reply-drafter-001"],
      scaleIf: { metric: "acceptance_rate", value: 0.8 },
    });

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(
      await screen.findByText(
        "Archived Support replies. Its agents can join another workflow.",
      ),
    ).toBeInTheDocument();
    expect(
      calls.some(
        (c) =>
          (c.body as { status?: string } | undefined)?.status === "archived",
      ),
    ).toBe(true);
  });

  it("takes no results once archived, and can reopen", async () => {
    const { calls } = mockFetch({
      "GET /admin/workflows/Support%20replies": () =>
        detail(
          makeWorkflow({ status: "archived", scaleIf: undefined }),
          makeReport({ verdict: "too_early" }),
        ),
      "GET /admin/workflows/wf_1/outcomes": () => ({ outcomes: [], total: 0 }),
      "PATCH /admin/workflows/wf_1": () => ({
        workflow: makeWorkflow(),
        agents: [],
      }),
    });
    renderWithProviders(<WorkflowDetailPage />, route);
    expect(
      await screen.findByText(/archived and takes no more results/),
    ).toBeInTheDocument();
    expect(screen.getByText("None set")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(
      await screen.findByText("Reopened Support replies."),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
      status: "active",
    });
  });

  it("shows an error for a workflow that isn't there", async () => {
    mockFetch({});
    renderWithProviders(<WorkflowDetailPage />, {
      route: "/workflows/ghost",
      path: "/workflows/:ref",
    });
    expect(await screen.findByText(/No mock for GET/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "All workflows" }),
    ).toBeInTheDocument();
  });
});

describe("RoiReportPage", () => {
  const route = {
    route: "/workflows/Support%20replies/report",
    path: "/workflows/:ref/report",
  };

  it("lays out the five sections, with the stop number and labels", async () => {
    mockFetch({
      "GET /admin/workflows/Support%20replies/report": () =>
        detail(
          makeWorkflow({
            baseline: { ...makeWorkflow().baseline, unitsPerMonth: 6000 },
          }),
          makeReport({
            caveats: [
              "The baseline is an estimate, so value and net return are modelled.",
            ],
            cost: {
              ...makeReport().cost,
              review: {
                value: 100,
                label: "modelled",
                minutes: 200,
                minutesDefaulted: 50,
              },
            },
          }),
        ),
    });
    renderWithProviders(<RoiReportPage />, route);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Support replies" }),
    ).toBeInTheDocument();
    const sections = screen
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent);
    expect(sections).toEqual([
      "1. The workflow and its unit",
      "2. The baseline",
      "3. Attribution",
      "4. The full cost",
      "5. Net return, with caveats",
    ]);
    expect(screen.getByText(/about 6,000 units a month/)).toBeInTheDocument();
    expect(
      screen.getByText(/Part of the work was kept away/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("200 minutes, 50 of them the default"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/the hourly cost of the people/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The number that would stop this program:"),
    ).toBeInTheDocument();
    expect(screen.getByText(/It is not crossed/)).toBeInTheDocument();
    expect(screen.getByText(/crossed\.$/)).toBeInTheDocument();
    expect(screen.getByText("0.3 months")).toBeInTheDocument();
    expect(screen.getByText("3,622%")).toBeInTheDocument();
    expect(screen.getByText(/The baseline is an estimate/)).toBeInTheDocument();
    expect(screen.getAllByText("modelled").length).toBeGreaterThan(2);
  });

  it("changes the period and prints", async () => {
    const print = vi.fn();
    vi.stubGlobal("print", print);
    const { calls } = mockFetch({
      "GET /admin/workflows/Support%20replies/report": () =>
        detail(
          makeWorkflow({ lockedAt: undefined, scaleIf: undefined }),
          makeReport({
            verdict: "too_early",
            thresholds: { ...makeReport().thresholds, scale: null },
            projection: {
              ...makeReport().projection,
              mostSensitive: null,
              paybackMonths: { value: null, label: "modelled" },
              year1RoiPercent: { value: null, label: "modelled" },
            },
          }),
        ),
    });
    renderWithProviders(<RoiReportPage />, route);
    expect(
      await screen.findByText(/no results have arrived/),
    ).toBeInTheDocument();
    expect(screen.getByText("No caveats for this period.")).toBeInTheDocument();
    expect(screen.getByText("Never, at this rate")).toBeInTheDocument();
    expect(
      screen.getByText("No implementation cost to compare"),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("From"), "2026-11-01");
    await userEvent.type(screen.getByLabelText("To"), "2026-11-30");
    await userEvent.click(screen.getByRole("button", { name: "Show" }));
    await waitFor(() =>
      expect(calls.at(-1)?.url).toBe(
        "/admin/workflows/Support%20replies/report?from=2026-11-01&to=2026-11-30",
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Print" }));
    expect(print).toHaveBeenCalled();
  });

  it("shows an error for a bad period", async () => {
    mockFetch({
      "GET /admin/workflows/Support%20replies/report": () => ({
        status: 400,
        body: {
          error: {
            code: "invalid_request",
            message: "from must not be after to.",
          },
        },
      }),
    });
    renderWithProviders(<RoiReportPage />, route);
    expect(
      await screen.findByText("from must not be after to."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back" })).toBeInTheDocument();
  });
});
