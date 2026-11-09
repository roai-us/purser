import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OrgSettingsView, SignInConfig } from "../api/types";
import {
  policySummary,
  readPolicy,
  SelfServiceSettings,
  shortUsd,
  SignInSettings,
  splitList,
} from "./OrgSettings";
import {
  makeConnector,
  mockFetch,
  must,
  renderWithProviders,
  type Call,
} from "../test/helpers";

afterEach(() => vi.unstubAllGlobals());

const REDIRECT = "https://purser.example.com/auth/sso/callback";

const config: SignInConfig = {
  issuer: "https://login.microsoftonline.com/1234/v2.0",
  clientId: "client-1",
  allowedDomains: ["example.com", "example.org"],
  adminEmails: ["ana@example.com"],
  hasSecret: true,
  redirectUri: REDIRECT,
};

function view(overrides: Partial<OrgSettingsView> = {}): OrgSettingsView {
  return {
    selfService: true,
    defaults: { autoApproveDailyUsd: 2, maxDailyUsd: 25 },
    signIn: null,
    redirectUri: REDIRECT,
    ...overrides,
  };
}

/** A stand-in server that remembers what was saved. */
function setup(
  ui: ReactElement,
  start: OrgSettingsView = view(),
  extra: Parameters<typeof mockFetch>[0] = {},
) {
  let current = start;
  const fetched = mockFetch({
    "GET /admin/settings/org": () => current,
    "GET /admin/providers": () => [
      makeConnector(),
      makeConnector({ id: "anthropic", name: "Anthropic" }),
    ],
    "PUT /admin/settings/self-service": (call: Call) => {
      const body = call.body as Partial<OrgSettingsView>;
      current = { ...current, ...body };
      return current;
    },
    "PUT /admin/settings/sign-in": (call: Call) => {
      const body = call.body as SignInConfig & { clientSecret?: string };
      current = {
        ...current,
        signIn: {
          issuer: body.issuer,
          clientId: body.clientId,
          allowedDomains: body.allowedDomains,
          adminEmails: body.adminEmails,
          hasSecret: Boolean(body.clientSecret ?? current.signIn?.hasSecret),
          redirectUri: REDIRECT,
        },
      };
      return current;
    },
    "DELETE /admin/settings/sign-in": () => {
      current = { ...current, signIn: null };
      return current;
    },
    ...extra,
  });
  return { ...fetched, ...renderWithProviders(ui, { route: "/settings" }) };
}

const lastBody = (calls: Call[], method: string) =>
  must(calls.filter((c) => c.method === method).at(-1), method).body;

describe("rules helpers", () => {
  it("writes the rules in a few words", () => {
    expect(shortUsd(2)).toBe("$2");
    expect(shortUsd(2500)).toBe("$2,500");
    expect(shortUsd(2.5)).toBe("$2.50");
    expect(policySummary({ autoApproveDailyUsd: 2, maxDailyUsd: 25 })).toBe(
      "Ready up to $2/day, max $25/day",
    );
    expect(policySummary({ autoApproveDailyUsd: 0, maxDailyUsd: 25 })).toBe(
      "Always needs a manager, max $25/day",
    );
  });

  it("reads and checks a rules form", () => {
    expect(readPolicy({ auto: "0", max: "$1,000", providers: [] })).toEqual({
      policy: { autoApproveDailyUsd: 0, maxDailyUsd: 1000 },
    });
    expect(readPolicy({ auto: "", max: "5", providers: [] })).toHaveProperty(
      "problem",
    );
    expect(readPolicy({ auto: "1", max: "", providers: [] })).toHaveProperty(
      "problem",
    );
    expect(readPolicy({ auto: "6", max: "5", providers: [] })).toHaveProperty(
      "problem",
    );
  });

  it("splits lists on commas, spaces and semicolons", () => {
    expect(splitList(" a.com, b.com  c.com;d.com,, ")).toEqual([
      "a.com",
      "b.com",
      "c.com",
      "d.com",
    ]);
  });
});

describe("SelfServiceSettings", () => {
  it("saves whether people can ask, and the organisation defaults", async () => {
    const user = userEvent.setup();
    const { calls } = setup(<SelfServiceSettings />);
    const card = within(
      await screen.findByRole("form", { name: "Asking for agents" }),
    );
    expect(card.getByRole("link", { name: "Departments" })).toHaveAttribute(
      "href",
      "/departments",
    );
    const toggle = card.getByLabelText("Let people ask for agents themselves");
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(card.getByText(/only admins can add agents/)).toBeInTheDocument();

    const auto = card.getByLabelText(/Ready straight away/);
    expect(auto).toHaveAccessibleDescription(
      "0 means a manager always decides.",
    );
    await user.clear(auto);
    await user.type(auto, "5");
    const max = card.getByLabelText(/Nobody can ask for more than/);
    await user.clear(max);
    await user.type(max, "50");
    await user.click(await card.findByLabelText("OpenRouter"));
    await user.click(card.getByRole("button", { name: "Save" }));

    expect(await card.findByRole("status")).toHaveTextContent("Saved.");
    expect(lastBody(calls, "PUT")).toEqual({
      selfService: false,
      defaults: {
        autoApproveDailyUsd: 5,
        maxDailyUsd: 50,
        allowedProviders: ["openrouter"],
      },
    });
  });

  it("won't save a ready-straight-away amount above the maximum", async () => {
    const user = userEvent.setup();
    const { calls } = setup(<SelfServiceSettings />);
    const card = within(
      await screen.findByRole("form", { name: "Asking for agents" }),
    );
    const auto = card.getByLabelText(/Ready straight away/);
    await user.clear(auto);
    await user.type(auto, "30");
    await user.click(card.getByRole("button", { name: "Save" }));
    expect(card.getByRole("alert")).toHaveTextContent(
      "can't be more than the most anyone can ask for",
    );
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("shows server errors when saving and loading", async () => {
    const user = userEvent.setup();
    setup(<SelfServiceSettings />, view(), {
      "PUT /admin/settings/self-service": () => ({
        status: 400,
        body: {
          error: { code: "invalid_request", message: "Check the rules." },
        },
      }),
    });
    const card = within(
      await screen.findByRole("form", { name: "Asking for agents" }),
    );
    await user.click(card.getByRole("button", { name: "Save" }));
    expect(await card.findByRole("alert")).toHaveTextContent(
      "Check the rules.",
    );
    vi.unstubAllGlobals();

    mockFetch({
      "GET /admin/settings/org": () => ({
        status: 500,
        body: { error: { code: "x", message: "Settings broke." } },
      }),
    });
    renderWithProviders(<SelfServiceSettings />);
    const failed = await screen.findByRole("region", {
      name: "Asking for agents",
    });
    expect(await within(failed).findByRole("alert")).toHaveTextContent(
      "Settings broke.",
    );
  });
});

describe("SignInSettings", () => {
  it("sets up company sign-in with a secret", async () => {
    const user = userEvent.setup();
    const { calls } = setup(<SignInSettings />);
    const card = within(
      await screen.findByRole("form", { name: "Company sign-in" }),
    );
    expect(card.getByText(REDIRECT)).toBeInTheDocument();
    expect(card.getByText(/Purser never sees it/)).toBeInTheDocument();
    expect(card.queryByText(/People sign in at/)).not.toBeInTheDocument();
    expect(
      card.queryByRole("button", { name: "Turn off company sign-in" }),
    ).not.toBeInTheDocument();
    expect(card.getByLabelText("Issuer URL")).toHaveAccessibleDescription(
      /not common/,
    );

    await user.click(card.getByRole("button", { name: "Copy redirect URI" }));
    expect(await navigator.clipboard.readText()).toBe(REDIRECT);

    await user.type(card.getByLabelText("Issuer URL"), "https://acme.okta.com");
    await user.type(card.getByLabelText("Client ID"), " okta-client ");
    await user.type(card.getByLabelText("Client secret"), "s3cret");
    await user.type(
      card.getByLabelText("Allowed email domains"),
      "Acme.com acme.co.uk",
    );
    await user.type(card.getByLabelText("Button label (optional)"), "Okta");
    await user.click(card.getByRole("button", { name: "Save" }));

    expect(await card.findByRole("status")).toHaveTextContent(
      "Saved. Company sign-in is on.",
    );
    expect(lastBody(calls, "PUT")).toEqual({
      issuer: "https://acme.okta.com",
      clientId: "okta-client",
      clientSecret: "s3cret",
      allowedDomains: ["acme.com", "acme.co.uk"],
      adminEmails: [],
      label: "Okta",
    });
    expect(
      await card.findByText(/People sign in at http:\/\/localhost/),
    ).toBeInTheDocument();
  });

  it("keeps the saved secret when the box is left blank", async () => {
    const user = userEvent.setup();
    const { calls } = setup(
      <SignInSettings />,
      view({ signIn: { ...config, label: "Microsoft" } }),
    );
    const card = within(
      await screen.findByRole("form", { name: "Company sign-in" }),
    );
    expect(card.getByText(/People sign in at/)).toBeInTheDocument();
    expect(card.getByLabelText("Client secret")).toHaveAccessibleDescription(
      "A secret is saved. Leave blank to keep it.",
    );
    expect(card.getByLabelText("Issuer URL")).toHaveValue(config.issuer);
    expect(card.getByLabelText("Allowed email domains")).toHaveValue(
      "example.com, example.org",
    );
    expect(card.getByLabelText("Button label (optional)")).toHaveValue(
      "Microsoft",
    );
    await user.click(card.getByRole("button", { name: "Save" }));
    await card.findByRole("status");
    const body = lastBody(calls, "PUT");
    expect(body).not.toHaveProperty("clientSecret");
    expect(body).toEqual({
      issuer: config.issuer,
      clientId: "client-1",
      allowedDomains: ["example.com", "example.org"],
      adminEmails: ["ana@example.com"],
      label: "Microsoft",
    });
  });

  it("sends a new secret when one is typed, or removes it when asked", async () => {
    const user = userEvent.setup();
    const { calls } = setup(<SignInSettings />, view({ signIn: config }));
    const card = within(
      await screen.findByRole("form", { name: "Company sign-in" }),
    );
    const remove = card.getByLabelText("Remove the saved secret");
    await user.type(card.getByLabelText("Client secret"), "new-secret");
    expect(remove).toBeDisabled();
    await user.click(card.getByRole("button", { name: "Save" }));
    await card.findByRole("status");
    expect(lastBody(calls, "PUT")).toMatchObject({
      clientSecret: "new-secret",
    });

    await waitFor(() =>
      expect(card.getByLabelText("Client secret")).toHaveValue(""),
    );
    await user.click(card.getByLabelText("Remove the saved secret"));
    await user.click(card.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2),
    );
    expect(lastBody(calls, "PUT")).toMatchObject({ clientSecret: "" });
  });

  it("checks the form before saving", async () => {
    const user = userEvent.setup();
    const { calls } = setup(<SignInSettings />);
    const card = within(
      await screen.findByRole("form", { name: "Company sign-in" }),
    );
    const save = card.getByRole("button", { name: "Save" });
    const issuer = card.getByLabelText("Issuer URL");

    await user.click(save);
    expect(card.getByRole("alert")).toHaveTextContent("starts with https://");
    await user.type(issuer, "http://acme.okta.com");
    await user.click(save);
    expect(card.getByRole("alert")).toHaveTextContent("starts with https://");

    await user.clear(issuer);
    await user.type(issuer, "https://login.microsoftonline.com/common/v2.0");
    await user.click(save);
    expect(card.getByRole("alert")).toHaveTextContent("Use your own tenant id");

    await user.clear(issuer);
    await user.type(issuer, "http://localhost:8080/realms/test");
    await user.click(save);
    expect(card.getByRole("alert")).toHaveTextContent("Enter the client ID.");

    await user.type(card.getByLabelText("Client ID"), "abc");
    await user.click(save);
    expect(card.getByRole("alert")).toHaveTextContent(
      "Add at least one email domain",
    );
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("shows the server's error", async () => {
    const user = userEvent.setup();
    setup(<SignInSettings />, view({ signIn: config }), {
      "PUT /admin/settings/sign-in": () => ({
        status: 400,
        body: {
          error: {
            code: "invalid_request",
            message: "Check the sign-in details.",
          },
        },
      }),
    });
    const card = within(
      await screen.findByRole("form", { name: "Company sign-in" }),
    );
    await user.click(card.getByRole("button", { name: "Save" }));
    expect(await card.findByRole("alert")).toHaveTextContent(
      "Check the sign-in details.",
    );
  });

  it("turns company sign-in off after asking", async () => {
    const user = userEvent.setup();
    const { calls } = setup(<SignInSettings />, view({ signIn: config }));
    const card = within(
      await screen.findByRole("form", { name: "Company sign-in" }),
    );
    await user.click(
      card.getByRole("button", { name: "Turn off company sign-in" }),
    );
    let confirm = within(screen.getByRole("dialog"));
    await user.click(confirm.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    await user.click(
      card.getByRole("button", { name: "Turn off company sign-in" }),
    );
    confirm = within(screen.getByRole("dialog"));
    expect(confirm.getByText(/client secret is deleted/)).toBeInTheDocument();
    await user.click(confirm.getByRole("button", { name: "Turn off" }));

    expect(await card.findByRole("status")).toHaveTextContent(
      "Company sign-in is off.",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(card.getByLabelText("Issuer URL")).toHaveValue("");
    expect(
      card.queryByRole("button", { name: "Turn off company sign-in" }),
    ).not.toBeInTheDocument();
  });

  it("shows an error when turning off fails", async () => {
    const user = userEvent.setup();
    setup(<SignInSettings />, view({ signIn: config }), {
      "DELETE /admin/settings/sign-in": () => ({
        status: 500,
        body: { error: { code: "x", message: "Could not turn it off." } },
      }),
    });
    const card = within(
      await screen.findByRole("form", { name: "Company sign-in" }),
    );
    await user.click(
      card.getByRole("button", { name: "Turn off company sign-in" }),
    );
    const confirm = within(screen.getByRole("dialog"));
    await user.click(confirm.getByRole("button", { name: "Turn off" }));
    expect(await confirm.findByRole("alert")).toHaveTextContent(
      "Could not turn it off.",
    );
  });

  it("shows a loading state first", () => {
    mockFetch({ "GET /admin/settings/org": () => new Promise(() => {}) });
    renderWithProviders(<SignInSettings />);
    expect(
      screen.getByRole("region", { name: "Company sign-in" }),
    ).toHaveTextContent("Loading");
  });
});
