import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentDetail } from "./AgentDetail";
import {
  makeAgent,
  makeConnector,
  mockFetch,
  renderWithProviders,
  must,
} from "../test/helpers";

afterEach(() => vi.unstubAllGlobals());

const usage = {
  daily: [
    {
      date: "2026-11-06",
      costUsd: 0.5,
      requests: 10,
      inputTokens: 100,
      outputTokens: 50,
    },
    {
      date: "2026-11-07",
      costUsd: 1.25,
      requests: 20,
      inputTokens: 200,
      outputTokens: 90,
    },
  ],
  recent: [
    {
      id: "u1",
      agentId: "agt_1",
      provider: "openrouter",
      endpoint: "chat.completions",
      model: "openai/gpt-4o-mini",
      at: "2026-11-07T10:00:00.000Z",
      costUsd: 0.0004,
      priced: "fallback" as const,
      status: 200,
      durationMs: 300,
      outcome: "complete" as const,
      inputTokens: 10,
      outputTokens: 5,
    },
    {
      id: "u2",
      agentId: "agt_1",
      provider: "openrouter",
      endpoint: "chat.completions",
      model: "openai/gpt-4o-mini",
      at: "2026-11-07T10:01:00.000Z",
      costUsd: 0,
      priced: "provider" as const,
      status: 403,
      durationMs: 3,
      outcome: "aborted" as const,
      inputTokens: 0,
      outputTokens: 0,
    },
  ],
};

function setup(
  agent = makeAgent(),
  extra: Parameters<typeof mockFetch>[0] = {},
) {
  const fetched = mockFetch({
    "GET /admin/agents/agt_1": () => agent,
    "GET /admin/agents/agt_1/usage": () => usage,
    ...extra,
  });
  const onClose = vi.fn();
  renderWithProviders(
    <AgentDetail
      agentRef="agt_1"
      connectors={[makeConnector()]}
      onClose={onClose}
    />,
  );
  return { ...fetched, onClose };
}

describe("AgentDetail", () => {
  it("shows facts, spending and recent requests", async () => {
    setup(
      makeAgent({
        purpose: "Drafts the newsletter",
        providers: ["openrouter"],
        rotation: { everyDays: 90, graceDays: 7 },
        keyExpiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
        keyState: "expiring",
        endsAt: "2027-01-01T00:00:00.000Z",
      }),
    );
    expect(
      await screen.findByText("Drafts the newsletter"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("OpenRouter")[0]?.tagName).toBe("DD");
    expect(
      screen.getByText("Every 90 days, old key works 7 more days"),
    ).toBeInTheDocument();
    expect(screen.getByText(/in 5 days/)).toHaveClass("key-expiring");
    expect(await screen.findByText("$1.75 over 2 days")).toBeInTheDocument();
    expect(screen.getByText("(estimate)")).toBeInTheDocument();
    expect(screen.getByText("Cut off")).toBeInTheDocument();
  });

  it("stops and turns the agent back on", async () => {
    const user = userEvent.setup();
    setup(makeAgent(), {
      "POST /admin/agents/agt_1/kill": () => ({
        agent: makeAgent({ status: "paused", state: "paused" }),
        abortedRequests: 1,
        elapsedMs: 2.6,
      }),
      "POST /admin/agents/agt_1/resume": () => ({ agent: makeAgent() }),
    });
    await user.click(await screen.findByRole("button", { name: "Stop" }));
    expect(
      await screen.findByText(
        "Stopped in 3 ms. Cut 1 request that was still running.",
      ),
    ).toBeInTheDocument();
  });

  it("turns a stopped agent back on", async () => {
    const user = userEvent.setup();
    setup(
      makeAgent({
        status: "paused",
        state: "paused",
        pausedAt: "2026-11-07T10:00:00Z",
        pausedBy: "admin",
      }),
      {
        "POST /admin/agents/agt_1/resume": () => ({ agent: makeAgent() }),
      },
    );
    await user.click(await screen.findByRole("button", { name: "Turn on" }));
    expect(await screen.findByText("Running again.")).toBeInTheDocument();
  });

  it("rotates the key, shows it once, with the schedule's grace and new expiry", async () => {
    const user = userEvent.setup();
    const { calls } = setup(
      makeAgent({ rotation: { everyDays: 90, graceDays: 3 } }),
      {
        "POST /admin/agents/agt_1/rotate-key": () => ({
          agent: makeAgent({ keyExpiresAt: "2027-02-05T12:00:00.000Z" }),
          key: "purser_rotated",
          previousKeyValidUntil: "2026-11-10T12:00:00.000Z",
        }),
      },
    );
    await user.click(await screen.findByRole("button", { name: "Rotate key" }));
    expect(
      screen.getByLabelText("After 3 days (this agent's schedule)"),
    ).toBeChecked();
    expect(screen.getByText(/expire 90 days from now/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Make a new key" }));

    expect(calls.find((c) => c.url.endsWith("/rotate-key"))?.body).toEqual({
      graceMinutes: 4320,
    });
    expect(await screen.findByTestId("agent-key")).toHaveTextContent(
      "purser_rotated",
    );
    expect(screen.getByText(/The old key works until/)).toHaveTextContent(
      /new key expires on/,
    );

    await user.click(screen.getByRole("button", { name: "I've saved it" }));
    expect(screen.queryByText("purser_rotated")).not.toBeInTheDocument();
  });

  it("rotates immediately when there is no schedule", async () => {
    const user = userEvent.setup();
    const { calls } = setup(makeAgent(), {
      "POST /admin/agents/agt_1/rotate-key": () => ({
        agent: makeAgent(),
        key: "purser_now",
      }),
    });
    await user.click(await screen.findByRole("button", { name: "Rotate key" }));
    expect(screen.getByLabelText("Right away")).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Make a new key" }));
    expect(calls.find((c) => c.url.endsWith("/rotate-key"))?.body).toEqual({
      graceMinutes: 0,
    });
    expect(
      await screen.findByText(/The old key has stopped working/),
    ).toHaveTextContent("The new key doesn't expire.");
  });

  it("saves edits including limits and the rotation schedule", async () => {
    const user = userEvent.setup();
    const { calls } = setup(makeAgent(), {
      "PATCH /admin/agents/agt_1": (call) => makeAgent(call.body as object),
    });
    await user.click(await screen.findByText("Edit details and limits"));
    const team = screen.getByLabelText("Department");
    await user.clear(team);
    await user.type(team, "Growth");
    await user.clear(screen.getByLabelText("Daily limit"));
    await user.type(screen.getByLabelText("Daily limit"), "3.5");
    await user.type(
      screen.getByLabelText(/Allowed models/),
      "gpt-4o-mini, claude-haiku",
    );
    await user.selectOptions(
      screen.getByLabelText("Rotate automatically every"),
      "30",
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const patch = must(calls.find((c) => c.method === "PATCH")).body as Record<
      string,
      unknown
    >;
    expect(patch).toMatchObject({
      team: "Growth",
      rotation: { everyDays: 30, graceDays: 0 },
      endsAt: null,
      limits: {
        dailyUsd: 3.5,
        monthlyUsd: 20,
        models: ["gpt-4o-mini", "claude-haiku"],
      },
    });
    expect(typeof patch.keyExpiresAt).toBe("string");
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
  });

  it("clears the expiry and schedule when set to never and off", async () => {
    const user = userEvent.setup();
    const { calls } = setup(
      makeAgent({
        keyExpiresAt: "2027-01-01T00:00:00.000Z",
        rotation: { everyDays: 30, graceDays: 1 },
      }),
      { "PATCH /admin/agents/agt_1": () => makeAgent() },
    );
    await user.click(await screen.findByText("Edit details and limits"));
    await user.selectOptions(screen.getByLabelText("Key expires"), "never");
    await user.selectOptions(
      screen.getByLabelText("Rotate automatically every"),
      "0",
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({
        keyExpiresAt: null,
        rotation: null,
      }),
    );
  });

  it("closes on Escape and shows load errors", async () => {
    const user = userEvent.setup();
    const { onClose } = setup(makeAgent(), {
      "GET /admin/agents/agt_1/usage": () => ({
        status: 500,
        body: { error: { code: "x", message: "Usage broke." } },
      }),
    });
    expect(await screen.findByText("Usage broke.")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
    within(screen.getByRole("complementary"));
  });
});

describe("a replaced key", () => {
  it("says so, and when the old one stops", async () => {
    mockFetch({
      "GET /admin/agents/agt_1": () =>
        makeAgent({
          awaitingKey: true,
          keyRotatedAt: "2026-11-01T00:00:00.000Z",
          previousKeyValidUntil: "2026-11-09T00:00:00.000Z",
        }),
      "GET /admin/agents/agt_1/usage": () => ({ daily: [], recent: [] }),
    });
    renderWithProviders(
      <AgentDetail
        agentRef="agt_1"
        connectors={[]}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText(/was replaced/)).toBeTruthy();
    expect(screen.getByText(/The old key works until/)).toBeTruthy();
  });

  it("offers MCP setup alongside the key controls", async () => {
    mockFetch({
      "GET /admin/agents/agt_1": () => makeAgent(),
      "GET /admin/agents/agt_1/usage": () => ({ daily: [], recent: [] }),
    });
    renderWithProviders(
      <AgentDetail
        agentRef="agt_1"
        connectors={[]}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText("Connect this agent over MCP")).toBeTruthy();
  });

  it("edits the owner's email only when it changes", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "GET /admin/agents/agt_1": () =>
        makeAgent({ ownerEmail: "a@example.com" }),
      "GET /admin/agents/agt_1/usage": () => ({ daily: [], recent: [] }),
      "PATCH /admin/agents/agt_1": () => makeAgent(),
    });
    renderWithProviders(
      <AgentDetail
        agentRef="agt_1"
        connectors={[]}
        onClose={() => undefined}
      />,
    );
    const email = await screen.findByLabelText("Owner's company email");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PATCH")).toBe(true),
    );
    expect(calls.find((c) => c.method === "PATCH")?.body).not.toHaveProperty(
      "ownerEmail",
    );
    await user.clear(email);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2),
    );
    expect(
      calls.filter((c) => c.method === "PATCH").at(-1)?.body,
    ).toMatchObject({ ownerEmail: null });
  });
});
