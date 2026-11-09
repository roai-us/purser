import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DepartmentRow, DepartmentsPage as Page } from "../api/types";
import { BudgetBar, DepartmentsPage } from "./Departments";
import {
  makeConnector,
  mockFetch,
  must,
  renderWithProviders,
} from "../test/helpers";

afterEach(() => vi.unstubAllGlobals());

function makeDepartment(overrides: Partial<DepartmentRow> = {}): DepartmentRow {
  return {
    name: "Marketing",
    policy: { autoApproveDailyUsd: 2, maxDailyUsd: 25 },
    people: 12,
    managers: [{ name: "Dana Ortiz", email: "dana@example.com" }],
    pending: 0,
    agents: 6,
    green: 4,
    yellow: 1,
    red: 1,
    spendMonth: 80,
    spendToday: 3.5,
    ...overrides,
  };
}

const defaults = { autoApproveDailyUsd: 2, maxDailyUsd: 25 };

function page(overrides: Partial<Page> = {}): Page {
  return {
    defaults,
    selfService: true,
    items: [
      makeDepartment({
        name: "Support",
        budgetMonthlyUsd: 100,
        spendMonth: 130,
        pending: 3,
      }),
      makeDepartment({ budgetMonthlyUsd: 200 }),
      makeDepartment({
        name: "Finance",
        managers: [],
        selfService: {
          autoApproveDailyUsd: 0,
          maxDailyUsd: 10.5,
          allowedProviders: ["openrouter", "openai"],
        },
        policy: {
          autoApproveDailyUsd: 0,
          maxDailyUsd: 10.5,
          allowedProviders: ["openrouter", "openai"],
        },
      }),
    ],
    ...overrides,
  };
}

function setup(
  data: Page = page(),
  extra: Parameters<typeof mockFetch>[0] = {},
) {
  const fetched = mockFetch({
    "GET /admin/departments": () => data,
    "GET /admin/providers": () => [
      makeConnector(),
      makeConnector({ id: "anthropic", name: "Anthropic" }),
      makeConnector({ id: "openai", name: "OpenAI", configured: false }),
    ],
    ...extra,
  });
  const utils = renderWithProviders(<DepartmentsPage />, {
    route: "/departments",
  });
  return { ...fetched, ...utils };
}

const rowOf = (name: string) =>
  within(
    must(
      screen.getByRole("rowheader", { name }).closest("tr"),
      "row",
    ) as HTMLElement,
  );

describe("BudgetBar", () => {
  it("shows spend without a budget, near it and over it", () => {
    const { rerender, container } = render(<BudgetBar spent={5} />);
    expect(screen.getByText("no budget")).toBeInTheDocument();
    rerender(<BudgetBar spent={90} budget={100} />);
    expect(container.querySelector(".spend-fill.high")).not.toBeNull();
    rerender(<BudgetBar spent={100} budget={100} />);
    expect(container.querySelector(".spend-fill.full")).not.toBeNull();
    rerender(<BudgetBar spent={1} budget={0} />);
    expect(screen.getByText("Over budget by $1.00")).toBeInTheDocument();
  });
});

describe("Departments page", () => {
  it("lists departments by name with lights, budgets, people and rules", async () => {
    setup();
    await screen.findByRole("rowheader", { name: "Finance" });
    expect(screen.getByText("3 departments")).toBeInTheDocument();
    const names = screen
      .getAllByRole("rowheader")
      .map((cell) => cell.textContent);
    expect(names).toEqual(["Finance", "Marketing", "Support"]);

    const marketing = rowOf("Marketing");
    expect(marketing.getByText("4")).toBeInTheDocument();
    expect(
      marketing.getByText("running", { exact: false }),
    ).toBeInTheDocument();
    expect(marketing.getByText("of $200.00")).toBeInTheDocument();
    expect(marketing.getByText("$3.50")).toBeInTheDocument();
    expect(marketing.getByText("12")).toBeInTheDocument();
    expect(marketing.getByText("Dana Ortiz")).toBeInTheDocument();
    expect(
      marketing.getByText("Ready up to $2/day, max $25/day"),
    ).toBeInTheDocument();
    expect(marketing.getByText("Default rules")).toBeInTheDocument();
    expect(marketing.getAllByText("None")).toHaveLength(1);

    const support = rowOf("Support");
    expect(support.getByText("Over budget by $30.00")).toBeInTheDocument();
    expect(
      support.getByRole("link", { name: "3 requests waiting in Support" }),
    ).toHaveAttribute("href", "/approvals?department=Support");

    const finance = rowOf("Finance");
    expect(
      finance.getByText("Always needs a manager, max $10.50/day"),
    ).toBeInTheDocument();
    expect(finance.getByText("Only OpenRouter, OpenAI")).toBeInTheDocument();
    expect(finance.getByText("Own rules")).toHaveClass("rule-tag", "own");
    expect(finance.getAllByText("None")).toHaveLength(2);
    expect(
      screen.queryByText(/can't ask for agents themselves/),
    ).not.toBeInTheDocument();
  });

  it("says when people can't ask for agents yet", async () => {
    setup(
      page({
        selfService: false,
        items: [makeDepartment({ pending: 1 })],
      }),
    );
    expect(
      await screen.findByText(/can't ask for agents themselves yet/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(screen.getByText("1 department")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "1 request waiting in Marketing" }),
    ).toBeInTheDocument();
  });

  it("filters by name, and says when nothing matches", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByRole("rowheader", { name: "Finance" });
    await user.type(screen.getByLabelText("Search"), "sup");
    expect(screen.getAllByRole("rowheader")).toHaveLength(1);
    expect(screen.getByRole("rowheader", { name: "Support" })).toBeVisible();
    await user.type(screen.getByLabelText("Search"), "zzz");
    expect(
      screen.getByText("No departments match this search."),
    ).toBeInTheDocument();
  });

  it("explains an empty list and shows load errors", async () => {
    setup(page({ items: [] }));
    expect(await screen.findByText(/No departments yet/)).toBeInTheDocument();
    vi.unstubAllGlobals();

    mockFetch({
      "GET /admin/departments": () => ({
        status: 500,
        body: { error: { code: "x", message: "Departments broke." } },
      }),
      "GET /admin/providers": () => [],
    });
    renderWithProviders(<DepartmentsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Departments broke.",
    );
  });

  it("gives a department a budget and its own rules", async () => {
    const user = userEvent.setup();
    const { calls } = setup(page(), {
      "PUT /admin/departments/Marketing": (call) => call.body,
    });
    await screen.findByRole("rowheader", { name: "Marketing" });
    await user.click(screen.getByRole("button", { name: "Edit Marketing" }));
    const edit = within(screen.getByRole("dialog", { name: "Edit Marketing" }));
    const budget = edit.getByLabelText("Monthly budget ($)");
    expect(budget).toHaveValue("200");
    await user.clear(budget);
    await user.type(budget, "$1,500");
    expect(edit.getByLabelText(/default rules/)).toBeChecked();
    expect(
      edit.queryByLabelText(/Ready straight away/),
    ).not.toBeInTheDocument();
    await user.click(edit.getByLabelText(/Own rules/));

    const auto = edit.getByLabelText(/Ready straight away/);
    const max = edit.getByLabelText(/Nobody can ask for more than/);
    expect(auto).toHaveValue("2");
    expect(max).toHaveValue("25");
    // Only configured providers can be picked.
    expect(edit.queryByLabelText("OpenAI")).not.toBeInTheDocument();
    await user.clear(auto);
    await user.type(auto, "40");
    await user.click(edit.getByRole("button", { name: "Save" }));
    expect(edit.getByRole("alert")).toHaveTextContent(
      "can't be more than the most anyone can ask for",
    );
    expect(calls.some((c) => c.method === "PUT")).toBe(false);

    await user.clear(auto);
    await user.type(auto, "5");
    await user.clear(max);
    await user.type(max, "50");
    await user.click(edit.getByLabelText("Anthropic"));
    await user.click(edit.getByLabelText("OpenRouter"));
    await user.click(edit.getByLabelText("OpenRouter"));
    await user.click(edit.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("Saved the rules for Marketing."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(must(calls.find((c) => c.method === "PUT")).body).toEqual({
      budgetMonthlyUsd: 1500,
      selfService: {
        autoApproveDailyUsd: 5,
        maxDailyUsd: 50,
        allowedProviders: ["anthropic"],
      },
    });
  });

  it("goes back to the default rules with no budget", async () => {
    const user = userEvent.setup();
    const { calls } = setup(page(), {
      "PUT /admin/departments/Finance": () => ({
        status: 400,
        body: {
          error: { code: "x", message: "Check the department's rules." },
        },
      }),
    });
    await screen.findByRole("rowheader", { name: "Finance" });
    await user.click(screen.getByRole("button", { name: "Edit Finance" }));
    const edit = within(screen.getByRole("dialog"));
    expect(edit.getByLabelText(/Own rules/)).toBeChecked();
    // A provider that is no longer set up still shows, so it can be unticked.
    expect(edit.getByLabelText("OpenAI")).toBeChecked();
    expect(edit.getByLabelText("OpenRouter")).toBeChecked();
    expect(edit.getByLabelText(/Ready straight away/)).toHaveValue("0");
    await user.click(edit.getByLabelText(/default rules/));
    await user.click(edit.getByRole("button", { name: "Save" }));
    expect(await edit.findByRole("alert")).toHaveTextContent(
      "Check the department's rules.",
    );
    expect(must(calls.find((c) => c.method === "PUT")).body).toEqual({
      budgetMonthlyUsd: null,
      selfService: null,
    });
    await user.click(edit.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("checks the budget and the amounts before saving", async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    await screen.findByRole("rowheader", { name: "Support" });
    await user.click(screen.getByRole("button", { name: "Edit Support" }));
    const edit = within(screen.getByRole("dialog"));
    const budget = edit.getByLabelText("Monthly budget ($)");
    await user.clear(budget);
    await user.type(budget, "lots");
    await user.click(edit.getByRole("button", { name: "Save" }));
    expect(edit.getByRole("alert")).toHaveTextContent(
      "Enter the monthly budget in dollars",
    );

    await user.clear(budget);
    await user.click(edit.getByLabelText(/Own rules/));
    const auto = edit.getByLabelText(/Ready straight away/);
    const max = edit.getByLabelText(/Nobody can ask for more than/);
    await user.clear(auto);
    await user.click(edit.getByRole("button", { name: "Save" }));
    expect(edit.getByRole("alert")).toHaveTextContent(
      "Enter how much is ready straight away",
    );
    await user.type(auto, "1");
    await user.clear(max);
    await user.type(max, "0");
    await user.click(edit.getByRole("button", { name: "Save" }));
    expect(edit.getByRole("alert")).toHaveTextContent(
      "Enter the most anyone can ask for per day",
    );
    await user.clear(max);
    await user.type(max, "200000");
    await user.click(edit.getByRole("button", { name: "Save" }));
    expect(edit.getByRole("alert")).toHaveTextContent("$100,000");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
});
