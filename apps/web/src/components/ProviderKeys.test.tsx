import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Connector } from "../api/types";
import { mockFetch, renderWithProviders } from "../test/helpers";
import { ProviderKeys } from "./ProviderKeys";

const daysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString();

const connector = (
  extra: { [K in keyof Connector]?: Connector[K] | undefined } = {},
): Connector =>
  ({
    id: "openai",
    name: "OpenAI",
    kind: "openai-compatible",
    source: "builtin",
    agentBaseUrl: "http://127.0.0.1:4141/openai/v1",
    envHint: { baseUrlVar: "A", apiKeyVar: "B" },
    configured: true,
    keyHint: "sk-o...1111",
    keySource: "vault",
    keysUrl: "https://platform.openai.com/api-keys",
    keySetAt: daysAgo(10),
    costSource: "table",
    ...extra,
  }) as Connector;

describe("ProviderKeys", () => {
  it("lists connected providers with their age, and flags old keys", async () => {
    mockFetch({
      "GET /admin/providers": () => [
        connector(),
        connector({
          id: "anthropic",
          name: "Anthropic",
          keySetAt: daysAgo(91),
        }),
        connector({ id: "xai", name: "xAI", keySetAt: undefined }),
        connector({ id: "groq", name: "Groq", configured: false }),
      ],
    });
    renderWithProviders(<ProviderKeys demoKeys={false} />);
    expect(await screen.findByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.queryByText("Groq")).not.toBeInTheDocument();
    expect(screen.getAllByText("Over 90 days old")).toHaveLength(1);
    expect(screen.getByText(/isn't recorded/)).toBeInTheDocument();
    expect(screen.getByText(/no change to any agent/)).toBeInTheDocument();
    expect(screen.queryByText(/any key starting with/)).not.toBeInTheDocument();
  });

  it("says when nothing is connected", async () => {
    mockFetch({
      "GET /admin/providers": () => [connector({ configured: false })],
    });
    renderWithProviders(<ProviderKeys demoKeys={false} />);
    expect(
      await screen.findByText(/No providers are connected/),
    ).toBeInTheDocument();
  });

  it("shows the problem when the list won't load", async () => {
    mockFetch({});
    renderWithProviders(<ProviderKeys demoKeys={false} />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("explains the demo's stand-in keys", async () => {
    mockFetch({ "GET /admin/providers": () => [connector()] });
    renderWithProviders(<ProviderKeys demoKeys />);
    expect(
      await screen.findByText(/any key starting with/),
    ).toBeInTheDocument();
  });

  it("tells you how to replace a key from the environment", async () => {
    mockFetch({
      "GET /admin/providers": () => [
        connector({
          id: "azure-openai",
          name: "Azure OpenAI",
          keySource: "env",
          keySetAt: undefined,
          keysUrl: undefined,
        }),
      ],
    });
    renderWithProviders(<ProviderKeys demoKeys={false} />);
    expect(
      await screen.findByText("PURSER_AZURE_OPENAI_API_KEY"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Replace key" }),
    ).not.toBeInTheDocument();
  });

  it("walks through replacing a key and deleting the old one", async () => {
    const user = userEvent.setup();
    let current = connector();
    const { calls } = mockFetch({
      "GET /admin/providers": () => [current],
      "PUT /admin/providers/openai/key": () => {
        current = connector({
          keyHint: "sk-n...2222",
          keySetAt: daysAgo(0),
          lastTest: { ok: true, at: daysAgo(0) },
          oldKeys: [{ hint: "sk-o...1111", replacedAt: daysAgo(0) }],
        });
        return current;
      },
      "POST /admin/providers/openai/old-keys/deleted": () => {
        current = connector({ keyHint: "sk-n...2222", oldKeys: undefined });
        return current;
      },
    });
    renderWithProviders(<ProviderKeys demoKeys={false} />);

    await user.click(
      await screen.findByRole("button", { name: "Replace key" }),
    );
    expect(screen.getByRole("link", { name: "OpenAI" })).toHaveAttribute(
      "href",
      "https://platform.openai.com/api-keys",
    );
    await user.type(screen.getByLabelText(/Replace your OpenAI key/), "sk-new");
    await user.click(screen.getByRole("button", { name: "Test and switch" }));

    // The form closes, and the old key is what's left to do.
    expect(
      await screen.findByText(/Now delete the old key/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("1 old key still needs deleting.", { exact: false }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/Replace your/)).not.toBeInTheDocument();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      apiKey: "sk-new",
    });

    await user.click(screen.getByRole("button", { name: "I've deleted it" }));
    await waitFor(() =>
      expect(
        screen.queryByText(/Now delete the old key/),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/still needs deleting/)).not.toBeInTheDocument();
  });

  it("keeps the form open with the reason when a new key fails", async () => {
    const user = userEvent.setup();
    mockFetch({
      "GET /admin/providers": () => [connector()],
      "PUT /admin/providers/openai/key": () => ({
        status: 422,
        body: {
          error: {
            code: "key_test_failed",
            message:
              "OpenAI rejected this key. Nothing changed: Purser is still using your current key.",
          },
        },
      }),
    });
    renderWithProviders(<ProviderKeys demoKeys={false} />);
    await user.click(
      await screen.findByRole("button", { name: "Replace key" }),
    );
    await user.type(screen.getByLabelText(/Replace your OpenAI key/), "sk-bad");
    await user.click(screen.getByRole("button", { name: "Test and switch" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "still using your current key",
    );
    expect(
      screen.getByLabelText(/Replace your OpenAI key/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText(/Replace your/)).not.toBeInTheDocument();
  });

  it("talks about several old keys as several", async () => {
    mockFetch({
      "GET /admin/providers": () => [
        connector({
          oldKeys: [
            { hint: "sk-a", replacedAt: daysAgo(2) },
            { hint: "sk-b", replacedAt: daysAgo(1) },
          ],
        }),
      ],
    });
    renderWithProviders(<ProviderKeys demoKeys={false} />);
    expect(
      await screen.findByText(/2 old keys still need deleting/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Now delete the old keys/)).toHaveTextContent(
      "sk-a, sk-b",
    );
    expect(
      screen.getByRole("button", { name: "I've deleted them" }),
    ).toBeInTheDocument();
  });
});
