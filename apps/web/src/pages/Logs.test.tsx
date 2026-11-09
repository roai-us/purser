import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CallEntry, LogSettings } from "../api/types";
import { RaiseLimitDialog, capNow, isAtCap } from "../components/RaiseLimit";
import { makeAgent, mockFetch, renderWithProviders } from "../test/helpers";
import { AgentDetail } from "./AgentDetail";
import { LogsPage, turnsOf } from "./Logs";
import { SettingsPage } from "./Settings";

afterEach(() => vi.unstubAllGlobals());

const location = () => screen.getByTestId("location").textContent ?? "";

const LOGGING: LogSettings = { mode: "all", retentionDays: 30, maxKb: 64 };

function call(overrides: Partial<CallEntry> = {}): CallEntry {
  return {
    id: "use_1",
    agentId: "agt_1",
    agentName: "newsletter-writer",
    at: "2026-11-08T10:00:00.000Z",
    provider: "openrouter",
    endpoint: "chat.completions",
    model: "openai/gpt-4o-mini",
    status: 200,
    outcome: "complete",
    costUsd: 0.0012,
    durationMs: 1400,
    requestPreview: "Draft the November issue",
    responsePreview: "Here is a draft",
    truncated: false,
    request: JSON.stringify({
      model: "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: "You write newsletters." },
        { role: "user", content: "Draft the November issue" },
      ],
    }),
    response: '{"choices":[]}',
    responseText: "Here is a draft",
    ...overrides,
  };
}

describe("turnsOf", () => {
  it("reads chat, messages and responses requests", () => {
    expect(
      turnsOf(
        JSON.stringify({
          system: [{ type: "text", text: "Be brief" }],
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Look" },
                { type: "image", source: {} },
              ],
            },
          ],
        }),
      ),
    ).toEqual([
      { role: "system", text: "Be brief" },
      { role: "user", text: "Look\n[image]" },
    ]);
    expect(
      turnsOf(JSON.stringify({ input: "Hi", instructions: "Hey" })),
    ).toEqual([
      { role: "system", text: "Hey" },
      { role: "user", text: "Hi" },
    ]);
    expect(turnsOf(JSON.stringify({ input: [{ content: "x" }] }))).toEqual([
      { role: "message", text: "x" },
    ]);
    expect(turnsOf(JSON.stringify({ prompt: "Old" }))).toEqual([
      { role: "user", text: "Old" },
    ]);
    expect(turnsOf(JSON.stringify({ model: "m" }))).toBeNull();
    expect(turnsOf("[1]")).toBeNull();
    expect(turnsOf("nope")).toBeNull();
  });
});

describe("call log page", () => {
  it("lists calls and opens one as a conversation", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "GET /admin/logs": () => ({
        items: [call(), call({ id: "use_2", outcome: "error", status: 500 })],
        next: "cursor-1",
        settings: LOGGING,
      }),
      "GET /admin/logs/use_1": () => call(),
    });
    renderWithProviders(<LogsPage />, { route: "/logs" });
    expect(await screen.findAllByText("Draft the November issue")).toHaveLength(
      2,
    );
    expect(screen.getByText("Error 500")).toBeInTheDocument();
    expect(screen.getByText(/kept for 30 days/)).toBeInTheDocument();

    const buttons = screen.getAllByRole("button", { name: /2026|11\/8|8 Nov/ });
    await user.click(buttons[0] as HTMLElement);
    expect(location()).toContain("call=use_1");
    const panel = await screen.findByRole("complementary", {
      name: "Call details",
    });
    expect(
      await within(panel).findByText("You write newsletters."),
    ).toBeInTheDocument();
    expect(within(panel).getByText("Here is a draft")).toBeInTheDocument();
    expect(within(panel).getByText("1.4 s")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Older calls" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("before=cursor-1"))).toBe(true),
    );

    await user.click(within(panel).getByRole("button", { name: "Close call" }));
    expect(location()).not.toContain("call=");
  });

  it("filters by agent and says when logging is off", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "GET /admin/logs": () => ({
        items: [],
        settings: { ...LOGGING, mode: "off" },
      }),
    });
    renderWithProviders(<LogsPage />, { route: "/logs" });
    expect(await screen.findByText(/The call log is off/)).toBeInTheDocument();
    expect(screen.getByText("No calls logged yet.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Agent"), "agt_9");
    await waitFor(() => expect(location()).toContain("agent=agt_9"));
    await waitFor(() => expect(calls.at(-1)?.url).toContain("agent=agt_9"));
  });

  it("warns when a call was cut and shows raw bodies", async () => {
    mockFetch({
      "GET /admin/logs": () => ({ items: [], settings: LOGGING }),
      "GET /admin/logs/use_1": () => ({
        ...call({ truncated: true, request: "{bad" }),
        responseText: "",
      }),
    });
    renderWithProviders(<LogsPage />, { route: "/logs?call=use_1" });
    expect(
      await screen.findByText(/longer than the log's size limit/),
    ).toBeInTheDocument();
    expect(screen.getByText("No text in the response.")).toBeInTheDocument();
    expect(screen.getByText("{bad")).toBeInTheDocument();
  });

  it("explains a call past its retention", async () => {
    mockFetch({
      "GET /admin/logs": () => ({ items: [], settings: LOGGING }),
      "GET /admin/logs/gone": () => ({
        status: 404,
        body: { error: { code: "not_found", message: "No such call." } },
      }),
    });
    renderWithProviders(<LogsPage />, { route: "/logs?call=gone" });
    expect(await screen.findByText("No such call.")).toBeInTheDocument();
  });
});

describe("settings page", () => {
  it("saves the logging mode and retention", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "GET /admin/settings": () => ({
        logging: { mode: "off", retentionDays: 30, maxKb: 64 },
      }),
      "PUT /admin/settings/logging": (c) => ({
        logging: c.body as LogSettings,
      }),
    });
    renderWithProviders(<SettingsPage />);
    const save = await screen.findByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await user.click(
      screen.getByRole("radio", { name: /Only agents I choose/ }),
    );
    await user.selectOptions(screen.getByLabelText("Delete calls after"), "7");
    expect(
      screen.getByText(/deletes calls older than 7 days/),
    ).toBeInTheDocument();
    await user.selectOptions(
      screen.getByLabelText("Keep at most, per request and per response"),
      "1024",
    );
    await user.click(save);
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(calls.at(-1)?.body).toEqual({
      mode: "selected",
      retentionDays: 7,
      maxKb: 1024,
    });
  });
});

describe("raising a limit once", () => {
  const atLimit = makeAgent({
    state: "at_limit",
    limits: { dailyUsd: 2, monthlyUsd: 20 },
    spend: { today: 2.01, month: 9 },
  });

  it("works out the cap in force", () => {
    expect(capNow(atLimit, "day")).toBe(2);
    expect(capNow({ ...atLimit, raised: { dailyUsd: 3 } }, "day")).toBe(5);
    expect(capNow(makeAgent({ limits: {} }), "month")).toBeUndefined();
    expect(isAtCap(atLimit, "day")).toBe(true);
    expect(isAtCap(atLimit, "month")).toBe(false);
  });

  it("raises today's limit from the agent's panel and turns it green", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "GET /admin/agents/agt_1": () => atLimit,
      "GET /admin/agents/agt_1/usage": () => ({ daily: [], recent: [] }),
      "GET /admin/settings": () => ({ logging: { ...LOGGING, mode: "off" } }),
      "POST /admin/agents/agt_1/raise-limit": () => ({
        agent: { ...atLimit, state: "running", raised: { dailyUsd: 4 } },
      }),
    });
    renderWithProviders(
      <AgentDetail agentRef="agt_1" connectors={[]} onClose={() => {}} />,
    );
    expect(
      await screen.findByText(/hit its spending limit/),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/turn on the call log in/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Raise limit once" }));
    const dialog = await screen.findByRole("dialog");
    // Defaults to the limit that was hit, with +100% picked.
    expect(
      within(dialog).getByRole("radio", { name: /Today's/ }),
    ).toBeChecked();
    expect(within(dialog).getByLabelText("Amount in US dollars")).toHaveValue(
      "2",
    );
    await user.click(within(dialog).getByRole("button", { name: "+$4.00" }));
    await user.type(
      within(dialog).getByLabelText(/Why/),
      "Month-end newsletter",
    );
    expect(
      within(dialog).getByText(/can spend \$4\.00 more today/),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Raise limit" }),
    );
    expect(
      await screen.findByText(
        "Raised. newsletter-writer can spend $4.00 more today.",
      ),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      window: "day",
      amountUsd: 4,
      reason: "Month-end newsletter",
    });
  });

  it("checks the amount and can raise the monthly limit instead", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "POST /admin/agents/agt_1/raise-limit": () => ({ agent: atLimit }),
    });
    const onDone = vi.fn();
    renderWithProviders(
      <RaiseLimitDialog agent={atLimit} onDone={onDone} onClose={() => {}} />,
    );
    const dialog = screen.getByRole("dialog");
    await user.click(
      within(dialog).getByRole("radio", { name: /This month's/ }),
    );
    const amount = within(dialog).getByLabelText("Amount in US dollars");
    await user.clear(amount);
    expect(
      within(dialog).getByText(/Enter an amount of at least/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Raise limit" }),
    ).toBeDisabled();
    await user.type(amount, "$15");
    await user.click(
      within(dialog).getByRole("button", { name: "Raise limit" }),
    );
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(calls.at(-1)?.body).toEqual({ window: "month", amountUsd: 15 });
  });

  it("says when there is nothing to raise", () => {
    renderWithProviders(
      <RaiseLimitDialog
        agent={makeAgent({ limits: {} })}
        onDone={() => {}}
        onClose={() => {}}
      />,
    );
    expect(
      screen.getByText("This agent has no spending limit to raise."),
    ).toBeInTheDocument();
  });

  it("lets an admin choose to log one agent", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "GET /admin/agents/agt_1": () => makeAgent(),
      "GET /admin/agents/agt_1/usage": () => ({
        daily: [],
        recent: [
          {
            id: "use_7",
            agentId: "agt_1",
            provider: "openrouter",
            endpoint: "chat.completions",
            model: "m",
            at: "2026-11-08T10:00:00.000Z",
            costUsd: 0.01,
            priced: "provider",
            status: 200,
            durationMs: 10,
            outcome: "complete",
            inputTokens: 1,
            outputTokens: 1,
            logged: true,
          },
        ],
      }),
      "GET /admin/settings": () => ({
        logging: { ...LOGGING, mode: "selected" },
      }),
      "PATCH /admin/agents/agt_1": () => makeAgent({ logCalls: true }),
    });
    renderWithProviders(
      <AgentDetail agentRef="agt_1" connectors={[]} onClose={() => {}} />,
    );
    const box = await screen.findByRole("checkbox", {
      name: /Keep this agent's requests and responses for 30 days/,
    });
    await user.click(box);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
        logCalls: true,
      }),
    );
    expect(
      await screen.findByRole("link", { name: /View the call/ }),
    ).toHaveAttribute("href", "/logs?agent=agt_1&call=use_7");
  });
});
