import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentRequest, Me, StatusBoard, ViewerInfo } from "../api/types";
import { App } from "../App";
import {
  makeAgent,
  makeConnector,
  makePage,
  mockFetch,
  renderWithProviders,
} from "../test/helpers";
import { Login, LOGIN_PROBLEMS } from "./Login";
import { ApprovalsPage, describeRequest, RequestsPage } from "./Requests";

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

const location = () => screen.getByTestId("location").textContent ?? "";

const member: ViewerInfo = {
  kind: "person",
  role: "member",
  name: "Finn Ortiz",
  email: "finn@example.com",
  department: "Finance",
};
const manager: ViewerInfo = {
  kind: "person",
  role: "manager",
  name: "Fay Lee",
  email: "fay@example.com",
  department: "Finance",
  manages: ["Finance"],
};

function me(viewer: ViewerInfo, extra: Partial<Me> = {}): Me {
  return {
    viewer,
    selfService: true,
    policy: { autoApproveDailyUsd: 2, maxDailyUsd: 25 },
    providers: [makeConnector()],
    pending: { mine: 0, toDecide: 2 },
    ...extra,
  };
}

const board: StatusBoard = {
  total: 1,
  running: 1,
  notRunning: 0,
  atLimit: 0,
  stopped: [],
};

function request(
  extra: { [K in keyof AgentRequest]?: AgentRequest[K] | undefined } = {},
): AgentRequest {
  const merged: Record<string, unknown> = {
    id: "req_1",
    kind: "agent",
    status: "pending",
    by: "finn@example.com",
    byName: "Finn Ortiz",
    department: "Finance",
    reason: "Quarter close",
    createdAt: "2026-11-08T09:00:00.000Z",
    agent: {
      name: "board-pack",
      purpose: "Drafts the board pack",
      dailyUsd: 12,
      monthlyUsd: 300,
      providers: ["openrouter"],
    },
    ...extra,
  };
  return Object.fromEntries(
    Object.entries(merged).filter(([, v]) => v !== undefined),
  ) as unknown as AgentRequest;
}

/** The app as a signed-in person, with their pages' data. */
function asPerson(
  viewer: ViewerInfo,
  routes: Parameters<typeof mockFetch>[0] = {},
) {
  return mockFetch({
    "GET /auth/session": () => ({ authenticated: true, viewer }),
    "GET /me": () => me(viewer),
    "GET /me/status": () => board,
    "GET /me/agents": () =>
      makePage([makeAgent({ ownerEmail: viewer.email ?? "" })]),
    ...routes,
  });
}

describe("sign-in page", () => {
  it("offers the company button and demo people, with the token tucked away", async () => {
    const user = userEvent.setup();
    const onSignedIn = vi.fn();
    const { calls } = mockFetch({
      "GET /auth/options": () => ({
        sso: { label: "Sign in with Contoso" },
        demo: [
          {
            id: "usr_1",
            name: "Fay Lee",
            email: "fay@example.com",
            role: "manager",
            manages: ["Finance"],
          },
          {
            id: "usr_2",
            name: "Finn Ortiz",
            email: "finn@example.com",
            role: "member",
            department: "Finance",
          },
        ],
      }),
      "POST /auth/demo": () => ({ authenticated: true }),
    });
    renderWithProviders(<Login onSignedIn={onSignedIn} />);
    expect(
      await screen.findByRole("link", { name: "Sign in with Contoso" }),
    ).toHaveAttribute("href", "/auth/sso/start");
    expect(screen.getByText("Manages Finance")).toBeInTheDocument();
    expect(
      screen.getByText("Purser admin? Sign in with the admin token"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Finn Ortiz/ }));
    expect(calls.at(-1)?.body).toEqual({ personId: "usr_2" });
    expect(onSignedIn).toHaveBeenCalled();
  });

  it("explains each way a company sign-in can fail", async () => {
    for (const [code, text] of Object.entries(LOGIN_PROBLEMS)) {
      window.history.pushState({}, "", `/?login=${code}`);
      mockFetch({ "GET /auth/options": () => ({ sso: null, demo: null }) });
      const { unmount } = renderWithProviders(
        <Login onSignedIn={() => undefined} />,
      );
      expect(screen.getByRole("alert")).toHaveTextContent(text);
      unmount();
    }
    window.history.pushState({}, "", "/?login=something_new");
    mockFetch({ "GET /auth/options": () => ({ sso: null, demo: null }) });
    renderWithProviders(<Login onSignedIn={() => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/didn't work/);
  });

  it("shows a demo sign-in that failed", async () => {
    const user = userEvent.setup();
    mockFetch({
      "GET /auth/options": () => ({
        sso: null,
        demo: [
          { id: "x", name: "Gone", email: "g@example.com", role: "member" },
        ],
      }),
      "POST /auth/demo": () => ({
        status: 404,
        body: { error: { code: "not_found", message: "No such demo person." } },
      }),
    });
    renderWithProviders(<Login onSignedIn={() => undefined} />);
    await user.click(await screen.findByRole("button", { name: /Gone/ }));
    expect(await screen.findByText("No such demo person.")).toBeInTheDocument();
  });
});

describe("the app for each role", () => {
  it("gives an employee their agents and requests, nothing else", async () => {
    asPerson(member);
    renderWithProviders(<App />);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    await waitFor(() =>
      expect(
        within(nav)
          .getAllByRole("link")
          .map((l) => l.textContent),
      ).toEqual(["My agents", "My requests"]),
    );
    expect(
      await screen.findByRole("heading", { name: "My agents" }),
    ).toBeInTheDocument();
    expect(within(nav).getByText("Employee, Finance")).toBeInTheDocument();
  });

  it("gives a manager their departments' agents and a count of approvals waiting", async () => {
    asPerson(manager, {
      "GET /me/agents": () =>
        makePage([
          makeAgent({ owner: "Finn Ortiz", team: "Finance" }),
          makeAgent({ id: "agt_2", name: "other", awaitingKey: true }),
        ]),
    });
    renderWithProviders(<App />);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(await within(nav).findByLabelText("2 waiting")).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Agents" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Finn Ortiz")).toBeInTheDocument();
    expect(screen.getByText("Key waiting")).toBeInTheDocument();
  });
});

describe("my agents", () => {
  it("switches a manager between their departments and their own", async () => {
    const user = userEvent.setup();
    const { calls } = asPerson(manager);
    renderWithProviders(<App />, { route: "/agents" });
    await screen.findByRole("heading", { name: "Agents" });
    await user.click(screen.getByRole("button", { name: "Mine" }));
    expect(
      await screen.findByRole("heading", { name: "My agents" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("scope=mine"))).toBe(true),
    );
    await user.selectOptions(screen.getByLabelText("Status"), "yellow");
    await waitFor(() => expect(calls.at(-1)?.url).toContain("light=yellow"));
    await user.type(screen.getByLabelText("Search"), "inv");
    await waitFor(() => expect(calls.at(-1)?.url).toContain("q=inv"));
  });

  it("creates an agent within the limit and shows its key", async () => {
    const user = userEvent.setup();
    const { calls } = asPerson(member, {
      "GET /me/agents": () => makePage([]),
      "POST /me/agents": () => ({
        status: "ready",
        agent: makeAgent({ name: "inv-sum", providers: ["openrouter"] }),
        key: "purser_newkey_123",
        request: request({ status: "approved" }),
      }),
    });
    renderWithProviders(<App />, { route: "/agents" });
    expect(
      await screen.findByText(/You don't have any agents yet/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ask for an agent" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/Up to \$2\.00 a day is ready/),
    ).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Name"), "inv-sum");
    await user.type(
      within(dialog).getByLabelText("What it does"),
      "Sums invoices",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Create agent" }),
    );
    expect(await screen.findByText("inv-sum is ready")).toBeInTheDocument();
    expect(screen.getByText("Connect through OpenRouter")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      name: "inv-sum",
      purpose: "Sums invoices",
      dailyUsd: 2,
      providers: ["openrouter"],
    });
  });

  it("sends a bigger agent for approval with a reason, and stops at the maximum", async () => {
    const user = userEvent.setup();
    const { calls } = asPerson(member, {
      "POST /me/agents": () => ({
        status: "pending",
        request: request(),
      }),
    });
    renderWithProviders(<App />, { route: "/agents" });
    await user.click(
      await screen.findByRole("button", { name: "Ask for an agent" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "board-pack");
    await user.type(
      within(dialog).getByLabelText("What it does"),
      "Drafts the board pack",
    );
    const daily = within(dialog).getByLabelText("Daily limit in US dollars");
    await user.clear(daily);
    await user.type(daily, "50");
    expect(
      within(dialog).getByText(/The most anyone in Finance/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Send for approval" }),
    ).toBeDisabled();
    await user.clear(daily);
    await user.type(daily, "12");
    await user.type(
      within(dialog).getByLabelText("Monthly limit (optional)"),
      "300",
    );
    await user.type(
      within(dialog).getByLabelText(/Why it needs this much/),
      "Quarter close",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Send for approval" }),
    );
    expect(await screen.findByText("Request sent")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
      dailyUsd: 12,
      monthlyUsd: 300,
      reason: "Quarter close",
      providers: ["openrouter"],
    });
  });

  it("lets an owner collect the key of an approved agent and ask for more budget", async () => {
    const user = userEvent.setup();
    const waiting = makeAgent({
      awaitingKey: true,
      state: "at_limit",
      spend: { today: 2.5, month: 3 },
    });
    const { calls } = asPerson(member, {
      "GET /me/agents/agt_1": () => waiting,
      "GET /me/agents/agt_1/usage": () => ({ daily: [], recent: [] }),
      "POST /me/agents/agt_1/rotate-key": () => ({
        agent: { ...waiting, awaitingKey: undefined },
        key: "purser_fresh_key",
      }),
      "POST /me/agents/agt_1/raise-limit": () => ({
        status: "pending",
        request: request({ kind: "raise" }),
      }),
    });
    renderWithProviders(<App />, { route: "/agents?agent=agt_1" });
    const panel = await screen.findByRole("complementary", {
      name: "Agent details",
    });
    expect(
      await within(panel).findByText(/was approved\. Get its key/),
    ).toBeInTheDocument();
    // No admin-only sections for an employee.
    expect(within(panel).queryByText("Call log")).not.toBeInTheDocument();
    expect(within(panel).queryByText("Its activity")).not.toBeInTheDocument();
    await user.click(
      within(panel).getByRole("button", { name: "Get your key" }),
    );
    expect(
      (await within(panel).findAllByText("purser_fresh_key"))[0],
    ).toBeInTheDocument();
    expect(
      within(panel).queryByText(/old key has stopped/),
    ).not.toBeInTheDocument();
    expect(
      within(panel).getByText("Connect through OpenRouter"),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.url.includes("rotate-key"))?.body).toEqual({
      graceMinutes: 0,
    });

    expect(
      within(panel).getByText(/Ask your manager for more budget/),
    ).toBeInTheDocument();
    await user.click(
      within(panel).getByRole("button", { name: "Ask for more budget" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Send request" }),
    );
    expect(
      await screen.findByText(/Your department's managers will decide/),
    ).toBeInTheDocument();
  });
});

describe("requests and approvals", () => {
  it("lists my requests with answers and lets me cancel a waiting one", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "GET /me/requests": () => ({
        items: [
          request(),
          request({
            id: "req_2",
            status: "approved",
            decidedBy: "auto",
            decidedAt: "2026-11-08T09:01:00.000Z",
            agentId: "agt_9",
          }),
          request({
            id: "req_3",
            kind: "raise",
            status: "denied",
            agent: undefined,
            raise: {
              agentId: "agt_1",
              agentName: "inv-sum",
              window: "month",
              amountUsd: 20,
            },
            decidedBy: "fay@example.com",
            decidedAt: "2026-11-08T10:00:00.000Z",
            note: "Not this month",
          }),
        ],
      }),
      "POST /me/requests/req_1/cancel": () => request({ status: "cancelled" }),
    });
    renderWithProviders(<RequestsPage />);
    expect(
      await screen.findByText("$20.00 more this month for inv-sum"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/automatically, within your department's limit/),
    ).toBeInTheDocument();
    expect(screen.getByText(/"Not this month"/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open the agent" }),
    ).toHaveAttribute("href", "/agents?agent=agt_9");
    await user.click(screen.getByRole("button", { name: "Cancel request" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith("/cancel"))).toBe(true),
    );
  });

  it("approves with a note, turns down, and shows decided ones", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "GET /me/approvals": () => ({
        items: [
          request(),
          request({ id: "req_2", byName: "Sam Lee", department: "Sales" }),
          request({
            id: "req_3",
            status: "approved",
            decidedBy: "fay@example.com",
            decidedAt: "2026-11-08T10:00:00.000Z",
            note: "Go ahead",
          }),
        ],
      }),
      "POST /me/approvals/req_1/approve": () => request({ status: "approved" }),
      "POST /me/approvals/req_2/deny": () => request({ status: "denied" }),
    });
    renderWithProviders(<ApprovalsPage />, { route: "/approvals" });
    expect(
      await screen.findByRole("button", { name: "Waiting (2)" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Drafts the board pack/)).toHaveLength(2);
    const notes = screen.getAllByLabelText(/Note to/);
    await user.type(notes[0] as HTMLElement, "OK for Q4");
    await user.click(
      screen.getAllByRole("button", { name: "Approve" })[0] as HTMLElement,
    );
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith("/approve"))?.body).toEqual({
        note: "OK for Q4",
      }),
    );
    await user.click(
      screen.getAllByRole("button", { name: "Turn down" })[1] as HTMLElement,
    );
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith("/deny"))?.body).toEqual({}),
    );
    await user.click(screen.getByRole("button", { name: "Decided" }));
    expect(location()).toContain("tab=decided");
    expect(await screen.findByText(/"Go ahead"/)).toBeInTheDocument();
  });

  it("filters to one department from the departments page", async () => {
    mockFetch({
      "GET /me/approvals": () => ({
        items: [request(), request({ id: "req_2", department: "Sales" })],
      }),
    });
    renderWithProviders(<ApprovalsPage />, {
      route: "/approvals?department=Sales",
    });
    expect(await screen.findByText(/Showing Sales/)).toBeInTheDocument();
    expect(
      await screen.findAllByRole("button", { name: "Approve" }),
    ).toHaveLength(1);
    expect(
      screen.getByRole("link", { name: "All departments" }),
    ).toHaveAttribute("href", "/approvals");
  });

  it("describes each kind of request", () => {
    expect(describeRequest(request())).toBe(
      "New agent board-pack, $12.00 a day",
    );
    expect(
      describeRequest(
        request({
          kind: "raise",
          agent: undefined,
          raise: {
            agentId: "a",
            agentName: "x",
            window: "day",
            amountUsd: 3,
          },
        }),
      ),
    ).toBe("$3.00 more today for x");
    expect(describeRequest(request({ agent: undefined }))).toBe("Request");
  });
});

describe("services and agents asking for themselves", () => {
  const service = (extra: Partial<AgentRequest> = {}) =>
    request({
      id: "req_9",
      kind: "service",
      agent: undefined,
      reason: "A second opinion.",
      askedByAgent: { id: "agt_7", name: "coder" },
      service: {
        agentId: "agt_7",
        agentName: "coder",
        provider: "openai",
        providerName: "OpenAI",
        dailyUsd: 2,
      },
      ...extra,
    });

  it("describes a service request", () => {
    expect(describeRequest(service())).toBe("OpenAI for coder, $2.00 a day");
  });

  it("an owner can decide their agent's own request", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "GET /me/requests": () => ({
        items: [service({ ownerMayDecide: true })],
      }),
      "POST /me/approvals/req_9/approve": () => service(),
      "POST /me/approvals/req_9/deny": () => service(),
    });
    renderWithProviders(<RequestsPage />);
    expect(await screen.findByText("Asked by coder")).toBeTruthy();
    expect(screen.getByText(/"A second opinion."/)).toBeTruthy();
    expect(screen.getByText(/it's your call/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel request" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith("/approve"))).toBe(true),
    );
    await user.click(screen.getByRole("button", { name: "Turn down" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith("/deny"))).toBe(true),
    );
  });

  it("above their limit, an owner can only cancel it", async () => {
    mockFetch({
      "GET /me/requests": () => ({ items: [service()] }),
    });
    renderWithProviders(<RequestsPage />);
    expect(
      await screen.findByRole("button", { name: "Cancel request" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("a manager sees that the agent asked, and who owns it", async () => {
    mockFetch({
      "GET /me/approvals": () => ({ items: [service()] }),
    });
    renderWithProviders(<ApprovalsPage />);
    expect(await screen.findByText("Asked by coder")).toBeTruthy();
    expect(screen.getByText(/Owner: /)).toBeTruthy();
  });

  it("tells owners when new keys are waiting, and can show just those", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "GET /auth/session": () => ({ authenticated: true, viewer: member }),
      "GET /me": () => me(member, { keysWaiting: 2 }),
      "GET /me/status": () => board,
      "GET /me/agents": () =>
        makePage([
          makeAgent({
            awaitingKey: true,
            keyRotatedAt: "2026-11-01T00:00:00Z",
          }),
        ]),
    });
    window.history.pushState({}, "", "/agents");
    renderWithProviders(<App />);
    expect(
      await screen.findByText(/2 of your agents have new keys/),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show them" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("awaitingKey=1"))).toBe(true),
    );
    expect(screen.getByRole("button", { name: "Show all" })).toBeTruthy();
  });

  it("says when one key is waiting", async () => {
    mockFetch({
      "GET /auth/session": () => ({ authenticated: true, viewer: member }),
      "GET /me": () => me(member, { keysWaiting: 1 }),
      "GET /me/status": () => board,
      "GET /me/agents": () => makePage([]),
    });
    window.history.pushState({}, "", "/agents");
    renderWithProviders(<App />);
    expect(await screen.findByText(/One of your agents/)).toBeTruthy();
  });
});
