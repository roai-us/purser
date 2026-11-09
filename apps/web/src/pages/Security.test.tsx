import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RotateAllResult, SecurityView } from "../api/types";
import { mockFetch, renderWithProviders } from "../test/helpers";
import { keysCsv, SecurityPage } from "./Security";

afterEach(() => vi.unstubAllGlobals());

const view = (extra: Partial<SecurityView> = {}): SecurityView => ({
  confirm: "ROTATE ALL KEYS",
  peopleCanSignIn: true,
  agents: { total: 12, ownerCollects: 10, adminGets: 2, waiting: 0 },
  departments: ["Eng", "Sales"],
  providers: [{ id: "openai", name: "OpenAI" }],
  history: [],
  ...extra,
});

const done = (extra: Partial<RotateAllResult> = {}): RotateAllResult => ({
  rotated: 12,
  waitingForOwners: 10,
  keys: [
    { id: "a", name: "shared", owner: "Ops", team: "Eng", key: "purser_new_a" },
    { id: "b", name: "other", owner: "=SUM(A1)", key: "purser_new_b" },
  ],
  abortedRequests: 3,
  elapsedMs: 5,
  ...extra,
});

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("button", { name: "Rotate all keys" }),
  );
  return screen.findByRole("dialog");
}

describe("the security page", () => {
  it("says what would happen", async () => {
    mockFetch({ "GET /admin/security": () => view() });
    renderWithProviders(<SecurityPage />);
    expect(await screen.findByText("Owners collect their own")).toBeTruthy();
    expect(screen.getByText("You download these")).toBeTruthy();
    expect(screen.queryByText(/Company sign-in is off/)).toBeNull();
  });

  it("warns when owners have no way to collect", async () => {
    mockFetch({
      "GET /admin/security": () => view({ peopleCanSignIn: false }),
    });
    renderWithProviders(<SecurityPage />);
    expect(await screen.findByText(/Company sign-in is off/)).toBeTruthy();
  });

  it("shows keys still to collect, and past rotations", async () => {
    mockFetch({
      "GET /admin/security": () =>
        view({
          agents: { total: 12, ownerCollects: 10, adminGets: 2, waiting: 1 },
          history: [
            {
              at: "2026-11-07T12:00:00.000Z",
              by: "ada@example.com",
              reason: "Leak",
              rotated: 5,
              department: "Eng",
            },
            { at: "2026-11-06T12:00:00.000Z", reason: "Drill" },
          ],
        }),
    });
    renderWithProviders(<SecurityPage />);
    const link = await screen.findByRole("link", { name: "See which" });
    expect(link.getAttribute("href")).toBe("/agents?awaiting=1");
    expect(screen.getByText(/1 agent's owner hasn't/)).toBeTruthy();
    expect(screen.getByText("Leak")).toBeTruthy();
    expect(screen.getByText("5 in Eng")).toBeTruthy();
  });

  it("won't rotate until the phrase and a reason are given", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({ "GET /admin/security": () => view() });
    renderWithProviders(<SecurityPage />);
    await openDialog(user);
    const go = screen.getByRole("button", { name: "Rotate the keys" });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText(/Why/), "Leak");
    await user.type(screen.getByLabelText(/to go ahead/), "rotate all keys");
    expect((go as HTMLButtonElement).disabled).toBe(true);
    await user.click(go);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("rotates, then walks through what's left to do", async () => {
    const user = userEvent.setup();
    const create = vi.fn(() => "blob:keys");
    const revoke = vi.fn();
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }),
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const { calls } = mockFetch({
      "GET /admin/security": () => view(),
      "POST /admin/security/rotate-all": () => done(),
    });
    renderWithProviders(<SecurityPage />);
    await openDialog(user);
    expect(screen.getByText(/cuts any requests running/)).toBeTruthy();
    await user.click(screen.getByLabelText(/After 1 hour/));
    expect(screen.queryByText(/cuts any requests running/)).toBeNull();
    await user.click(screen.getByLabelText(/Right away/));
    await user.type(screen.getByLabelText(/Why/), "Key in a public repo");
    await user.type(screen.getByLabelText(/to go ahead/), "ROTATE ALL KEYS");
    await user.click(screen.getByRole("button", { name: "Rotate the keys" }));

    expect(await screen.findByText("12 keys replaced")).toBeTruthy();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({
      confirm: "ROTATE ALL KEYS",
      reason: "Key in a public repo",
      graceMinutes: 0,
    });
    expect(screen.getByText(/old keys have stopped working/)).toBeTruthy();
    expect(screen.getByText(/3 running requests were cut/)).toBeTruthy();
    expect(screen.getByText(/10 new keys are waiting/)).toBeTruthy();
    expect(screen.getByText(/Replace them under/).textContent).toContain(
      "OpenAI",
    );

    // Done stays off until the keys are saved: they can't be read again.
    const finish = screen.getByRole("button", { name: "Done" });
    expect((finish as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Download new keys" }));
    expect(click).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("blob:keys");
    expect((finish as HTMLButtonElement).disabled).toBe(false);
    await user.click(finish);
    expect(
      await screen.findByRole("button", { name: "Rotate all keys" }),
    ).toBeTruthy();
    click.mockRestore();
  });

  it("can save the keys by copying instead", async () => {
    const user = userEvent.setup();
    mockFetch({
      "GET /admin/security": () => view(),
      "POST /admin/security/rotate-all": () => done(),
    });
    renderWithProviders(<SecurityPage />);
    await openDialog(user);
    await user.type(screen.getByLabelText(/Why/), "Leak");
    await user.type(screen.getByLabelText(/to go ahead/), "ROTATE ALL KEYS");
    await user.click(screen.getByRole("button", { name: "Rotate the keys" }));
    const write = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: write },
      configurable: true,
    });
    await user.click(
      await screen.findByRole("button", { name: "Copy instead" }),
    );
    expect(write).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Done" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });

  it("talks about one key as one key", async () => {
    const user = userEvent.setup();
    mockFetch({
      "GET /admin/security": () => view(),
      "POST /admin/security/rotate-all": () =>
        done({
          rotated: 1,
          waitingForOwners: 1,
          abortedRequests: 1,
          keys: [{ id: "a", name: "only", owner: "Ops", key: "purser_new_a" }],
        }),
    });
    renderWithProviders(<SecurityPage />);
    await openDialog(user);
    await user.type(screen.getByLabelText(/Why/), "Leak");
    await user.type(screen.getByLabelText(/to go ahead/), "ROTATE ALL KEYS");
    await user.click(screen.getByRole("button", { name: "Rotate the keys" }));
    expect(await screen.findByText("1 key replaced")).toBeTruthy();
    expect(screen.getByText(/old key has stopped working/)).toBeTruthy();
    expect(screen.getByText(/1 running request was cut/)).toBeTruthy();
    expect(
      screen.getByText(/Save the 1 new key that has no owner/),
    ).toBeTruthy();
    expect(
      screen.getByText(/This is the only time it can be read/),
    ).toBeTruthy();
    expect(screen.getByText(/1 new key is waiting for its owner/)).toBeTruthy();
    expect(screen.getByText("Save the new key first.")).toBeTruthy();
  });

  it("covers one department, and an overlap", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "GET /admin/security": (c) =>
        c.url.includes("department")
          ? view({
              agents: { total: 4, ownerCollects: 3, adminGets: 1, waiting: 0 },
            })
          : view(),
      "POST /admin/security/rotate-all": () =>
        done({
          keys: [],
          abortedRequests: 0,
          waitingForOwners: 0,
          oldKeysUntil: "2026-11-07T13:00:00.000Z",
        }),
    });
    renderWithProviders(<SecurityPage />);
    await openDialog(user);
    await user.selectOptions(screen.getByLabelText("Which agents"), "Eng");
    expect(await screen.findByText(/This replaces 4 keys/)).toBeTruthy();
    await user.click(screen.getByLabelText(/After 24 hours/));
    await user.type(screen.getByLabelText(/Why/), "Planned");
    await user.type(screen.getByLabelText(/to go ahead/), "ROTATE ALL KEYS");
    await user.click(screen.getByRole("button", { name: "Rotate the keys" }));
    expect(await screen.findByText(/old keys work until/)).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
      department: "Eng",
      graceMinutes: 1440,
    });
    // Nothing to save, so nothing holds Done back.
    expect(
      (screen.getByRole("button", { name: "Done" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("reports errors", async () => {
    mockFetch({});
    renderWithProviders(<SecurityPage />);
    expect(await screen.findByText(/No mock for/)).toBeTruthy();
  });
});

describe("the keys file", () => {
  it("is a quoted spreadsheet where nothing runs as a formula", () => {
    const csv = keysCsv(done().keys);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe('"agent","owner","department","new key"');
    expect(lines[1]).toBe('"shared","Ops","Eng","purser_new_a"');
    expect(lines[2]).toBe('"other","\'=SUM(A1)","","purser_new_b"');
    expect(keysCsv([{ id: "x", name: 'a"b', owner: "o", key: "k" }])).toContain(
      '"a""b"',
    );
  });
});
