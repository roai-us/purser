import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HomePage } from "./Home";
import { setupOrder } from "./Setup";
import {
  makeAgent,
  makeConnector,
  makeOverview,
  mockFetch,
  renderWithProviders,
  must,
} from "../test/helpers";

afterEach(() => vi.unstubAllGlobals());

describe("Home overview", () => {
  it("shows spending, agents and recent events", async () => {
    mockFetch({ "GET /admin/overview": () => makeOverview() });
    renderWithProviders(<HomePage />);
    expect(await screen.findByText("$5.42")).toBeInTheDocument();
    expect(screen.getByText("$63.10")).toBeInTheDocument();
    expect(screen.getByText("3 running")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "newsletter-writer" }),
    ).toHaveAttribute("href", "/agents?agent=agt_1");
    expect(screen.getByText("Agent stopped")).toBeInTheDocument();
    expect(screen.queryByText(/need rotating/)).not.toBeInTheDocument();
  });

  it("flags keys that are expiring or expired and links to them", async () => {
    mockFetch({
      "GET /admin/overview": () =>
        makeOverview({ keys: { expiring: 4, expired: 2 } }),
    });
    renderWithProviders(<HomePage />);
    const tile = await screen.findByRole("link", {
      name: /Keys expiring in 14 days/,
    });
    expect(tile).toHaveTextContent("4");
    expect(tile).toHaveTextContent("2 already expired");
    expect(tile).toHaveAttribute("href", "/agents?keyState=expired");
    expect(screen.getByText("6 keys need rotating.")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Rotate expiring keys" }),
    ).toHaveAttribute(
      "href",
      "/agents?keyState=expiring&sort=key_expires&dir=asc",
    );
    expect(
      screen.getByRole("link", { name: "Rotate expired keys" }),
    ).toBeInTheDocument();
  });

  it("asks for STOP before stopping everything", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "GET /admin/overview": () => makeOverview(),
      "POST /admin/kill-all": () => ({
        paused: 3,
        abortedRequests: 2,
        elapsedMs: 5.4,
      }),
    });
    renderWithProviders(<HomePage />);
    await user.click(
      await screen.findByRole("button", { name: "Stop everything" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Stop everything" });
    expect(dialog).toHaveTextContent("This stops 3 agents");
    const confirm = within(dialog).getByRole("button", {
      name: "Stop everything",
    });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Type STOP/), "stop");
    expect(confirm).toBeDisabled();
    await user.clear(within(dialog).getByLabelText(/Type STOP/));
    await user.type(within(dialog).getByLabelText(/Type STOP/), "STOP");
    await user.click(confirm);
    expect(calls.some((c) => c.url === "/admin/kill-all")).toBe(true);
    expect(
      await within(dialog).findByText("Stopped 3 agents in 5 ms."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Cut 2 requests that were still running."),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the stop dialog with Escape", async () => {
    const user = userEvent.setup();
    mockFetch({
      "GET /admin/overview": () =>
        makeOverview({ topToday: [], recentEvents: [] }),
    });
    renderWithProviders(<HomePage />);
    expect(
      await screen.findByText("No spending yet today."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop everything" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows an error when the overview fails", async () => {
    mockFetch({
      "GET /admin/overview": () => ({
        status: 500,
        body: { error: { code: "x", message: "Broken." } },
      }),
    });
    renderWithProviders(<HomePage />);
    expect(await screen.findByText("Broken.")).toBeInTheDocument();
  });
});

describe("First-run setup", () => {
  it("puts OpenRouter first", () => {
    const order = setupOrder([
      makeConnector({ id: "custom", source: "custom" }),
      makeConnector({ id: "openai" }),
      makeConnector({ id: "openrouter" }),
    ]).map((c) => c.id);
    expect(order).toEqual(["openrouter", "openai", "custom"]);
  });

  it("walks through connecting, adding an agent and testing it", async () => {
    const user = userEvent.setup();
    let configured = false;
    const { calls } = mockFetch({
      "GET /admin/overview": () =>
        makeOverview({
          providers: { configured: configured ? 1 : 0, total: 2 },
          agents: { total: 0, running: 0, paused: 0, atLimit: 0, expired: 0 },
          topToday: [],
          recentEvents: [],
        }),
      "GET /admin/providers": () => [
        makeConnector({
          id: "openai",
          name: "OpenAI",
          configured: false,
          keyHint: undefined as never,
        }),
        makeConnector({ configured }),
      ],
      "PUT /admin/providers/openrouter/key": () => {
        configured = true;
        return makeConnector({
          lastTest: { ok: true, at: "2026-11-07T10:00:00Z", latencyMs: 120 },
        });
      },
      "POST /admin/agents": () => ({
        status: 201,
        body: { agent: makeAgent({ name: "writer" }), key: "purser_setupkey" },
      }),
      "POST /openrouter/api/v1/chat/completions": () => ({
        model: "openai/gpt-4o-mini",
        usage: { cost: 0.0001 },
      }),
    });
    const onDone = vi.fn();
    renderWithProviders(<HomePage />);

    expect(
      await screen.findByRole("heading", { name: "Connect your AI accounts" }),
    ).toBeInTheDocument();
    const cards = screen
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent);
    expect(cards[0]).toBe("OpenRouter");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();

    await user.type(
      screen.getByLabelText("Paste your OpenRouter key"),
      "sk-or-test",
    );
    await user.click(
      must(screen.getAllByRole("button", { name: "Save and test" })[0]),
    );
    expect(
      await screen.findByText(/Works. The key is locked away/),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      apiKey: "sk-or-test",
    });

    await user.click(await screen.findByRole("button", { name: "Continue" }));
    expect(
      screen.getByRole("heading", { name: "Add your first agent" }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText("Name"), "writer");
    await user.type(screen.getByLabelText("Who is responsible for it"), "Dana");
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    expect(await screen.findByTestId("agent-key")).toHaveTextContent(
      "purser_setupkey",
    );

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      screen.getByRole("heading", { name: "Connect writer" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("tab", { name: "In code or a terminal" }),
    );
    expect(
      screen.getByText(
        /OPENAI_BASE_URL=http:\/\/127.0.0.1:4141\/openrouter\/api\/v1/,
      ),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Send a test request" }),
    );
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("$0.0001")).toBeInTheDocument();
    const test = must(calls.find((c) => c.url.endsWith("/chat/completions")));
    expect(test.headers.authorization).toBe("Bearer purser_setupkey");

    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(onDone).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("heading", { name: "Home" }),
    ).toBeInTheDocument();
  });
});
