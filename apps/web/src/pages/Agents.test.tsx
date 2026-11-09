import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentsPage, queryFromParams } from "./Agents";
import {
  makeAgent,
  makeConnector,
  makePage,
  mockFetch,
  renderWithProviders,
  must,
} from "../test/helpers";

afterEach(() => vi.unstubAllGlobals());

const agents = [
  makeAgent(),
  makeAgent({
    id: "agt_2",
    name: "support-replies",
    owner: "Sam Lee",
    team: "Support",
    keyExpiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    keyState: "expiring",
    rotation: { everyDays: 90, graceDays: 7 },
  }),
  makeAgent({
    id: "agt_3",
    name: "lead-research",
    keyExpiresAt: "2026-01-01T00:00:00.000Z",
    keyState: "expired",
  }),
];

function setup(route = "/agents", extra: Parameters<typeof mockFetch>[0] = {}) {
  const fetched = mockFetch({
    "GET /admin/agents": () => makePage(agents, { total: 120, pageSize: 50 }),
    "GET /admin/providers": () => [makeConnector()],
    ...extra,
  });
  const utils = renderWithProviders(<AgentsPage />, { route });
  return { ...fetched, ...utils };
}

const location = () => screen.getByTestId("location").textContent ?? "";

describe("queryFromParams", () => {
  it("reads filters, sort and paging, ignoring junk", () => {
    expect(
      queryFromParams(
        new URLSearchParams(
          "q=news&state=paused&keyState=expiring&team=Support&sort=key_expires&dir=asc&page=3&pageSize=100",
        ),
      ),
    ).toEqual({
      q: "news",
      state: "paused",
      keyState: "expiring",
      team: "Support",
      sort: "key_expires",
      dir: "asc",
      page: 3,
      pageSize: 100,
    });
    expect(
      queryFromParams(
        new URLSearchParams(
          "state=bogus&keyState=nope&sort=x&dir=up&page=-1&pageSize=7",
        ),
      ),
    ).toEqual({ page: 1, pageSize: 50 });
  });
});

describe("Agents page", () => {
  it("lists agents with spend, key expiry and state", async () => {
    setup();
    expect(
      await screen.findByRole("button", { name: "newsletter-writer" }),
    ).toBeInTheDocument();
    expect(screen.getByText("120 agents")).toBeInTheDocument();
    const rows = screen.getAllByRole("row");
    expect(within(must(rows[1])).getByText("Never")).toBeInTheDocument();
    expect(within(must(rows[2])).getByText(/in 3 days/)).toHaveClass(
      "key-expiring",
    );
    expect(within(must(rows[3])).getByText(/^Expired/)).toHaveClass(
      "key-expired",
    );
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
  });

  it("passes the filters in the address to the server", async () => {
    const { calls } = setup("/agents?keyState=expired&team=Support&page=2");
    await screen.findByRole("button", { name: "newsletter-writer" });
    const url = must(calls.find((c) => c.url.startsWith("/admin/agents"))).url;
    expect(url).toContain("keyState=expired");
    expect(url).toContain("team=Support");
    expect(url).toContain("page=2");
  });

  it("searches one field at a time and filters by green or red", async () => {
    const user = userEvent.setup();
    const { calls } = setup("/agents?in=bogus&state=nope");
    await screen.findByRole("button", { name: "newsletter-writer" });
    expect(screen.getByLabelText("Search in")).toHaveValue("all");

    await user.selectOptions(screen.getByLabelText("Search in"), "provider");
    expect(location()).toContain("in=provider");
    expect(screen.getByLabelText("Search")).toHaveAttribute(
      "placeholder",
      "Provider, such as OpenRouter",
    );
    await user.type(screen.getByLabelText("Search"), "openrouter");
    await waitFor(() => expect(location()).toContain("q=openrouter"));
    await waitFor(() =>
      expect(calls.at(-1)?.url).toContain("q=openrouter&in=provider"),
    );

    await user.selectOptions(screen.getByLabelText("Status"), "not_running");
    expect(location()).toContain("state=not_running");
    await user.selectOptions(screen.getByLabelText("Status"), "key_expired");
    expect(location()).toContain("state=key_expired");

    await user.selectOptions(screen.getByLabelText("Search in"), "all");
    expect(location()).not.toContain("in=");
  });

  it("puts a green or red light by each agent", async () => {
    mockFetch({
      "GET /admin/agents": () =>
        makePage([
          makeAgent(),
          makeAgent({ id: "agt_9", name: "hr-helper", state: "paused" }),
        ]),
      "GET /admin/providers": () => [],
    });
    renderWithProviders(<AgentsPage />, { route: "/agents" });
    const row = (name: string) =>
      must(screen.getByRole("button", { name }).closest("tr")) as HTMLElement;
    await screen.findByRole("button", { name: "hr-helper" });
    expect(row("newsletter-writer").querySelector(".light-on")).not.toBeNull();
    expect(row("hr-helper").querySelector(".light-off")).not.toBeNull();
    expect(within(row("hr-helper")).getByText("Stopped")).toBeInTheDocument();
  });

  it("writes filters, search and sort into the address", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByRole("button", { name: "newsletter-writer" });

    await user.selectOptions(screen.getByLabelText("Status"), "paused");
    expect(location()).toContain("state=paused");

    await user.selectOptions(screen.getByLabelText("Key"), "expiring");
    expect(location()).toContain("keyState=expiring");

    await user.type(screen.getByLabelText("Department"), "Support");
    expect(location()).toContain("team=Support");

    await user.type(screen.getByLabelText("Search"), "news");
    await waitFor(() => expect(location()).toContain("q=news"));

    await user.click(screen.getByRole("button", { name: /Key expires/ }));
    expect(location()).toContain("sort=key_expires");
    expect(location()).toContain("dir=asc");
    await user.click(screen.getByRole("button", { name: /Key expires/ }));
    expect(location()).toContain("dir=desc");

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(location()).toContain("page=2");
    await user.selectOptions(screen.getByLabelText("Rows per page"), "200");
    expect(location()).toContain("pageSize=200");
    expect(location()).not.toContain("page=2");
  });

  it("selects rows and stops them in bulk", async () => {
    const user = userEvent.setup();
    const { calls } = setup("/agents", {
      "POST /admin/agents/bulk": (call) => ({
        results: (call.body as { ids: string[] }).ids.map((id) => ({
          id,
          name: id,
          ok: true,
        })),
        abortedRequests: 1,
        elapsedMs: 4.2,
      }),
    });
    await screen.findByRole("button", { name: "newsletter-writer" });
    expect(
      screen.queryByRole("region", { name: "Selected agents" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByLabelText("Select newsletter-writer"));
    const bar = screen.getByRole("region", { name: "Selected agents" });
    expect(bar).toHaveTextContent("1 selected");

    await user.click(screen.getByLabelText("Select all agents on this page"));
    expect(bar).toHaveTextContent("3 selected");

    await user.click(within(bar).getByRole("button", { name: "Stop" }));
    const bulk = must(calls.find((c) => c.url === "/admin/agents/bulk"));
    expect(bulk.body).toEqual({
      action: "kill",
      ids: ["agt_1", "agt_2", "agt_3"],
    });
    expect(
      await screen.findByText("Stopped 3 agents in 4 ms."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Cut 1 requests/)).toBeInTheDocument();
  });

  it("rotates keys in bulk and shows the new keys once", async () => {
    const user = userEvent.setup();
    const { calls } = setup("/agents", {
      "POST /admin/agents/bulk": () => ({
        results: [
          {
            id: "agt_1",
            name: "newsletter-writer",
            ok: true,
            key: "purser_new_1",
          },
          {
            id: "agt_2",
            name: "support-replies",
            ok: false,
            error: "Not found",
          },
        ],
        elapsedMs: 2,
      }),
    });
    await screen.findByRole("button", { name: "newsletter-writer" });
    await user.click(screen.getByLabelText("Select newsletter-writer"));
    await user.click(screen.getByLabelText("Select support-replies"));
    await user.click(screen.getByRole("button", { name: "Rotate keys" }));

    const dialog = screen.getByRole("dialog", { name: "Rotate 2 keys" });
    expect(
      within(dialog).getByLabelText("Each agent's own rotation schedule"),
    ).toBeChecked();
    await user.click(
      within(dialog).getByRole("button", { name: "Rotate keys" }),
    );
    expect(calls.find((c) => c.url === "/admin/agents/bulk")?.body).toEqual({
      action: "rotate-key",
      ids: ["agt_1", "agt_2"],
    });

    const done = await screen.findByRole("dialog", { name: "Done" });
    expect(within(done).getByText("purser_new_1")).toBeInTheDocument();
    expect(
      within(done).getByText(/support-replies: Not found/),
    ).toBeInTheDocument();
    expect(
      within(done).getByRole("button", { name: "Copy all" }),
    ).toBeInTheDocument();

    const create = vi.fn(() => "blob:keys");
    const revoke = vi.fn();
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }),
    );
    await user.click(
      within(done).getByRole("button", { name: "Download CSV" }),
    );
    expect(create).toHaveBeenCalled();

    await user.click(within(done).getByRole("button", { name: "Done" }));
    expect(screen.queryByText("purser_new_1")).not.toBeInTheDocument();
  });

  it("rotates with a chosen grace period", async () => {
    const user = userEvent.setup();
    const { calls } = setup("/agents", {
      "POST /admin/agents/bulk": () => ({ results: [], elapsedMs: 1 }),
    });
    await screen.findByRole("button", { name: "newsletter-writer" });
    await user.click(screen.getByLabelText("Select newsletter-writer"));
    await user.click(screen.getByRole("button", { name: "Rotate keys" }));
    await user.click(screen.getByLabelText("After 24 hours"));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Rotate keys",
      }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.url === "/admin/agents/bulk")?.body).toEqual({
        action: "rotate-key",
        ids: ["agt_1"],
        graceMinutes: 1440,
      }),
    );
  });

  it("opens an agent's details from its row", async () => {
    const user = userEvent.setup();
    setup("/agents", {
      "GET /admin/agents/agt_1": () => makeAgent(),
      "GET /admin/agents/agt_1/usage": () => ({ daily: [], recent: [] }),
    });
    await user.click(
      await screen.findByRole("button", { name: "newsletter-writer" }),
    );
    expect(location()).toContain("agent=agt_1");
    expect(
      await screen.findByRole("complementary", { name: "Agent details" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close details" }));
    expect(location()).not.toContain("agent=");
  });

  it("says when nothing matches", async () => {
    mockFetch({
      "GET /admin/agents": () => makePage([], { total: 0 }),
      "GET /admin/providers": () => [],
    });
    renderWithProviders(<AgentsPage />, { route: "/agents?state=paused" });
    expect(
      await screen.findByText("No agents match these filters."),
    ).toBeInTheDocument();
  });

  it("adds an agent and shows its key and connection values", async () => {
    const user = userEvent.setup();
    const { calls } = setup("/agents", {
      "POST /admin/agents": (call) => ({
        status: 201,
        body: {
          agent: makeAgent({ name: (call.body as { name: string }).name }),
          key: "purser_fresh",
        },
      }),
    });
    await screen.findByRole("button", { name: "newsletter-writer" });
    await user.click(screen.getByRole("button", { name: "Add agent" }));
    const dialog = screen.getByRole("dialog", { name: "Add an agent" });
    await user.type(within(dialog).getByLabelText("Name"), "bad name");
    await user.type(
      within(dialog).getByLabelText("Who is responsible for it"),
      "Dana",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Create agent" }),
    );
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/no spaces/);

    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "writer");
    await user.type(
      within(dialog).getByLabelText("Most it can spend in a day"),
      "$5",
    );
    await user.selectOptions(
      within(dialog).getByLabelText("Key expires"),
      "90",
    );
    await user.selectOptions(
      within(dialog).getByLabelText("Rotate automatically every"),
      "90",
    );
    await user.selectOptions(
      within(dialog).getByLabelText("Old key keeps working for"),
      "7",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Create agent" }),
    );

    const body = must(
      calls.find((c) => c.method === "POST" && c.url === "/admin/agents"),
    ).body as Record<string, unknown>;
    expect(body).toMatchObject({
      name: "writer",
      owner: "Dana",
      limits: { dailyUsd: 5 },
      rotation: { everyDays: 90, graceDays: 7 },
    });
    expect(typeof body.keyExpiresAt).toBe("string");
    expect(await screen.findByTestId("agent-key")).toHaveTextContent(
      "purser_fresh",
    );
    expect(
      screen.getByText("http://127.0.0.1:4141/openrouter/api/v1"),
    ).toBeInTheDocument();
  });
});

describe("keys still to collect", () => {
  it("shows the filter and a badge, and can go back to everything", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "GET /admin/agents": () => makePage([makeAgent({ awaitingKey: true })]),
      "GET /admin/providers": () => [],
    });
    renderWithProviders(<AgentsPage />, { route: "/agents?awaiting=1" });
    expect(await screen.findByText(/still have a new key/)).toBeTruthy();
    expect(await screen.findByText("Key waiting")).toBeTruthy();
    expect(calls[0]?.url).toContain("awaitingKey=1");
    await user.click(screen.getByRole("button", { name: "Show all" }));
    await waitFor(() =>
      expect(screen.queryByText(/still have a new key/)).toBeNull(),
    );
  });
});
