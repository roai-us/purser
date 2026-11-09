import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { StatusBoard } from "../api/types";
import { mockFetch, renderWithProviders } from "../test/helpers";
import { describeStopped, StatusBar } from "./StatusBar";

afterEach(() => vi.unstubAllGlobals());

const location = () => screen.getByTestId("location").textContent ?? "";

function board(overrides: Partial<StatusBoard> = {}): StatusBoard {
  return {
    total: 120,
    running: 117,
    notRunning: 3,
    atLimit: 1,
    stopped: [
      {
        id: "agt_1",
        name: "hr-helper",
        owner: "Ben Okafor",
        state: "paused",
        since: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        by: "admin",
      },
      { id: "agt_2", name: "lapsed-key", owner: "Dev", state: "key_expired" },
      { id: "agt_3", name: "big-spender", owner: "Ana", state: "at_limit" },
    ],
    ...overrides,
  };
}

describe("status bar", () => {
  it("counts green, yellow and red and links to each", async () => {
    mockFetch({ "GET /admin/status": () => board() });
    renderWithProviders(<StatusBar />);
    expect(
      await screen.findByRole("link", { name: "117 running" }),
    ).toHaveAttribute("href", "/agents?light=green");
    expect(screen.getByRole("link", { name: "1 at limit" })).toHaveAttribute(
      "href",
      "/agents?light=yellow",
    );
    expect(screen.getByRole("link", { name: "2 stopped" })).toHaveAttribute(
      "href",
      "/agents?light=red",
    );
    const lights = within(
      screen.getByRole("list", { name: "Agents that are not running" }),
    ).getAllByRole("button");
    expect(lights.map((b) => b.getAttribute("aria-label"))).toEqual([
      "hr-helper is stopped (by admin, 2 hours ago)",
      "lapsed-key is waiting for a new key",
      "big-spender is at its spending limit; raise it once to turn it back on",
    ]);
    expect(lights[2]?.querySelector(".light-warn")).not.toBeNull();
    expect(lights[0]?.querySelector(".light-off")).not.toBeNull();
  });

  it("opens an agent from its red light, keeping the agents page's filters", async () => {
    const user = userEvent.setup();
    mockFetch({ "GET /admin/status": () => board() });
    renderWithProviders(<StatusBar />, { route: "/agents?team=HR" });
    await user.click(
      await screen.findByRole("button", { name: /^lapsed-key/ }),
    );
    expect(location()).toBe("/agents?team=HR&agent=agt_2");
  });

  it("starts the agents page fresh when opened from elsewhere", async () => {
    const user = userEvent.setup();
    mockFetch({ "GET /admin/status": () => board() });
    renderWithProviders(<StatusBar />, { route: "/providers?x=1" });
    await user.click(await screen.findByRole("button", { name: /^hr-helper/ }));
    expect(location()).toBe("/agents?agent=agt_1");
  });

  it("shows what a light is on hover", async () => {
    const user = userEvent.setup();
    mockFetch({ "GET /admin/status": () => board() });
    renderWithProviders(<StatusBar />);
    expect(
      await screen.findByText("Click a light to open that agent."),
    ).toBeInTheDocument();
    await user.hover(screen.getByRole("button", { name: /^big-spender/ }));
    expect(
      screen.getByText(
        "big-spender is at its spending limit; raise it once to turn it back on",
      ),
    ).toBeInTheDocument();
  });

  it("says how many more there are past the cap", async () => {
    mockFetch({
      "GET /admin/status": () => board({ notRunning: 250, running: 0 }),
    });
    renderWithProviders(<StatusBar />);
    expect(
      await screen.findByRole("link", { name: "and 247 more" }),
    ).toHaveAttribute("href", "/agents?state=not_running");
  });

  it("doesn't say all of one agent", async () => {
    mockFetch({
      "GET /admin/status": () =>
        board({ total: 1, running: 1, notRunning: 0, stopped: [] }),
    });
    renderWithProviders(<StatusBar />);
    expect(await screen.findByText("1 agent is running.")).toBeInTheDocument();
  });

  it("is a single green line when everything runs", async () => {
    mockFetch({
      "GET /admin/status": () =>
        board({ running: 120, notRunning: 0, stopped: [] }),
    });
    renderWithProviders(<StatusBar />);
    expect(
      await screen.findByText("All 120 agents are running."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("stays out of the way before there are any agents", async () => {
    const { calls } = mockFetch({
      "GET /admin/status": () =>
        board({ total: 0, running: 0, notRunning: 0, stopped: [] }),
    });
    renderWithProviders(<StatusBar />);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("describes agents without details plainly", () => {
    expect(
      describeStopped({
        id: "a",
        name: "old-pilot",
        owner: "x",
        state: "expired",
      }),
    ).toBe("old-pilot is past its end date");
  });
});
