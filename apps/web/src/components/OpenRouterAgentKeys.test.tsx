import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AgentOpenRouterKey,
  AgentOpenRouterKeyView,
  OpenRouterKeysView,
} from "../api/types";
import { makeAgent, mockFetch, renderWithProviders } from "../test/helpers";
import { AgentOpenRouterKeySection } from "./AgentOpenRouterKey";
import { OpenRouterAgentKeys } from "./OpenRouterAgentKeys";

afterEach(() => vi.unstubAllGlobals());

const view = (over: Partial<OpenRouterKeysView> = {}): OpenRouterKeysView => ({
  managementKey: { set: false },
  enabled: false,
  connected: true,
  keys: 0,
  problems: [],
  ...over,
});

describe("OpenRouterAgentKeys", () => {
  it("saves a management key, then turns per-agent keys on", async () => {
    let state = view();
    const { calls } = mockFetch({
      "GET /admin/openrouter/agent-keys": () => state,
      "PUT /admin/openrouter/management-key": () => {
        state = view({ managementKey: { set: true, hint: "sk-o...mgmt" } });
        return state;
      },
      "PUT /admin/openrouter/agent-keys": () => {
        state = { ...state, enabled: true, keys: 3 };
        return state;
      },
    });
    renderWithProviders(<OpenRouterAgentKeys connected />);
    await userEvent.click(await screen.findByText(/Per-agent keys/));
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await userEvent.type(
      screen.getByLabelText("Paste an OpenRouter management key"),
      "sk-or-v1-mgmt",
    );
    await userEvent.click(save);
    expect(await screen.findByText("sk-o...mgmt")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      key: "sk-or-v1-mgmt",
    });

    await userEvent.click(
      screen.getByRole("button", { name: "Turn on per-agent keys" }),
    );
    expect(await screen.findByText("On")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(calls.at(-1)?.body).toEqual({ enabled: true });
  });

  it("shows OpenRouter's refusal of a key", async () => {
    mockFetch({
      "GET /admin/openrouter/agent-keys": () => view(),
      "PUT /admin/openrouter/management-key": () => ({
        status: 400,
        body: {
          error: {
            code: "invalid_key",
            message: "That is an ordinary OpenRouter API key.",
          },
        },
      }),
    });
    renderWithProviders(<OpenRouterAgentKeys connected />);
    await userEvent.click(await screen.findByText(/Per-agent keys/));
    await userEvent.type(
      screen.getByLabelText("Paste an OpenRouter management key"),
      "sk-or-v1-plain",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("That is an ordinary OpenRouter API key."),
    ).toBeInTheDocument();
  });

  it("lists keys that need a look, and asks before turning off", async () => {
    let state = view({
      managementKey: { set: true, hint: "sk-o...mgmt" },
      enabled: true,
      keys: 2,
      problems: [
        { agentId: "agt_1", agentName: "support-bot", problem: "Gone." },
      ],
    });
    const { calls } = mockFetch({
      "GET /admin/openrouter/agent-keys": () => state,
      "PUT /admin/openrouter/agent-keys": () => {
        state = { ...state, enabled: false, keys: 0, problems: [] };
        return state;
      },
      "DELETE /admin/openrouter/management-key": () => {
        state = view();
        return state;
      },
    });
    renderWithProviders(<OpenRouterAgentKeys connected />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("One agent's key needs a look");
    expect(
      within(alert).getByRole("link", { name: "support-bot" }),
    ).toHaveAttribute("href", "/agents?agent=agt_1");

    await userEvent.click(screen.getByRole("button", { name: "Turn off" }));
    expect(screen.getByText(/deletes every key it made/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Keep them" }));
    await userEvent.click(screen.getByRole("button", { name: "Turn off" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Turn off and delete the keys" }),
    );
    expect(await screen.findByText("Off")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      enabled: false,
    });

    await userEvent.click(
      screen.getByRole("button", { name: "Remove management key" }),
    );
    expect(
      await screen.findByLabelText("Paste an OpenRouter management key"),
    ).toBeInTheDocument();
  });

  it("can't be turned on until OpenRouter is connected", async () => {
    mockFetch({
      "GET /admin/openrouter/agent-keys": () =>
        view({ managementKey: { set: true }, connected: false }),
    });
    renderWithProviders(<OpenRouterAgentKeys connected={false} />);
    await userEvent.click(await screen.findByText(/Per-agent keys/));
    expect(
      screen.getByRole("button", { name: "Turn on per-agent keys" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Connect OpenRouter above first."),
    ).toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("several problems are counted", async () => {
    mockFetch({
      "GET /admin/openrouter/agent-keys": () =>
        view({
          managementKey: { set: true },
          enabled: true,
          problems: [
            { agentId: "a", agentName: "a", problem: "x" },
            { agentId: "b", agentName: "b", problem: "y" },
          ],
        }),
    });
    renderWithProviders(<OpenRouterAgentKeys connected />);
    expect(
      await screen.findByText("2 agents' keys need a look"),
    ).toBeInTheDocument();
  });
});

const KEY: AgentOpenRouterKey = {
  agentId: "agt_1",
  hash: "h1",
  label: "sk-or-v1-...1c96",
  limit: 5,
  limitReset: "daily",
  disabled: false,
  expiresAt: "2026-12-31T00:00:00Z",
  createdAt: "2026-11-20T00:00:00.000Z",
  syncedAt: "2026-11-20T00:00:00.000Z",
  usage: { today: 1.25, month: 7.5, at: "2026-11-24T00:00:00.000Z" },
};

describe("AgentOpenRouterKeySection", () => {
  const agent = makeAgent({
    id: "agt_1",
    serviceSpend: { openrouter: { today: 1.2, month: 7.4 } },
  });

  it("shows nothing while per-agent keys are off", async () => {
    const { calls } = mockFetch({
      "GET /admin/agents/agt_1/openrouter-key": () => ({
        enabled: false,
        key: null,
        failure: null,
      }),
    });
    renderWithProviders(<AgentOpenRouterKeySection agent={agent} />);
    await waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(
      screen.queryByRole("heading", { name: "OpenRouter key" }),
    ).toBeNull();
  });

  it("shows what OpenRouter enforces and what it says the agent spent", async () => {
    mockFetch({
      "GET /admin/agents/agt_1/openrouter-key": () => ({
        enabled: true,
        key: KEY,
        failure: null,
      }),
    });
    renderWithProviders(<AgentOpenRouterKeySection agent={agent} />);
    expect(await screen.findByText("sk-or-v1-...1c96")).toBeInTheDocument();
    expect(screen.getByText(/\$5\.00 a day, until/)).toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();
    expect(
      screen.getByText(
        "$1.25 today, $7.50 this month (Purser metered $1.20 and $7.40)",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("replaces a broken key", async () => {
    let current: AgentOpenRouterKeyView = {
      enabled: true,
      key: {
        ...KEY,
        limit: null,
        limitReset: null,
        expiresAt: null,
        disabled: true,
        usage: undefined,
        broken: true,
        problem: "This key is gone from OpenRouter.",
      },
      failure: null,
    };
    mockFetch({
      "GET /admin/agents/agt_1/openrouter-key": () => current,
      "POST /admin/agents/agt_1/openrouter-key": () => {
        current = {
          enabled: true,
          key: { ...KEY, label: "sk-or-v1-...new1" },
          failure: null,
        };
        return current;
      },
    });
    renderWithProviders(
      <AgentOpenRouterKeySection agent={makeAgent({ id: "agt_1" })} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "gone from OpenRouter",
    );
    expect(screen.getByText("No limit at OpenRouter")).toBeInTheDocument();
    expect(
      screen.getByText("Disabled, because the agent is stopped"),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Replace the key" }),
    );
    expect(await screen.findByText("sk-or-v1-...new1")).toBeInTheDocument();
  });

  it("explains a key not made yet, and can make it now", async () => {
    let current: AgentOpenRouterKeyView = {
      enabled: true,
      key: null,
      failure: null,
    };
    mockFetch({
      "GET /admin/agents/agt_1/openrouter-key": () => current,
      "POST /admin/agents/agt_1/openrouter-key": () => ({
        status: 503,
        body: {
          error: {
            code: "openrouter_error",
            message: "Could not reach OpenRouter.",
          },
        },
      }),
    });
    const { unmount } = renderWithProviders(
      <AgentOpenRouterKeySection agent={agent} />,
    );
    expect(
      await screen.findByText(/when it first uses OpenRouter/),
    ).toBeInTheDocument();
    unmount();

    current = { enabled: true, key: null, failure: "OpenRouter answered 500." };
    renderWithProviders(<AgentOpenRouterKeySection agent={agent} />);
    expect(
      await screen.findByText(/No key yet: OpenRouter answered 500\./),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Make the key now" }),
    );
    expect(
      await screen.findByText("Could not reach OpenRouter."),
    ).toBeInTheDocument();
  });
});
