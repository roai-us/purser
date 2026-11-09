import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Agent, Me, ViewerInfo } from "../api/types";
import { adminAgentApi, AgentApiProvider, meAgentApi } from "../lib/agentApi";
import {
  makeAgent,
  makeConnector,
  mockFetch,
  renderWithProviders,
} from "../test/helpers";
import { AgentServices } from "./AgentServices";
import { ConnectAgent } from "./ConnectAgent";

afterEach(() => vi.unstubAllGlobals());

const connectors = [
  makeConnector({ id: "openai", name: "OpenAI" }),
  makeConnector({ id: "anthropic", name: "Anthropic" }),
  makeConnector({ id: "xai", name: "xAI" }),
  makeConnector({ id: "groq", name: "Groq", configured: false }),
];

const owner: ViewerInfo = {
  kind: "person",
  role: "member",
  name: "Omar",
  email: "omar@example.com",
  department: "Eng",
};
const manager: ViewerInfo = {
  kind: "person",
  role: "manager",
  name: "Mia",
  manages: ["Eng"],
};

const me = (extra: Partial<Me> = {}): Me => ({
  viewer: owner,
  selfService: true,
  policy: { autoApproveDailyUsd: 2, maxDailyUsd: 25 },
  providers: connectors,
  pending: { mine: 0, toDecide: 0 },
  ...extra,
});

const coder = (extra: { [K in keyof Agent]?: Agent[K] | undefined } = {}) =>
  makeAgent({
    id: "agt_1",
    name: "coder",
    team: "Eng",
    providers: ["anthropic", "openai"],
    limits: { dailyUsd: 5 },
    serviceLimits: {
      openai: { dailyUsd: 2, monthlyUsd: 20, models: ["gpt-4o"] },
    },
    serviceSpend: { openai: { today: 0.5, month: 3 } },
    ...extra,
  } as Partial<Agent>);

function show(agent: Agent, viewer?: ViewerInfo) {
  renderWithProviders(
    <AgentApiProvider value={viewer ? meAgentApi(viewer) : adminAgentApi}>
      <AgentServices agent={agent} connectors={connectors} />
    </AgentApiProvider>,
  );
}

describe("an agent's services", () => {
  it("lists each with its limits and spend", () => {
    mockFetch({});
    show(coder());
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText(/under the agent's overall limit/)).toBeTruthy();
    expect(screen.getByText("OpenAI")).toBeTruthy();
    expect(screen.getByText(/of \$20.00 this month/)).toBeTruthy();
    expect(screen.getByText("Models: gpt-4o")).toBeTruthy();
  });

  it("says when an agent can use anything", () => {
    mockFetch({});
    show(coder({ providers: undefined }));
    expect(screen.getByText(/any connected provider/)).toBeTruthy();
  });

  it("an admin adds one directly, with no daily limit if they like", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "PUT /admin/agents/agt_1/services/xai": () => coder(),
    });
    show(coder());
    await user.click(screen.getByRole("button", { name: "Add a service" }));
    const dialog = await screen.findByRole("dialog");
    const options = within(dialog)
      .getAllByRole("option")
      .map((o) => o.textContent);
    // Only connected services the agent doesn't already have.
    expect(options).toEqual(["Choose one", "xAI"]);
    await user.selectOptions(within(dialog).getByLabelText("Service"), "xai");
    await user.type(
      within(dialog).getByLabelText(/separated by commas/),
      "grok-a, grok-b",
    );
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("coder can use xAI.")).toBeTruthy();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      models: ["grok-a", "grok-b"],
    });
  });

  it("changes a service's limits, starting from what's set", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "PUT /admin/agents/agt_1/services/openai": () => coder(),
    });
    show(coder());
    await user.click(
      screen.getByRole("button", { name: "Change limits on OpenAI" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText("Service")).toBeNull();
    const daily = within(dialog).getByLabelText(/in a day/);
    expect((daily as HTMLInputElement).value).toBe("2");
    await user.clear(daily);
    await user.type(daily, "3");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("coder can use OpenAI, up to $3.00 a day."),
    ).toBeTruthy();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      dailyUsd: 3,
      monthlyUsd: 20,
      models: ["gpt-4o"],
    });
  });

  it("an owner gets it at once within their department's limit", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "GET /me": () => me(),
      "POST /me/agents/agt_1/services": () => ({
        status: "granted",
        agent: coder(),
      }),
    });
    show(coder(), owner);
    await user.click(screen.getByRole("button", { name: "Ask for a service" }));
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText("Service"), "xai");
    const save = within(dialog).getByRole("button", { name: "Save" });
    // An owner has to set a daily limit.
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(dialog).getByLabelText(/in a day/), "1.5");
    expect(await within(dialog).findByText(/ready straight away/)).toBeTruthy();
    await user.click(save);
    expect(await screen.findByText(/coder can use xAI/)).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      provider: "xai",
      dailyUsd: 1.5,
    });
  });

  it("above that it goes to a manager, with a reason", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "GET /me": () => me(),
      "POST /me/agents/agt_1/services": () => ({
        status: "pending",
        request: {},
      }),
    });
    show(coder(), owner);
    await user.click(screen.getByRole("button", { name: "Ask for a service" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/ready straight away/);
    await user.selectOptions(within(dialog).getByLabelText("Service"), "xai");
    await user.type(within(dialog).getByLabelText(/in a day/), "10");
    await user.type(within(dialog).getByLabelText(/Why it needs/), "Reviews");
    await user.click(
      within(dialog).getByRole("button", { name: "Send for approval" }),
    );
    expect(await screen.findByText(/went to Eng's managers/)).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
      reason: "Reviews",
    });
  });

  it("refuses more than the department's maximum", async () => {
    const user = userEvent.setup();
    mockFetch({ "GET /me": () => me() });
    show(coder(), owner);
    await user.click(screen.getByRole("button", { name: "Ask for a service" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/ready straight away/);
    await user.selectOptions(within(dialog).getByLabelText("Service"), "xai");
    await user.type(within(dialog).getByLabelText(/in a day/), "100");
    expect(within(dialog).getByText(/The most anyone in Eng/)).toBeTruthy();
    const buttons = within(dialog).getAllByRole("button");
    expect((buttons.at(-1) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers only what the department allows, and says when nothing's left", async () => {
    const user = userEvent.setup();
    mockFetch({
      "GET /me": () =>
        me({
          policy: {
            autoApproveDailyUsd: 2,
            maxDailyUsd: 25,
            allowedProviders: ["anthropic", "openai"],
          },
        }),
    });
    show(coder(), owner);
    await user.click(screen.getByRole("button", { name: "Ask for a service" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText(/no other connected services/),
    ).toBeTruthy();
  });

  it("a manager adds directly", () => {
    mockFetch({ "GET /me": () => me({ viewer: manager }) });
    show(coder(), manager);
    expect(screen.getByRole("button", { name: "Add a service" })).toBeTruthy();
  });

  it("removes a service, but not the only one", async () => {
    const user = userEvent.setup();
    mockFetch({
      "DELETE /me/agents/agt_1/services/openai": () => coder(),
    });
    show(coder(), owner);
    await user.click(screen.getByRole("button", { name: "Remove OpenAI" }));
    expect(
      await screen.findByText("coder can't use OpenAI any more."),
    ).toBeTruthy();
  });

  it("the last service can't be removed", () => {
    mockFetch({});
    show(coder({ providers: ["anthropic"], serviceLimits: undefined }), owner);
    expect(
      screen.queryByRole("button", { name: "Remove Anthropic" }),
    ).toBeNull();
  });

  it("on an agent allowed anything, only a manager can lift a limit", () => {
    const open = coder({ providers: undefined });
    mockFetch({
      "DELETE /me/agents/agt_1/services/openai": () => open,
    });
    show(open, owner);
    expect(screen.queryByRole("button", { name: "Remove OpenAI" })).toBeNull();
  });

  it("a manager lifts one and is told", async () => {
    const user = userEvent.setup();
    const open = coder({ providers: undefined });
    mockFetch({
      "DELETE /me/agents/agt_1/services/openai": () => open,
    });
    show(open, manager);
    await user.click(screen.getByRole("button", { name: "Remove OpenAI" }));
    expect(
      await screen.findByText("coder has no separate limit on OpenAI now."),
    ).toBeTruthy();
  });
});

describe("connecting over MCP", () => {
  const panel = () => screen.getByRole("tabpanel").textContent ?? "";

  it("shows the address and the key, in each form", async () => {
    const user = userEvent.setup();
    mockFetch({
      "GET /me": () =>
        me({ mcp: { enabled: true, url: "https://purser.example.com/mcp" } }),
    });
    renderWithProviders(<ConnectAgent agentKey="purser_abc" />);
    expect(await screen.findByText(/purser.example.com/)).toBeTruthy();
    expect(panel()).toContain('"url": "https://purser.example.com/mcp"');
    expect(panel()).toContain("Bearer purser_abc");
    await user.click(screen.getByRole("tab", { name: "Claude Code" }));
    expect(panel()).toContain(
      'claude mcp add --transport http purser https://purser.example.com/mcp --header "Authorization: Bearer purser_abc"',
    );
    await user.click(screen.getByRole("tab", { name: "Local programs only" }));
    expect(panel()).toContain('"PURSER_AGENT_KEY": "purser_abc"');
    expect(panel()).toContain('"PURSER_URL": "https://purser.example.com"');
  });

  it("uses a placeholder without the key, and this address before /me answers", () => {
    mockFetch({});
    renderWithProviders(<ConnectAgent />);
    expect(panel()).toContain("<the agent's key>");
    expect(panel()).toContain(`${window.location.origin}/mcp`);
    expect(screen.getByText(/Lost it\?/)).toBeTruthy();
  });

  it("says when admins have turned it off", async () => {
    mockFetch({
      "GET /me": () => me({ mcp: { enabled: false, url: "x" } }),
    });
    renderWithProviders(<ConnectAgent />);
    expect(await screen.findByText(/turned off/)).toBeTruthy();
  });
});
