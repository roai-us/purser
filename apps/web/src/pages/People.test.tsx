import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DepartmentsPage, OffboardResult, PersonRow } from "../api/types";
import { PeoplePage, offboardSummary, peopleQueryFromParams } from "./People";
import {
  mockFetch,
  must,
  renderWithProviders,
  type Call,
} from "../test/helpers";

afterEach(() => vi.unstubAllGlobals());

/** Overrides may set a field to undefined to leave it out. */
type Overrides = { [K in keyof PersonRow]?: PersonRow[K] | undefined };

function makePerson(overrides: Overrides = {}): PersonRow {
  const person: Record<string, unknown> = {
    id: "per_1",
    email: "dana@example.com",
    name: "Dana Ortiz",
    role: "member",
    department: "Marketing",
    status: "active",
    source: "sso",
    createdAt: "2026-10-01T10:00:00.000Z",
    lastSignInAt: "2026-11-07T10:00:00.000Z",
    agents: 4,
    running: 3,
    spendMonth: 12.5,
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(person).filter(([, value]) => value !== undefined),
  ) as unknown as PersonRow;
}

const departments: DepartmentsPage = {
  defaults: { autoApproveDailyUsd: 2, maxDailyUsd: 25 },
  selfService: true,
  items: ["Marketing", "Support"].map((name) => ({
    name,
    policy: { autoApproveDailyUsd: 2, maxDailyUsd: 25 },
    people: 3,
    managers: [],
    pending: 0,
    agents: 0,
    green: 0,
    yellow: 0,
    red: 0,
    spendMonth: 0,
    spendToday: 0,
  })),
};

function setup(
  route = "/people",
  people: PersonRow[] = [
    makePerson(),
    makePerson({
      id: "per_2",
      email: "sam@example.com",
      name: "Sam Lee",
      role: "manager",
      department: undefined,
      manages: ["Support"],
      agents: 0,
      running: 0,
      spendMonth: 0,
      lastSignInAt: undefined,
    }),
  ],
  extra: Parameters<typeof mockFetch>[0] = {},
  total = people.length,
) {
  const state = { people: [...people] };
  const fetched = mockFetch({
    "GET /admin/people": (call: Call) => {
      const url = new URL(call.url, "http://localhost");
      const q = url.searchParams.get("q");
      const items = q
        ? state.people.filter((p) =>
            `${p.name} ${p.email}`.toLowerCase().includes(q.toLowerCase()),
          )
        : state.people;
      return {
        items,
        total: q ? items.length : total,
        page: Number(url.searchParams.get("page") ?? 1),
        pageSize: Number(url.searchParams.get("pageSize") ?? 50),
      };
    },
    "GET /admin/departments": () => departments,
    ...extra,
  });
  const utils = renderWithProviders(<PeoplePage />, { route });
  return { ...fetched, ...utils, state };
}

const location = () => screen.getByTestId("location").textContent ?? "";
const panel = () =>
  screen.getByRole("complementary", { name: "Person details" });
const dialog = () => screen.getByRole("dialog");

describe("peopleQueryFromParams", () => {
  it("reads filters and paging, ignoring junk", () => {
    expect(
      peopleQueryFromParams(
        new URLSearchParams(
          "q=dana&role=manager&department=Support&status=disabled&page=3&pageSize=200",
        ),
      ),
    ).toEqual({
      q: "dana",
      role: "manager",
      department: "Support",
      status: "disabled",
      page: 3,
      pageSize: 200,
    });
    expect(
      peopleQueryFromParams(
        new URLSearchParams("role=boss&status=gone&page=-2&pageSize=7"),
      ),
    ).toEqual({ page: 1, pageSize: 50 });
  });
});

describe("offboardSummary", () => {
  const person = makePerson({ status: "disabled" });
  const result = (r: Partial<OffboardResult>): OffboardResult => ({
    person,
    stopped: 0,
    reassigned: 0,
    sessionsEnded: 0,
    ...r,
  });

  it("says what was stopped or handed over, and the sign-outs", () => {
    expect(offboardSummary(result({ stopped: 4, sessionsEnded: 2 }))).toBe(
      "Stopped 4 agents and signed them out of 2 sessions.",
    );
    expect(offboardSummary(result({ stopped: 1 }))).toBe(
      "Stopped 1 agent. They were not signed in anywhere.",
    );
    expect(offboardSummary(result({ sessionsEnded: 1 }))).toBe(
      "No agents needed stopping. Signed them out of 1 session.",
    );
    expect(offboardSummary(result({ reassigned: 4 }), "Sam Lee")).toBe(
      "Handed 4 agents to Sam Lee. They were not signed in anywhere.",
    );
    expect(
      offboardSummary(result({ reassigned: 1, sessionsEnded: 3 }), "Sam"),
    ).toBe("Handed 1 agent to Sam. Signed them out of 3 sessions.");
  });
});

describe("People page", () => {
  it("lists people with role, agents, spend, last sign-in and status", async () => {
    setup();
    expect(
      await screen.findByRole("button", { name: "Dana Ortiz" }),
    ).toBeInTheDocument();
    expect(screen.getByText("2 people")).toBeInTheDocument();
    const rows = screen.getAllByRole("row");
    const dana = within(must(rows[1]));
    expect(dana.getByText("dana@example.com")).toBeInTheDocument();
    expect(dana.getByText("Member")).toBeInTheDocument();
    expect(dana.getByText("Marketing")).toBeInTheDocument();
    expect(dana.getByText("3 running")).toBeInTheDocument();
    expect(dana.getByText("$12.50")).toBeInTheDocument();
    expect(dana.getByText("Active")).toBeInTheDocument();
    const sam = within(must(rows[2]));
    expect(sam.getByText("Manager")).toBeInTheDocument();
    expect(sam.getByText("None")).toBeInTheDocument();
    expect(sam.getByText("Never")).toBeInTheDocument();
    expect(sam.queryByText(/running/)).not.toBeInTheDocument();
    expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
  });

  it("says one person, and shows an empty list", async () => {
    setup("/people", [makePerson()]);
    expect(await screen.findByText("1 person")).toBeInTheDocument();
    vi.unstubAllGlobals();

    setup("/people?status=disabled", []);
    expect(
      await screen.findByText("No people match these filters."),
    ).toBeInTheDocument();
  });

  it("explains how people arrive when there are none", async () => {
    setup("/people", []);
    expect(await screen.findByText(/No people yet/)).toBeInTheDocument();
  });

  it("shows an error when the list can't load", async () => {
    mockFetch({
      "GET /admin/people": () => ({
        status: 500,
        body: { error: { code: "boom", message: "The list broke." } },
      }),
      "GET /admin/departments": () => departments,
    });
    renderWithProviders(<PeoplePage />, { route: "/people" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The list broke.",
    );
  });

  it("passes the filters in the address to the server", async () => {
    const { calls } = setup(
      "/people?role=manager&department=Finance&status=active&page=2&pageSize=100",
    );
    await screen.findByRole("button", { name: "Dana Ortiz" });
    const url = must(calls.find((c) => c.url.startsWith("/admin/people"))).url;
    expect(url).toContain("role=manager");
    expect(url).toContain("department=Finance");
    expect(url).toContain("status=active");
    expect(url).toContain("page=2");
    expect(url).toContain("pageSize=100");
    // A department that isn't in the list yet still shows as chosen.
    expect(screen.getByLabelText("Department")).toHaveValue("Finance");
  });

  it("writes filters and search into the address", async () => {
    const user = userEvent.setup();
    const { calls } = setup("/people?page=2");
    await screen.findByRole("button", { name: "Dana Ortiz" });
    await screen.findByRole("option", { name: "Support" });

    await user.selectOptions(screen.getByLabelText("Role"), "admin");
    expect(location()).toContain("role=admin");
    expect(location()).not.toContain("page=");
    await user.selectOptions(screen.getByLabelText("Department"), "Support");
    expect(location()).toContain("department=Support");
    await user.selectOptions(screen.getByLabelText("Status"), "disabled");
    expect(location()).toContain("status=disabled");

    await user.type(screen.getByLabelText("Search"), "sam");
    await waitFor(() => expect(location()).toContain("q=sam"));
    await waitFor(() => expect(calls.at(-1)?.url).toContain("q=sam"));

    await user.selectOptions(screen.getByLabelText("Role"), "");
    expect(location()).not.toContain("role=");
  });

  it("pages through thousands of people", async () => {
    const user = userEvent.setup();
    setup("/people", [makePerson()], {}, 2400);
    await screen.findByRole("button", { name: "Dana Ortiz" });
    expect(screen.getByText("2,400 people")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 48")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(location()).toContain("page=2");
    await screen.findByText("Page 2 of 48");
    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(location()).toContain("page=1");

    await user.selectOptions(screen.getByLabelText("Rows per page"), "200");
    expect(location()).toContain("pageSize=200");
    await screen.findByText("Page 1 of 12");
  });

  it("adds a manager with the departments they manage", async () => {
    const user = userEvent.setup();
    const { calls } = setup("/people", [makePerson()], {
      "POST /admin/people": (call) => ({
        status: 201,
        body: {
          ...makePerson(),
          ...(call.body as object),
          id: "per_9",
        },
      }),
    });
    await screen.findByRole("button", { name: "Dana Ortiz" });
    await user.click(screen.getByRole("button", { name: "Add person" }));
    const add = within(dialog());
    await user.type(add.getByLabelText("Email"), " ana@example.com ");
    await user.type(add.getByLabelText("Name"), "Ana Park");
    expect(
      add.queryByLabelText("Departments they manage"),
    ).not.toBeInTheDocument();
    await user.selectOptions(add.getByLabelText("Role"), "manager");
    expect(add.getByText(/Decides on agent requests/)).toBeInTheDocument();
    await user.type(add.getByLabelText("Department"), "Support");
    await user.type(
      add.getByLabelText("Departments they manage"),
      "Support, Customer Care, Support,",
    );
    await user.click(add.getByRole("button", { name: "Add person" }));

    await screen.findByText("Added Ana Park.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(must(calls.find((c) => c.method === "POST")).body).toEqual({
      email: "ana@example.com",
      name: "Ana Park",
      role: "manager",
      department: "Support",
      manages: ["Support", "Customer Care"],
    });
  });

  it("adds a member without a department, and shows a clash", async () => {
    const user = userEvent.setup();
    const { calls } = setup("/people", [makePerson()], {
      "POST /admin/people": () => ({
        status: 409,
        body: {
          error: {
            code: "email_taken",
            message: "ana@example.com is already in Purser.",
          },
        },
      }),
    });
    await screen.findByRole("button", { name: "Dana Ortiz" });
    await user.click(screen.getByRole("button", { name: "Add person" }));
    const add = within(dialog());
    await user.type(add.getByLabelText("Email"), "ana@example.com");
    await user.type(add.getByLabelText("Name"), "Ana");
    await user.click(add.getByRole("button", { name: "Add person" }));
    expect(await add.findByRole("alert")).toHaveTextContent(
      "ana@example.com is already in Purser.",
    );
    expect(must(calls.find((c) => c.method === "POST")).body).toEqual({
      email: "ana@example.com",
      name: "Ana",
      role: "member",
    });
    await user.click(add.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens a person's panel and edits them", async () => {
    const user = userEvent.setup();
    const { calls } = setup("/people", undefined, {
      "PATCH /admin/people/per_2": (call) => ({
        ...makePerson({ id: "per_2", email: "sam@example.com" }),
        ...(call.body as object),
        department: "Support",
      }),
    });
    await user.click(await screen.findByRole("button", { name: "Sam Lee" }));
    expect(location()).toContain("person=per_2");
    const details = within(panel());
    expect(details.getByText("sam@example.com")).toBeInTheDocument();
    expect(details.getByText("Support")).toBeInTheDocument();
    expect(details.getByText("Company sign-in")).toBeInTheDocument();

    await user.click(details.getByText("Edit details"));
    const name = details.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Sam Lee-Park");
    await user.type(details.getByLabelText("Department"), "Support");
    const manages = details.getByLabelText("Departments they manage");
    expect(manages).toHaveValue("Support");
    await user.type(manages, ", Sales");
    await user.click(details.getByRole("button", { name: "Save changes" }));

    expect(await details.findByText("Saved.")).toBeInTheDocument();
    expect(must(calls.find((c) => c.method === "PATCH")).body).toEqual({
      name: "Sam Lee-Park",
      role: "manager",
      department: "Support",
      manages: ["Support", "Sales"],
    });
    expect(
      details.getByRole("heading", { name: "Sam Lee-Park" }),
    ).toBeInTheDocument();
  });

  it("clears the department and managed departments when made a member", async () => {
    const user = userEvent.setup();
    const { calls } = setup("/people?person=per_1", undefined, {
      "PATCH /admin/people/per_1": () => ({
        status: 400,
        body: { error: { code: "invalid_request", message: "Check it." } },
      }),
    });
    const details = within(await screen.findByRole("complementary"));
    await user.click(details.getByText("Edit details"));
    await user.clear(details.getByLabelText("Department"));
    await user.click(details.getByRole("button", { name: "Save changes" }));
    expect(await details.findByRole("alert")).toHaveTextContent("Check it.");
    expect(must(calls.find((c) => c.method === "PATCH")).body).toEqual({
      name: "Dana Ortiz",
      role: "member",
      department: null,
      manages: [],
    });
  });

  it("closes the panel with its button or Escape", async () => {
    const user = userEvent.setup();
    setup("/people?person=per_1");
    await screen.findByRole("complementary");
    await user.click(screen.getByRole("button", { name: "Close details" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(location()).not.toContain("person=");

    await user.click(screen.getByRole("button", { name: "Dana Ortiz" }));
    expect(screen.getByRole("complementary")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("turns off a leaver and stops their agents", async () => {
    const user = userEvent.setup();
    const { calls, state } = setup("/people?person=per_1", undefined, {
      "POST /admin/people/per_1/disable": () => {
        const person = makePerson({
          status: "disabled",
          running: 0,
          disabledAt: "2026-11-08T09:00:00.000Z",
          disabledBy: "admin@example.com",
        });
        state.people[0] = person;
        return { person, stopped: 4, reassigned: 0, sessionsEnded: 2 };
      },
    });
    const details = within(await screen.findByRole("complementary"));
    await user.click(details.getByRole("button", { name: "Turn off access" }));
    const off = within(dialog());
    expect(
      off.getByText(/signs Dana Ortiz out everywhere/),
    ).toBeInTheDocument();
    expect(off.getByLabelText(/Stop their 4 agents/)).toBeChecked();
    await user.click(off.getByRole("button", { name: "Turn off access" }));

    expect(await off.findByRole("status")).toHaveTextContent(
      "Stopped 4 agents and signed them out of 2 sessions.",
    );
    expect(must(calls.find((c) => c.url.endsWith("/disable"))).body).toEqual(
      {},
    );
    await user.click(off.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      details.getByRole("button", { name: "Turn access back on" }),
    ).toBeInTheDocument();
    expect(details.getByText(/by admin@example.com/)).toBeInTheDocument();
  });

  it("hands a leaver's agents to someone else", async () => {
    const user = userEvent.setup();
    const { calls } = setup("/people?person=per_1&status=active", undefined, {
      "POST /admin/people/per_1/disable": () => ({
        person: makePerson({ status: "disabled" }),
        stopped: 0,
        reassigned: 4,
        sessionsEnded: 1,
      }),
    });
    const details = within(await screen.findByRole("complementary"));
    await user.click(details.getByRole("button", { name: "Turn off access" }));
    const off = within(dialog());
    await user.click(off.getByLabelText(/Hand them to someone else/));
    const to = off.getByLabelText("Hand their agents to");

    await user.click(off.getByRole("button", { name: "Turn off access" }));
    expect(off.getByRole("alert")).toHaveTextContent(
      "Enter the email of the person who takes over the agents.",
    );
    await user.type(to, "DANA@example.com");
    await user.click(off.getByRole("button", { name: "Turn off access" }));
    expect(off.getByRole("alert")).toHaveTextContent("Pick someone else");

    await user.clear(to);
    await user.type(to, "sam@example.com");
    // Suggestions come from active people matching what was typed.
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.url.includes("q=sam") && c.url.includes("status=active"),
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(
        document.querySelector('datalist option[value="sam@example.com"]'),
      ).not.toBeNull(),
    );
    await user.click(off.getByRole("button", { name: "Turn off access" }));

    expect(await off.findByRole("status")).toHaveTextContent(
      "Handed 4 agents to Sam Lee. Signed them out of 1 session.",
    );
    expect(must(calls.find((c) => c.url.endsWith("/disable"))).body).toEqual({
      reassignTo: "sam@example.com",
    });
    // The person dropped out of the "active" list, but the panel stays open.
    expect(screen.getByRole("complementary")).toBeInTheDocument();
  });

  it("names the new owner by what was typed when there is no suggestion", async () => {
    const user = userEvent.setup();
    setup("/people?person=per_1", undefined, {
      "POST /admin/people/per_1/disable": () => ({
        status: 400,
        body: {
          error: {
            code: "invalid_reassign",
            message: "Pick someone else who is still active.",
          },
        },
      }),
    });
    const details = within(await screen.findByRole("complementary"));
    await user.click(details.getByRole("button", { name: "Turn off access" }));
    const off = within(dialog());
    await user.click(off.getByLabelText(/Hand them to someone else/));
    await user.type(off.getByLabelText("Hand their agents to"), "x");
    await user.click(off.getByRole("button", { name: "Turn off access" }));
    expect(await off.findByText(/still active/)).toBeInTheDocument();
    await user.click(off.getByLabelText(/Stop their 4 agents/));
    expect(
      off.queryByLabelText("Hand their agents to"),
    ).not.toBeInTheDocument();
    await user.click(off.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("turns off someone with no agents", async () => {
    const user = userEvent.setup();
    const { calls } = setup("/people?person=per_2", undefined, {
      "POST /admin/people/per_2/disable": () => ({
        person: makePerson({ id: "per_2", status: "disabled" }),
        stopped: 0,
        reassigned: 0,
        sessionsEnded: 0,
      }),
    });
    const details = within(await screen.findByRole("complementary"));
    await user.click(details.getByRole("button", { name: "Turn off access" }));
    const off = within(dialog());
    expect(off.getByText("They have no agents.")).toBeInTheDocument();
    await user.click(off.getByRole("button", { name: "Turn off access" }));
    expect(await off.findByRole("status")).toHaveTextContent(
      "No agents needed stopping. They were not signed in anywhere.",
    );
    expect(must(calls.find((c) => c.url.endsWith("/disable"))).body).toEqual(
      {},
    );
  });

  it("turns access back on for someone who was turned off", async () => {
    const user = userEvent.setup();
    const off = makePerson({
      status: "disabled",
      running: 0,
      disabledAt: "2026-11-01T09:00:00.000Z",
      disabledBy: "admin@example.com",
    });
    const { calls } = setup("/people?person=per_1", [off], {
      "POST /admin/people/per_1/enable": () => makePerson(),
    });
    const details = within(await screen.findByRole("complementary"));
    expect(details.getByText(/Access turned off on/)).toHaveTextContent(
      "by admin@example.com",
    );
    expect(details.getAllByText("Turned off").length).toBeGreaterThan(0);
    expect(
      details.getByText(
        /Their agents stay stopped until someone turns them on/,
      ),
    ).toBeInTheDocument();
    await user.click(
      details.getByRole("button", { name: "Turn access back on" }),
    );
    expect(await details.findByRole("status")).toHaveTextContent(
      "Dana Ortiz can sign in again. Their agents stay stopped until someone turns them on.",
    );
    expect(calls.some((c) => c.url.endsWith("/enable"))).toBe(true);
    expect(
      details.getByRole("button", { name: "Turn off access" }),
    ).toBeInTheDocument();
  });

  it("shows when turning access back on fails, without a date or name", async () => {
    const user = userEvent.setup();
    setup(
      "/people?person=per_1",
      [makePerson({ status: "disabled", manages: ["Sales"] })],
      {
        "POST /admin/people/per_1/enable": () => ({
          status: 500,
          body: { error: { code: "x", message: "Could not turn it on." } },
        }),
      },
    );
    const details = within(await screen.findByRole("complementary"));
    expect(details.getByText(/Access turned off\./)).toBeInTheDocument();
    expect(details.getByText("Sales")).toBeInTheDocument();
    await user.click(
      details.getByRole("button", { name: "Turn access back on" }),
    );
    expect(await details.findByRole("alert")).toHaveTextContent(
      "Could not turn it on.",
    );
  });
});
