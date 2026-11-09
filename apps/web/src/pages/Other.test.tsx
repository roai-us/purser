import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActivityPage } from "./Activity";
import { Login } from "./Login";
import { ProvidersPage } from "./Providers";
import { SettingsPage } from "./Settings";
import { App } from "../App";
import {
  makeConnector,
  makeOverview,
  mockFetch,
  renderWithProviders,
  must,
} from "../test/helpers";

afterEach(() => vi.unstubAllGlobals());

describe("Login", () => {
  it("signs in with the admin token", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "POST /auth/session": () => ({ authenticated: true }),
    });
    const onSignedIn = vi.fn();
    renderWithProviders(<Login onSignedIn={onSignedIn} />);
    expect(
      screen.getByText(/Open the link Purser printed/),
    ).toBeInTheDocument();
    const button = screen.getByRole("button", {
      name: "Sign in with the token",
    });
    expect(button).toBeDisabled();
    await user.type(
      screen.getByLabelText("Or paste the admin token"),
      " purser_admin ",
    );
    await user.click(button);
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ token: "purser_admin" });
    expect(post?.headers["x-purser-csrf"]).toBe("1");
    expect(onSignedIn).toHaveBeenCalled();
  });

  it("says when the token is wrong", async () => {
    const user = userEvent.setup();
    mockFetch({ "POST /auth/session": () => ({ status: 401, body: {} }) });
    const onSignedIn = vi.fn();
    renderWithProviders(<Login onSignedIn={onSignedIn} />);
    await user.type(screen.getByLabelText("Or paste the admin token"), "nope");
    await user.click(
      screen.getByRole("button", { name: "Sign in with the token" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("didn't match");
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("explains a used sign-in link", () => {
    window.history.pushState({}, "", "/?login=failed");
    mockFetch({});
    renderWithProviders(<Login onSignedIn={() => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      /expired or was already used/,
    );
    window.history.pushState({}, "", "/");
  });
});

describe("App", () => {
  it("shows the sign-in screen without a session", async () => {
    mockFetch({ "GET /auth/session": () => ({ authenticated: false }) });
    renderWithProviders(<App />);
    expect(
      await screen.findByRole("heading", { name: "Sign in to Purser" }),
    ).toBeInTheDocument();
  });

  it("shows the app with a session and signs out", async () => {
    const user = userEvent.setup();
    let signedIn = true;
    const { calls } = mockFetch({
      "GET /auth/session": () => ({ authenticated: signedIn }),
      "GET /admin/overview": () => makeOverview(),
      "DELETE /auth/session": () => {
        signedIn = false;
        return {};
      },
    });
    renderWithProviders(<App />);
    expect(
      await screen.findByRole("navigation", { name: "Main" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Home" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(
      await screen.findByRole("heading", { name: "Sign in to Purser" }),
    ).toBeInTheDocument();
  });

  it("returns to sign-in when the session expires", async () => {
    mockFetch({
      "GET /auth/session": () => ({ authenticated: true }),
      "GET /admin/overview": () => ({ status: 401, body: {} }),
    });
    renderWithProviders(<App />);
    expect(
      await screen.findByRole("heading", { name: "Sign in to Purser" }),
    ).toBeInTheDocument();
  });

  it("explains when Purser is not running", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("down"))),
    );
    renderWithProviders(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /isn't responding/,
    );
  });
});

describe("Providers", () => {
  it("shows connectors, tests and removes keys", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "GET /admin/providers": () => [
        makeConnector({
          lastTest: { ok: true, at: "2026-11-07T10:00:00Z", latencyMs: 98 },
        }),
        makeConnector({
          id: "corp",
          name: "Corp gateway",
          source: "custom",
          configured: false,
          needsUpstream: true,
          costSource: "table",
        }),
        makeConnector({ id: "openai", name: "OpenAI", keySource: "env" }),
      ],
      "POST /admin/providers/openrouter/test": () => ({
        ok: false,
        error: "Key revoked",
        latencyMs: 50,
      }),
      "DELETE /admin/providers/openrouter/key": () =>
        makeConnector({ configured: false }),
      "PUT /admin/providers/corp/key": () =>
        makeConnector({
          id: "corp",
          name: "Corp gateway",
          lastTest: { ok: false, error: "401 from upstream" },
        }),
    });
    renderWithProviders(<ProvidersPage />);

    const card = must(
      (await screen.findByRole("heading", { name: "OpenRouter" })).closest(
        "section",
      ),
    );
    expect(within(card).getByText(/Worked/)).toBeInTheDocument();
    expect(
      within(card).getByText("The provider's own bill"),
    ).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Test again" }));
    expect(
      await within(card).findByText(/Failed: Key revoked/),
    ).toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "Remove key" }));
    expect(
      within(card).getByText(/stops working until you add a key/),
    ).toBeInTheDocument();
    await user.click(
      within(card).getByRole("button", { name: "Remove the key" }),
    );
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE")).toBe(true),
    );

    const custom = must(
      screen.getByRole("heading", { name: "Corp gateway" }).closest("section"),
    );
    expect(within(custom).getByText("Custom")).toBeInTheDocument();
    await user.type(
      within(custom).getByLabelText("Your Corp gateway address"),
      "https://ai.corp.example/v1",
    );
    await user.type(
      within(custom).getByLabelText("Paste your Corp gateway key"),
      "sk-corp",
    );
    await user.click(
      within(custom).getByRole("button", { name: "Save and test" }),
    );
    expect(
      await within(custom).findByText(/the test failed: 401 from upstream/),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      apiKey: "sk-corp",
      upstream: "https://ai.corp.example/v1",
    });

    const env = must(
      screen.getByRole("heading", { name: "OpenAI" }).closest("section"),
    );
    expect(
      within(env).getByText("An environment variable"),
    ).toBeInTheDocument();
    expect(
      within(env).queryByRole("button", { name: "Save and test" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Custom connectors" }),
    ).toHaveAttribute(
      "href",
      "https://github.com/roai-us/purser/blob/main/docs/connectors.md",
    );
  });

  it("copies the agent address", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    mockFetch({ "GET /admin/providers": () => [makeConnector()] });
    renderWithProviders(<ProvidersPage />);
    await user.click(await screen.findByText("How tools connect"));
    await user.click(
      screen.getByRole("button", { name: "Copy OpenRouter address" }),
    );
    expect(writeText).toHaveBeenCalledWith(
      "http://127.0.0.1:4141/openrouter/api/v1",
    );
    expect(
      screen.getByRole("button", { name: "Copied OpenRouter address" }),
    ).toBeInTheDocument();
  });
});

describe("Activity", () => {
  it("lists events, filters by agent and loads more", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "GET /admin/audit": (call) => {
        const url = new URL(call.url, "http://x");
        if (url.searchParams.get("before")) {
          return {
            items: [
              {
                at: "2026-11-01T10:00:00Z",
                type: "agent.created",
                agentId: "agt_9",
              },
            ],
          };
        }
        return {
          items: [
            {
              at: "2026-11-07T10:00:00Z",
              type: "request.denied",
              agentId: "agt_1",
              detail: { reason: "budget_exceeded" },
            },
            { at: "2026-11-07T09:00:00Z", type: "kill_all" },
          ],
          next: "2026-11-07T09:00:00Z",
        };
      },
    });
    renderWithProviders(<ActivityPage />, { route: "/activity" });
    expect(await screen.findByText("Request refused")).toBeInTheDocument();
    expect(screen.getByText("reason: budget_exceeded")).toBeInTheDocument();
    expect(screen.getByText("Everything stopped")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Agent added")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Agent ID"), "agt_1");
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("agent=agt_1"),
    );
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("agent=agt_1"))).toBe(true),
    );
  });

  it("says when there is nothing yet", async () => {
    mockFetch({ "GET /admin/audit": () => ({ items: [] }) });
    renderWithProviders(<ActivityPage />);
    expect(await screen.findByText("Nothing to show yet.")).toBeInTheDocument();
  });
});

describe("the MCP setting", () => {
  it("shows the address and turns it off", async () => {
    const user = userEvent.setup();
    const org = {
      selfService: true,
      defaults: { autoApproveDailyUsd: 1, maxDailyUsd: 25 },
      signIn: null,
      redirectUri: "http://x/auth/sso/callback",
      mcp: { enabled: true, url: "http://127.0.0.1:4141/mcp" },
    };
    const { calls } = mockFetch({
      "GET /admin/settings": () => ({
        logging: { mode: "off", retentionDays: 30, maxKb: 64 },
      }),
      "GET /admin/settings/org": () => org,
      "PUT /admin/settings/mcp": () => ({
        ...org,
        mcp: { ...org.mcp, enabled: false },
      }),
      "GET /admin/providers": () => [],
    });
    renderWithProviders(<SettingsPage />);
    const box = await screen.findByRole("checkbox", {
      name: "Let agents connect over MCP",
    });
    expect((box as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("http://127.0.0.1:4141/mcp")).toBeTruthy();
    await user.click(box);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
        enabled: false,
      }),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole("checkbox", {
            name: "Let agents connect over MCP",
          }) as HTMLInputElement
        ).checked,
      ).toBe(false),
    );
  });
});
