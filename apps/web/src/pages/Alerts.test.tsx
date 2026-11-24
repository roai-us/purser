import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AlertChannel, AlertsView } from "../api/types";
import { mockFetch, renderWithProviders } from "../test/helpers";
import { AlertsPage, pathOf } from "./Alerts";

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
