import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMTPServer } from "smtp-server";
import { afterEach, describe, expect, it } from "vitest";
import {
  Alerts,
  formatEmail,
  SMTP_SECRET,
  type Alert,
  type PublicChannel,
  type PublicSmtp,
} from "./alerts.js";
import { MailError, mailError, sendMail, smtpProblem } from "./mail.js";
import { Store } from "./store.js";
import { harness, type Harness } from "./test/helpers.js";
import { Vault } from "./vault.js";

const SMTP = {
  host: "smtp.example.com",
  port: 587,
  security: "starttls",
  username: "alerts@example.com",
  password: "MAILPASSWORD",
  from: "purser@example.com",
};

async function setSmtp(h: Harness, body: Record<string, unknown> = SMTP) {
  return h.admin("PUT", "/alerts/smtp", body);
}

async function addEmail(h: Harness, to = ["ops@example.com"]) {
  const res = await h.admin("POST", "/alerts/channels", {
    name: "ops email",
    kind: "email",
    to,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { channel: PublicChannel }).channel;
}

describe("the mail server in the admin API", () => {
  it("is saved without ever showing its password", async () => {
    const h = harness();
    const before = (await (await h.admin("GET", "/alerts")).json()) as {
      smtp: PublicSmtp | null;
    };
    expect(before.smtp).toBeNull();

    const res = await setSmtp(h);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { smtp: PublicSmtp };
    expect(body.smtp).toEqual({
      host: "smtp.example.com",
      port: 587,
      security: "starttls",
      username: "alerts@example.com",
      from: "purser@example.com",
      passwordSet: true,
    });
    const listed = await (await h.admin("GET", "/alerts")).text();
    expect(listed).not.toContain("MAILPASSWORD");
    expect(listed).toContain('"passwordSet":true');
    expect(h.vault.get(SMTP_SECRET)?.apiKey).toBe("MAILPASSWORD");

    // Leaving the password out keeps it; an empty one forgets it.
    await setSmtp(h, {
      ...SMTP,
      password: undefined,
      port: 465,
      security: "tls",
    });
    expect(h.vault.get(SMTP_SECRET)?.apiKey).toBe("MAILPASSWORD");
    expect(h.alerts.smtp()).toMatchObject({ port: 465, security: "tls" });
    await setSmtp(h, { ...SMTP, password: "" });
    expect(h.alerts.smtp()?.passwordSet).toBe(false);

    const audit = JSON.stringify(h.store.listAudit());
    expect(audit).toContain("mail server set");
    expect(audit).not.toContain("MAILPASSWORD");

    expect((await h.admin("DELETE", "/alerts/smtp")).status).toBe(200);
    expect(h.alerts.smtp()).toBeNull();
  });

  it("refuses to send a password in the clear to another computer", async () => {
    const h = harness();
    const clear = await setSmtp(h, { ...SMTP, security: "none" });
    expect(clear.status).toBe(400);
    expect(await clear.text()).toContain("Use TLS or STARTTLS");

    // A relay on this computer, or one that needs no password, is fine.
    expect(
      (await setSmtp(h, { ...SMTP, host: "127.0.0.1", security: "none" }))
        .status,
    ).toBe(200);
    expect(
      (
        await setSmtp(h, {
          ...SMTP,
          host: "relay.internal",
          security: "none",
          username: "",
          password: "",
        })
      ).status,
    ).toBe(200);
    // The saved password counts too, when the change leaves it out.
    await setSmtp(h, SMTP);
    const kept = await setSmtp(h, {
      ...SMTP,
      password: undefined,
      security: "none",
    });
    expect(kept.status).toBe(400);
  });

  it("refuses bad settings", async () => {
    const h = harness();
    for (const bad of [
      { ...SMTP, host: "smtp.example.com\r\nRCPT TO:x" },
      { ...SMTP, host: "" },
      { ...SMTP, port: 0 },
      { ...SMTP, port: 70000 },
      { ...SMTP, security: "ssl" },
      { ...SMTP, from: "not an address" },
      { ...SMTP, extra: true },
    ]) {
      expect((await setSmtp(h, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(h.alerts.smtp()).toBeNull();
  });
});

describe("email channels", () => {
  it("need the mail server first, and keep their addresses out of the vault", async () => {
    const h = harness();
    const early = await h.admin("POST", "/alerts/channels", {
      name: "ops",
      kind: "email",
      to: ["ops@example.com"],
    });
    expect(early.status).toBe(400);
    expect(await early.text()).toContain("Set up the mail server");

    await setSmtp(h);
    const channel = await addEmail(h, ["ops@example.com", "cfo@example.com"]);
    expect(channel).toMatchObject({
      kind: "email",
      to: ["ops@example.com", "cfo@example.com"],
      signed: false,
      urlHint: "",
    });
    expect(h.vault.get(`__alert_${channel.id}`)).toBeUndefined();
  });

  it("refuses bad addresses and mixed-up fields", async () => {
    const h = harness();
    await setSmtp(h);
    for (const to of [
      [],
      ["nope"],
      ["a@example.com\r\nBcc: x@evil.test"],
      Array.from({ length: 21 }, (_, i) => `p${i}@example.com`),
    ]) {
      const res = await h.admin("POST", "/alerts/channels", {
        name: "ops",
        kind: "email",
        to,
      });
      expect(res.status, JSON.stringify(to)).toBe(400);
    }
    const withUrl = await h.admin("POST", "/alerts/channels", {
      name: "ops",
      kind: "email",
      to: ["ops@example.com"],
      url: "https://hooks.test/x",
    });
    expect(withUrl.status).toBe(400);

    const email = await addEmail(h);
    expect(
      (
        await h.admin("PATCH", `/alerts/channels/${email.id}`, {
          url: "https://hooks.test/x/yyyyyy",
        })
      ).status,
    ).toBe(400);
    const changed = await h.admin("PATCH", `/alerts/channels/${email.id}`, {
      to: ["new@example.com"],
    });
    expect(changed.status).toBe(200);
    expect(h.alerts.getChannel(email.id)?.to).toEqual(["new@example.com"]);

    const slack = await h.admin("POST", "/alerts/channels", {
      name: "s",
      kind: "slack",
      url: "https://hooks.test/s/T/1",
    });
    const { channel } = (await slack.json()) as { channel: PublicChannel };
    expect(
      (
        await h.admin("PATCH", `/alerts/channels/${channel.id}`, {
          to: ["a@example.com"],
        })
      ).status,
    ).toBe(400);
  });

  it("sends alerts as email through the saved server", async () => {
    const h = harness();
    await setSmtp(h);
    await addEmail(h);
    await h.admin("POST", `/agents/${h.addAgent("support-bot").id}/kill`);
    await h.alerts.flush();

    expect(h.mail.sent).toHaveLength(1);
    const { smtp, message } = h.mail.sent[0] ?? {};
    expect(smtp).toMatchObject({
      host: "smtp.example.com",
      port: 587,
      security: "starttls",
      username: "alerts@example.com",
      password: "MAILPASSWORD",
      from: "purser@example.com",
    });
    expect(message?.to).toEqual(["ops@example.com"]);
    expect(message?.subject).toBe("[Purser] support-bot was stopped");
    expect(message?.text).toContain("stopped support-bot");
    expect(message?.text).toContain(
      "Open in Purser: http://127.0.0.1:4141/agents?agent=",
    );
    expect(message?.headers).toMatchObject({
      "X-Purser-Event": "agent.stopped",
      "Auto-Submitted": "auto-generated",
    });
    expect(h.alerts.recent(1)[0]?.deliveries[0]).toMatchObject({
      channelName: "ops email",
      ok: true,
      attempts: 1,
    });
  });

  it("retries a busy server, not a refusal, and records failures", async () => {
    const h = harness();
    await setSmtp(h);
    await addEmail(h);
    h.mail.replies.push(
      new MailError("The mail server said to try later (421).", false),
      new MailError("No answer from the mail server.", false),
    );
    await h.admin("POST", `/agents/${h.addAgent("a-bot").id}/kill`);
    await h.alerts.flush();
    expect(h.mail.sent).toHaveLength(3);
    expect(h.alerts.recent(1)[0]?.deliveries[0]).toMatchObject({
      ok: true,
      attempts: 3,
    });

    h.mail.replies.push(
      new MailError(
        "The mail server did not accept the username or password.",
        true,
      ),
    );
    await h.admin("POST", `/agents/${h.addAgent("b-bot").id}/kill`);
    await h.alerts.flush();
    expect(h.mail.sent).toHaveLength(4);
    expect(h.alerts.recent(1)[0]?.deliveries[0]).toMatchObject({
      ok: false,
      attempts: 1,
      error: "The mail server did not accept the username or password.",
    });
    expect(h.store.listAudit().at(-1)).toMatchObject({
      type: "alert.failed",
      detail: { channel: "ops email", alert: "agent.stopped" },
    });

    // Something that isn't a MailError is retried and reported plainly.
    const boom = new Error("boom") as MailError;
    h.mail.replies.push(boom, boom, boom);
    await h.admin("POST", `/agents/${h.addAgent("c-bot").id}/kill`);
    await h.alerts.flush();
    expect(h.alerts.recent(1)[0]?.deliveries[0]?.error).toBe(
      "Could not reach the mail server.",
    );
  });

  it("sends a test email, and says so when the server is gone", async () => {
    const h = harness();
    await setSmtp(h);
    const channel = await addEmail(h);
    const ok = (await (
      await h.admin("POST", `/alerts/channels/${channel.id}/test`)
    ).json()) as { delivery: { ok: boolean } };
    expect(ok.delivery.ok).toBe(true);
    expect(h.mail.sent[0]?.message.subject).toBe(
      "[Purser] A test from ROAI Purser",
    );

    await h.admin("DELETE", "/alerts/smtp");
    const gone = (await (
      await h.admin("POST", `/alerts/channels/${channel.id}/test`)
    ).json()) as { delivery: { ok: boolean; error: string } };
    expect(gone.delivery).toMatchObject({
      ok: false,
      error: "Set up the mail server first.",
    });
  });
});

describe("formatEmail", () => {
  const alert: Alert = {
    id: "alr_1",
    type: "agent.at_limit",
    severity: "warning",
    at: "2026-11-07T12:00:00.000Z",
    title: 'bad\r\nBcc: x@evil.test <script>"',
    text: "Owner <b>&",
    url: 'http://p/agents?agent=a"b',
    count: 1,
    data: {},
  };

  it("keeps people's names out of the headers and the HTML", () => {
    const mail = formatEmail(alert, ["ops@example.com"]);
    expect(mail.subject).toBe('[Purser] bad Bcc: x@evil.test <script>"');
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.html).toContain("bad\r\nBcc: x@evil.test &lt;script&gt;&quot;");
    expect(mail.html).toContain("Owner &lt;b&gt;&amp;");
    expect(mail.html).toContain('href="http://p/agents?agent=a&quot;b"');
    expect(mail.html).not.toContain("<script>");
    expect(mail.text).toContain("Owner <b>&");
  });

  it("shortens a long subject", () => {
    const mail = formatEmail({ ...alert, title: "x".repeat(400) }, []);
    expect(mail.subject.length).toBeLessThanOrEqual(189);
    expect(mail.subject.endsWith("...")).toBe(true);
  });
});

describe("mail errors and settings checks", () => {
  it("turns nodemailer's errors into words, and says which to retry", () => {
    const cases: [unknown, string, boolean][] = [
      [
        { code: "EAUTH", responseCode: 535 },
        "did not accept the username",
        true,
      ],
      [{ responseCode: 550 }, "refused the message (550)", true],
      [{ responseCode: 421 }, "try later (421)", false],
      [{ code: "ETLS" }, "secure connection", true],
      [{ message: "self-signed certificate" }, "secure connection", true],
      [{ code: "ETIMEDOUT" }, "No answer", false],
      [{ code: "ECONNREFUSED" }, "Could not reach", false],
      [undefined, "Could not reach", false],
    ];
    for (const [err, words, permanent] of cases) {
      const e = mailError(err);
      expect(e.message, JSON.stringify(err)).toContain(words);
      expect(e.permanent, JSON.stringify(err)).toBe(permanent);
    }
    const same = new MailError("x", true);
    expect(mailError(same)).toBe(same);
  });

  it("checks the host and clear-text passwords", () => {
    const base = {
      host: "smtp.example.com",
      port: 25,
      security: "none" as const,
      username: "",
      from: "a@example.com",
    };
    expect(smtpProblem(base, false)).toBeNull();
    expect(smtpProblem(base, true)).toContain("Use TLS");
    expect(smtpProblem({ ...base, host: "localhost" }, true)).toBeNull();
    expect(smtpProblem({ ...base, host: "[::1]" }, true)).toBeNull();
    expect(smtpProblem({ ...base, host: "a b" }, false)).toContain(
      "not a mail server",
    );
  });
});

describe("the mail server on disk", () => {
  it("keeps the settings in alerts.json and the password only in the vault", () => {
    const dir = mkdtempSync(join(tmpdir(), "purser-mail-"));
    const make = () =>
      new Alerts(
        {
          store: new Store(),
          vault: new Vault(dir),
          fetch: () => Promise.resolve(new Response("ok")),
          now: () => new Date("2026-11-07T12:00:00Z"),
          baseUrl: "http://p",
        },
        dir,
      );
    make().setSmtp(SMTP as Parameters<Alerts["setSmtp"]>[0]);
    expect(readFileSync(join(dir, "alerts.json"), "utf8")).not.toContain(
      "MAILPASSWORD",
    );
    expect(make().smtp()).toMatchObject({
      host: "smtp.example.com",
      passwordSet: true,
    });
    const again = make();
    again.removeSmtp();
    expect(readFileSync(join(dir, "alerts.json"), "utf8")).not.toContain(
      "smtp.example.com",
    );
    expect(make().smtp()).toBeNull();
  });
});

describe("sendMail against a real SMTP server", () => {
  let server: SMTPServer | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  const received: {
    from?: string | undefined;
    to: string[];
    raw: string;
    user?: string | undefined;
  }[] = [];

  async function start(options: {
    refuseRecipient?: boolean;
    refuseLogin?: boolean;
  }): Promise<number> {
    received.length = 0;
    server = new SMTPServer({
      // A local test relay: no TLS, so a password may cross only to this computer.
      disabledCommands: ["STARTTLS"],
      allowInsecureAuth: true,
      authOptional: true,
      logger: false,
      onAuth(auth, _session, cb) {
        if (options.refuseLogin || auth.password !== "pw") {
          const err = Object.assign(new Error("Invalid login"), {
            responseCode: 535,
          });
          cb(err);
          return;
        }
        cb(null, { user: auth.username });
      },
      onRcptTo(_address, _session, cb) {
        if (options.refuseRecipient) {
          cb(Object.assign(new Error("No such user"), { responseCode: 550 }));
          return;
        }
        cb();
      },
      onData(stream, session, cb) {
        let raw = "";
        stream.on("data", (d: Buffer) => (raw += d.toString("utf8")));
        stream.on("end", () => {
          received.push({
            from: session.envelope.mailFrom
              ? session.envelope.mailFrom.address
              : undefined,
            to: session.envelope.rcptTo.map((r) => r.address),
            raw,
            user: typeof session.user === "string" ? session.user : undefined,
          });
          cb();
        });
      },
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", () => r()));
    return (server.server.address() as AddressInfo).port;
  }

  const message = formatEmail(
    {
      id: "alr_1",
      type: "workflow.stop",
      severity: "critical",
      at: "2026-11-07T12:00:00.000Z",
      title: "Invoice triage crossed its stop line",
      text: "By the rule written down before any result, it should stop.",
      url: "http://127.0.0.1:4141/workflows/invoice-triage/report",
      count: 1,
      data: {},
    },
    ["ops@example.com", "cfo@example.com"],
  );

  it("delivers a message with its headers, signing in when asked", async () => {
    const port = await start({});
    await sendMail(
      {
        host: "127.0.0.1",
        port,
        security: "none",
        username: "alerts",
        password: "pw",
        from: "purser@example.com",
      },
      message,
    );
    expect(received).toHaveLength(1);
    const got = received[0];
    expect(got?.from).toBe("purser@example.com");
    expect(got?.to).toEqual(["ops@example.com", "cfo@example.com"]);
    expect(got?.user).toBe("alerts");
    expect(got?.raw).toContain(
      "Subject: [Purser] Invoice triage crossed its stop line",
    );
    expect(got?.raw).toContain("From: ROAI Purser <purser@example.com>");
    expect(got?.raw).toContain("X-Purser-Event: workflow.stop");
    expect(got?.raw).toContain("Auto-Submitted: auto-generated");
  });

  it("reports a refused login and a refused address as permanent", async () => {
    const smtp = (port: number) => ({
      host: "127.0.0.1",
      port,
      security: "none" as const,
      username: "alerts",
      password: "wrong",
      from: "purser@example.com",
    });
    let port = await start({ refuseLogin: true });
    await expect(sendMail(smtp(port), message)).rejects.toMatchObject({
      message: "The mail server did not accept the username or password.",
      permanent: true,
    });
    await new Promise<void>((r) => server?.close(() => r()));

    port = await start({ refuseRecipient: true });
    await expect(
      sendMail({ ...smtp(port), username: "" }, message),
    ).rejects.toMatchObject({ permanent: true });
    expect(received).toHaveLength(0);
  });

  it("says when nothing is listening", async () => {
    const port = await start({});
    await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
    await expect(
      sendMail(
        {
          host: "127.0.0.1",
          port,
          security: "none",
          username: "",
          from: "purser@example.com",
        },
        message,
      ),
    ).rejects.toMatchObject({
      message: "Could not reach the mail server.",
      permanent: false,
    });
  });
});
