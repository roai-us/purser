import { createTransport } from "nodemailer";

/**
 * How Purser talks to the mail server: "tls" connects with TLS from the start
 * (usually port 465), "starttls" upgrades a plain connection and refuses to go
 * on without it (usually port 587), "none" sends in the clear.
 */
export type SmtpSecurity = "tls" | "starttls" | "none";
export const SMTP_SECURITY = ["tls", "starttls", "none"] as const;

/** The mail server alerts go out through. The password is kept in the vault. */
export interface SmtpSettings {
  host: string;
  port: number;
  security: SmtpSecurity;
  /** Empty when the server takes mail without signing in, such as a local relay. */
  username: string;
  /** The address alerts come from. */
  from: string;
}

export interface MailMessage {
  to: string[];
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}

/** Sends one message, or throws a MailError. Tests pass their own. */
export type SendMail = (
  smtp: SmtpSettings & { password?: string | undefined },
  message: MailMessage,
) => Promise<void>;

/** A failed send, in words an admin can act on. Permanent ones are not retried. */
export class MailError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = "MailError";
  }
}

const isLocal = (host: string) => {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
};

/** Why these settings can't be used, or null. */
export function smtpProblem(
  smtp: SmtpSettings,
  hasPassword: boolean,
): string | null {
  if (!/^[a-z0-9.\-[\]:]+$/i.test(smtp.host)) {
    return "That is not a mail server address.";
  }
  // A password sent in the clear can be read by anyone on the way.
  if (smtp.security === "none" && hasPassword && !isLocal(smtp.host)) {
    return "Use TLS or STARTTLS to send a password to a mail server on another computer.";
  }
  return null;
}

interface NodemailerError {
  code?: string;
  responseCode?: number;
  message?: string;
}

/** Turns what nodemailer threw into a MailError. */
export function mailError(err: unknown): MailError {
  if (err instanceof MailError) return err;
  const e = (err ?? {}) as NodemailerError;
  const status = typeof e.responseCode === "number" ? e.responseCode : 0;
  if (e.code === "EAUTH") {
    return new MailError(
      "The mail server did not accept the username or password.",
      true,
    );
  }
  if (status >= 500) {
    return new MailError(
      `The mail server refused the message (${status}).`,
      true,
    );
  }
  if (status >= 400) {
    return new MailError(
      `The mail server said to try later (${status}).`,
      false,
    );
  }
  if (
    e.code === "ETLS" ||
    /certificate|self.signed|TLS/i.test(e.message ?? "")
  ) {
    return new MailError(
      "Could not set up a secure connection to the mail server.",
      true,
    );
  }
  if (e.code === "ETIMEDOUT" || /timeout/i.test(e.message ?? "")) {
    return new MailError("No answer from the mail server.", false);
  }
  return new MailError("Could not reach the mail server.", false);
}

/** Sends through the configured server with nodemailer, one connection per message. */
export const sendMail: SendMail = async (smtp, message) => {
  const transport = createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.security === "tls",
    requireTLS: smtp.security === "starttls",
    ignoreTLS: smtp.security === "none",
    ...(smtp.username
      ? { auth: { user: smtp.username, pass: smtp.password ?? "" } }
      : {}),
    tls: { minVersion: "TLSv1.2" },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  try {
    await transport.sendMail({
      from: { name: "ROAI Purser", address: smtp.from },
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: message.headers,
    });
  } catch (err) {
    throw mailError(err);
  } finally {
    transport.close();
  }
};
