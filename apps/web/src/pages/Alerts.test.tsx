import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AlertChannel, AlertsView, SmtpSettings } from "../api/types";
import { mockFetch, renderWithProviders } from "../test/helpers";
import { AlertsPage, pathOf, splitAddresses } from "./Alerts";

afterEach(() => vi.unstubAllGlobals());

const TYPES: AlertsView["types"] = [
  { type: "agent.at_limit", words: "An agent reached its spending limit" },
  { type: "agent.stopped", words: "An agent was stopped" },
  { type: "workflow.stop", words: "A workflow crossed its stop line" },
];

function channel(over: Partial<AlertChannel> = {}): AlertChannel {
  return {
    id: "ch_1",
    name: "Ops in Slack",
    kind: "slack",
    events: [],
    enabled: true,
    createdAt: "2026-11-20T10:00:00.000Z",
    urlHint: "https://hooks.slack.com/…ab12",
    signed: false,
    lastDelivery: { at: "2026-11-24T10:00:00.000Z", ok: true },
    ...over,
  };
}

function view(over: Partial<AlertsView> = {}): AlertsView {
  return {
    settings: {
      nearLimitPercent: 80,
      spikeMultiple: 3,
      spikeMinUsd: 5,
      keyExpiringDays: 7,
    },
    smtp: null,
    channels: [
      channel(),
      channel({
        id: "ch_2",
        name: "Finance webhook",
        kind: "webhook",
        events: ["agent.at_limit", "workflow.stop"],
        enabled: false,
        signed: true,
        urlHint: "https://hooks.example.com/…9z9z",
        lastDelivery: {
          at: "2026-11-24T09:00:00.000Z",
          ok: false,
          error: "The receiver answered 500.",
        },
      }),
      channel({
        id: "ch_3",
        name: "Quiet",
        kind: "discord",
        lastDelivery: undefined,
      }),
    ],
    types: TYPES,
    recent: [
      {
        id: "alr_1",
        type: "agent.at_limit",
        severity: "warning",
        at: "2026-11-24T10:00:00.000Z",
        title: "support-bot reached its daily limit",
        text: "support-bot (owner Dana Ortiz) has spent $10.50 of its $10.00 daily limit.",
        url: "https://purser.example.com/agents?agent=agt_1",
        count: 1,
        deliveries: [
          {
            channelId: "ch_1",
            channelName: "Ops in Slack",
            ok: true,
            attempts: 1,
          },
          {
            channelId: "ch_2",
            channelName: "Finance webhook",
            ok: false,
            attempts: 3,
            error: "No answer within 5 seconds.",
          },
        ],
      },
      {
        id: "alr_2",
        type: "workflow.stop",
        severity: "critical",
        at: "2026-11-24T09:00:00.000Z",
        title: "Invoice matching crossed its stop line",
        text: "By the rule...",
        url: "not a url",
        count: 1,
        deliveries: [],
      },
    ],
    ...over,
  };
}

describe("AlertsPage", () => {
  it("lists channels, settings and recent alerts", async () => {
    mockFetch({ "GET /admin/alerts": () => view() });
    renderWithProviders(<AlertsPage />);
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("Ops in Slack");
    expect(rows[1]).toHaveTextContent("Slack · https://hooks.slack.com/…ab12");
    expect(rows[1]).toHaveTextContent("Every alert");
    expect(rows[1]).toHaveTextContent("Delivered");
    expect(rows[2]).toHaveTextContent("paused");
    expect(rows[2]).toHaveTextContent("A workflow crossed its stop line");
    expect(rows[2]).toHaveTextContent("The receiver answered 500.");
    expect(rows[3]).toHaveTextContent("Nothing sent yet");
    expect(
      within(rows[2] as HTMLElement).getByRole("button", {
        name: "Resume Finance webhook",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Warn at this share of a limit (%)"),
    ).toHaveValue("80");

    const link = screen.getByRole("link", {
      name: "support-bot reached its daily limit",
    });
    expect(link).toHaveAttribute("href", "/agents?agent=agt_1");
    expect(screen.getByText("Ops in Slack: sent")).toHaveClass("ok");
    expect(screen.getByText("Finance webhook: failed")).toHaveAttribute(
      "title",
      "No answer within 5 seconds.",
    );
    expect(
      screen.getByText("No channel takes this alert."),
    ).toBeInTheDocument();
    expect(screen.getByText("Critical")).toHaveClass("severity-critical");
  });

  it("explains channels when there are none", async () => {
    mockFetch({
      "GET /admin/alerts": () => view({ channels: [], recent: [] }),
    });
    renderWithProviders(<AlertsPage />);
    expect(await screen.findByText(/No channels yet/)).toBeInTheDocument();
    expect(screen.getByText("No alerts yet.")).toBeInTheDocument();
    await userEvent.click(
      screen.getAllByRole("button", {
        name: "Add a channel",
      })[1] as HTMLElement,
    );
    expect(
      screen.getByRole("dialog", { name: "Add a channel" }),
    ).toBeInTheDocument();
  });

  it("shows an error when alerts can't load", async () => {
    mockFetch({
      "GET /admin/alerts": () => ({
        status: 500,
        body: { error: { code: "internal", message: "Internal error." } },
      }),
    });
    renderWithProviders(<AlertsPage />);
    expect(await screen.findByText("Internal error.")).toBeInTheDocument();
  });

  it("adds a webhook for chosen alerts and shows its signing secret once", async () => {
    const { calls } = mockFetch({
      "GET /admin/alerts": () => view({ channels: [] }),
      "POST /admin/alerts/channels": () => ({
        status: 201,
        body: {
          channel: channel({ name: "Ops hook", kind: "webhook", signed: true }),
          signingSecret: "whsec_abc123",
        },
      }),
    });
    renderWithProviders(<AlertsPage />);
    await userEvent.click(
      (
        await screen.findAllByRole("button", { name: "Add a channel" })
      )[0] as HTMLElement,
    );
    const dialog = screen.getByRole("dialog", { name: "Add a channel" });
    const submit = () =>
      userEvent.click(
        within(dialog).getByRole("button", { name: "Add channel" }),
      );
    await submit();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Give the channel a name.",
    );
    await userEvent.type(within(dialog).getByLabelText("Name"), "Ops hook");
    await submit();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Paste the channel's URL.",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Webhook" }),
    );
    expect(
      within(dialog).getByText(/Purser sends JSON and signs it/),
    ).toBeInTheDocument();
    await userEvent.type(
      within(dialog).getByLabelText("URL"),
      "hooks.example.com/x",
    );
    await submit();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "starts with https://",
    );
    await userEvent.clear(within(dialog).getByLabelText("URL"));
    await userEvent.type(
      within(dialog).getByLabelText("URL"),
      "https://hooks.example.com/x",
    );
    await userEvent.click(within(dialog).getByLabelText("Only these"));
    await submit();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "at least one kind of alert",
    );
    await userEvent.click(
      within(dialog).getByLabelText("A workflow crossed its stop line"),
    );
    await userEvent.click(
      within(dialog).getByLabelText("An agent was stopped"),
    );
    await userEvent.click(
      within(dialog).getByLabelText("An agent was stopped"),
    );
    await submit();

    expect(await screen.findByText("whsec_abc123")).toBeInTheDocument();
    expect(screen.getByText(/Added Ops hook/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      name: "Ops hook",
      kind: "webhook",
      url: "https://hooks.example.com/x",
      events: ["workflow.stop"],
    });
  });

  it("edits a channel, keeping the saved URL unless a new one is pasted", async () => {
    const { calls } = mockFetch({
      "GET /admin/alerts": () => view(),
      "PATCH /admin/alerts/channels/ch_1": (call) => ({
        channel: channel({ ...(call.body as Partial<AlertChannel>) }),
      }),
    });
    renderWithProviders(<AlertsPage />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Edit Ops in Slack" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Edit Ops in Slack" });
    expect(
      within(dialog).getByText(
        /keeps the saved URL secret \(https:\/\/hooks\.slack\.com\/…ab12\)/,
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("group", { name: "Kind of channel" }),
    ).toBeNull();
    await userEvent.clear(within(dialog).getByLabelText("Name"));
    await userEvent.type(within(dialog).getByLabelText("Name"), "Ops");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved Ops.")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
      name: "Ops",
      events: [],
    });

    await userEvent.click(
      screen.getByRole("button", { name: "Edit Ops in Slack" }),
    );
    const again = screen.getByRole("dialog", { name: "Edit Ops in Slack" });
    await userEvent.type(
      within(again).getByLabelText("New URL (optional)"),
      "https://hooks.slack.com/new",
    );
    await userEvent.click(within(again).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === "PATCH").at(-1)?.body,
      ).toMatchObject({
        url: "https://hooks.slack.com/new",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Edit Finance webhook" }),
    );
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("tests, pauses, resumes and removes channels", async () => {
    let ok = true;
    const { calls } = mockFetch({
      "GET /admin/alerts": () => view(),
      "POST /admin/alerts/channels/ch_1/test": () => ({
        delivery: ok
          ? {
              channelId: "ch_1",
              channelName: "Ops in Slack",
              ok: true,
              attempts: 1,
            }
          : {
              channelId: "ch_1",
              channelName: "Ops in Slack",
              ok: false,
              attempts: 1,
              error: "The receiver answered 404.",
            },
      }),
      "POST /admin/alerts/channels/ch_3/test": () => ({
        delivery: {
          channelId: "ch_3",
          channelName: "Quiet",
          ok: false,
          attempts: 3,
        },
      }),
      "PATCH /admin/alerts/channels/ch_1": () => ({
        channel: channel({ enabled: false }),
      }),
      "PATCH /admin/alerts/channels/ch_2": () => ({
        channel: channel({
          id: "ch_2",
          name: "Finance webhook",
          enabled: true,
        }),
      }),
      "DELETE /admin/alerts/channels/ch_3": () => ({ removed: "ch_3" }),
    });
    renderWithProviders(<AlertsPage />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Send a test to Ops in Slack",
      }),
    );
    expect(
      await screen.findByText(
        "Sent a test to Ops in Slack. Check that it arrived.",
      ),
    ).toBeInTheDocument();
    ok = false;
    await userEvent.click(
      screen.getByRole("button", { name: "Send a test to Ops in Slack" }),
    );
    expect(
      await screen.findByText(
        "The test to Ops in Slack failed: The receiver answered 404.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Send a test to Quiet" }),
    );
    expect(
      await screen.findByText("The test to Quiet failed: Not delivered"),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Pause Ops in Slack" }),
    );
    expect(
      await screen.findByText("Ops in Slack is paused."),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Resume Finance webhook" }),
    );
    expect(
      await screen.findByText("Finance webhook gets alerts again."),
    ).toBeInTheDocument();
    expect(
      calls.find((c) => c.url.endsWith("/ch_1") && c.method === "PATCH")?.body,
    ).toEqual({
      enabled: false,
    });

    await userEvent.click(screen.getByRole("button", { name: "Remove Quiet" }));
    const confirm = screen.getByRole("dialog", { name: "Remove Quiet?" });
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Cancel" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove Quiet" }));
    await userEvent.click(
      within(screen.getByRole("dialog", { name: "Remove Quiet?" })).getByRole(
        "button",
        {
          name: "Remove",
        },
      ),
    );
    expect(await screen.findByText("Removed Quiet.")).toBeInTheDocument();
  });

  it("saves thresholds, and explains a bad one", async () => {
    const { calls } = mockFetch({
      "GET /admin/alerts": () => view(),
      "PUT /admin/alerts/settings": (call) => ({ settings: call.body }),
    });
    renderWithProviders(<AlertsPage />);
    const field = (label: string) => screen.getByLabelText(label);
    await screen.findByRole("table");
    const save = () =>
      userEvent.click(
        screen.getAllByRole("button", { name: "Save" })[0] as HTMLElement,
      );
    const cases: [string, string, RegExp][] = [
      ["Warn at this share of a limit (%)", "100", /whole percent/],
      ["A spike is this many times the usual rate", "1", /1.5 to 100/],
      ["...and at least this much in a day ($)", "-2", /dollar amount/],
      ["Warn about keys this many days ahead", "0", /1 to 90 days/],
    ];
    for (const [label, value, problem] of cases) {
      const before = (field(label) as HTMLInputElement).value;
      await userEvent.clear(field(label));
      await userEvent.type(field(label), value);
      await save();
      expect(screen.getByRole("alert")).toHaveTextContent(problem);
      await userEvent.clear(field(label));
      await userEvent.type(field(label), before);
    }
    await userEvent.clear(field("Warn at this share of a limit (%)"));
    await userEvent.type(field("Warn at this share of a limit (%)"), "90%");
    await userEvent.clear(field("...and at least this much in a day ($)"));
    await userEvent.type(
      field("...and at least this much in a day ($)"),
      "$12",
    );
    await save();
    expect(await screen.findByText("Saved when to alert.")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      nearLimitPercent: 90,
      spikeMultiple: 3,
      spikeMinUsd: 12,
      keyExpiringDays: 7,
    });
  });
});

describe("pathOf", () => {
  it("keeps an alert's link inside the app", () => {
    expect(pathOf("https://x.example/workflows/A%20B/report?from=1")).toBe(
      "/workflows/A%20B/report?from=1",
    );
    expect(pathOf("nope")).toBe("/");
  });
});

const SMTP: SmtpSettings = {
  host: "smtp.example.com",
  port: 587,
  security: "starttls",
  username: "alerts@example.com",
  from: "purser@example.com",
  passwordSet: true,
};

describe("the mail server", () => {
  it("is set up from the page, following the usual port", async () => {
    let smtp: SmtpSettings | null = null;
    const { calls } = mockFetch({
      "GET /admin/alerts": () => view({ smtp }),
      "PUT /admin/alerts/smtp": (call) => {
        const { password, ...rest } = call.body as SmtpSettings & {
          password?: string;
        };
        smtp = { ...rest, passwordSet: Boolean(password) };
        return { smtp };
      },
    });
    renderWithProviders(<AlertsPage />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Set up email" }),
    );
    const save = () =>
      userEvent.click(screen.getByRole("button", { name: "Save mail server" }));
    await save();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter the mail server's address.",
    );
    await userEvent.type(
      screen.getByLabelText("Server address"),
      "smtp.example.com",
    );
    await save();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter the address alerts come from.",
    );
    await userEvent.type(
      screen.getByLabelText("Send from"),
      "purser@example.com",
    );

    // The port follows the encryption until someone types their own.
    expect(screen.getByLabelText("Port")).toHaveValue("587");
    await userEvent.click(screen.getByLabelText(/^TLS/));
    expect(screen.getByLabelText("Port")).toHaveValue("465");
    await userEvent.click(screen.getByLabelText(/^None/));
    expect(screen.getByLabelText("Port")).toHaveValue("25");
    await userEvent.type(screen.getByLabelText("Username"), "alerts");
    await userEvent.type(screen.getByLabelText("Password"), "pw");
    await save();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Choose TLS or STARTTLS",
    );
    await userEvent.click(screen.getByLabelText(/^STARTTLS/));
    expect(screen.getByLabelText("Port")).toHaveValue("587");
    await userEvent.clear(screen.getByLabelText("Port"));
    await userEvent.type(screen.getByLabelText("Port"), "70000");
    await save();
    expect(screen.getByRole("alert")).toHaveTextContent("1 to 65535");
    await userEvent.clear(screen.getByLabelText("Port"));
    await userEvent.type(screen.getByLabelText("Port"), "2525");
    await userEvent.click(screen.getByLabelText(/^TLS/));
    expect(screen.getByLabelText("Port")).toHaveValue("2525");
    await save();

    expect(
      await screen.findByText(/Saved the mail server/),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      host: "smtp.example.com",
      port: 2525,
      security: "tls",
      username: "alerts",
      password: "pw",
      from: "purser@example.com",
    });
    expect(
      await screen.findByText(/Email alerts go out through/),
    ).toHaveTextContent(
      "smtp.example.com:2525 with TLS, from purser@example.com, signing in as alerts.",
    );
  });

  it("keeps the saved password unless a new one is typed, and can be removed", async () => {
    let smtp: SmtpSettings | null = SMTP;
    const { calls } = mockFetch({
      "GET /admin/alerts": () => view({ smtp }),
      "PUT /admin/alerts/smtp": () => ({ smtp }),
      "DELETE /admin/alerts/smtp": () => {
        smtp = null;
        return { smtp: null };
      },
    });
    renderWithProviders(<AlertsPage />);
    expect(
      await screen.findByText(/Email alerts go out through/),
    ).toHaveTextContent("with STARTTLS");
    await userEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.getByLabelText("Server address")).toHaveValue(
      "smtp.example.com",
    );
    expect(screen.getByText(/A password is saved/)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Save mail server" }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
        host: "smtp.example.com",
        port: 587,
        security: "starttls",
        username: "alerts@example.com",
        from: "purser@example.com",
      }),
    );

    // No username means nothing to sign in with, so the password goes.
    await userEvent.click(
      await screen.findByRole("button", { name: "Change" }),
    );
    await userEvent.clear(screen.getByLabelText("Username"));
    await userEvent.click(
      screen.getByRole("button", { name: "Save mail server" }),
    );
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === "PUT").at(-1)?.body,
      ).toMatchObject({ username: "", password: "" }),
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Remove" }),
    );
    const confirm = screen.getByRole("dialog", {
      name: "Remove the mail server?",
    });
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Remove" }),
    );
    expect(
      await screen.findByText(/Removed the mail server/),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Set up email" }),
    ).toBeInTheDocument();
  });

  it("can be cancelled", async () => {
    mockFetch({ "GET /admin/alerts": () => view() });
    renderWithProviders(<AlertsPage />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Set up email" }),
    );
    await userEvent.click(
      screen.getAllByRole("button", { name: "Cancel" })[0] as HTMLElement,
    );
    expect(screen.queryByLabelText("Server address")).toBeNull();
  });
});

describe("email channels", () => {
  it("need the mail server first", async () => {
    mockFetch({ "GET /admin/alerts": () => view() });
    renderWithProviders(<AlertsPage />);
    await userEvent.click(
      (
        await screen.findAllByRole("button", { name: "Add a channel" })
      )[0] as HTMLElement,
    );
    const dialog = screen.getByRole("dialog", { name: "Add a channel" });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Email" }),
    );
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Set up the mail server on this page first",
    );
    expect(
      within(dialog).getByRole("button", { name: "Add channel" }),
    ).toBeDisabled();
  });

  it("are added with their addresses, shown, and edited", async () => {
    const email = channel({
      id: "ch_9",
      name: "Finance email",
      kind: "email",
      to: ["cfo@example.com", "ops@example.com"],
      urlHint: "",
    });
    const { calls } = mockFetch({
      "GET /admin/alerts": () =>
        view({ smtp: SMTP, channels: [email], recent: [] }),
      "POST /admin/alerts/channels": () => ({
        status: 201,
        body: { channel: email },
      }),
      "PATCH /admin/alerts/channels/ch_9": () => ({ channel: email }),
    });
    renderWithProviders(<AlertsPage />);
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent(
      "Email · cfo@example.com, ops@example.com",
    );

    await userEvent.click(
      screen.getAllByRole("button", {
        name: "Add a channel",
      })[0] as HTMLElement,
    );
    const dialog = screen.getByRole("dialog", { name: "Add a channel" });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Email" }),
    );
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await userEvent.type(
      within(dialog).getByLabelText("Name"),
      "Finance email",
    );
    const submit = () =>
      userEvent.click(
        within(dialog).getByRole("button", { name: "Add channel" }),
      );
    await submit();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Add at least one email address.",
    );
    await userEvent.type(
      within(dialog).getByLabelText("Send to"),
      "cfo@example.com, nope",
    );
    await submit();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "nope is not an email address.",
    );
    await userEvent.clear(within(dialog).getByLabelText("Send to"));
    await userEvent.type(
      within(dialog).getByLabelText("Send to"),
      Array.from({ length: 21 }, (_, i) => `p${i}@example.com`).join(","),
    );
    await submit();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Up to 20 addresses.",
    );
    await userEvent.clear(within(dialog).getByLabelText("Send to"));
    await userEvent.type(
      within(dialog).getByLabelText("Send to"),
      "cfo@example.com; ops@example.com",
    );
    await submit();
    expect(await screen.findByText(/Added Finance email/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      name: "Finance email",
      kind: "email",
      to: ["cfo@example.com", "ops@example.com"],
      events: [],
    });

    await userEvent.click(
      screen.getByRole("button", { name: "Edit Finance email" }),
    );
    const edit = screen.getByRole("dialog", { name: "Edit Finance email" });
    expect(within(edit).getByLabelText("Send to")).toHaveValue(
      "cfo@example.com, ops@example.com",
    );
    await userEvent.type(
      within(edit).getByLabelText("Send to"),
      ", new@example.com",
    );
    await userEvent.click(within(edit).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
        name: "Finance email",
        events: [],
        to: ["cfo@example.com", "ops@example.com", "new@example.com"],
      }),
    );
  });

  it("splits addresses on commas, semicolons and spaces", () => {
    expect(splitAddresses(" a@x.com,b@y.com ;  c@z.com\nd@w.com,, ")).toEqual([
      "a@x.com",
      "b@y.com",
      "c@z.com",
      "d@w.com",
    ]);
  });
});
