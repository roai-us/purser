import { randomBytes } from "node:crypto";
import { safeEqual } from "./keys.js";

export const SESSION_COOKIE = "purser_session";
/** How long a browser session lasts. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** How long a one-time login link works. */
export const LOGIN_CODE_TTL_MS = 15 * 60 * 1000;
/** Token logins allowed per minute, across the whole server. */
export const LOGIN_ATTEMPTS_PER_MINUTE = 10;

const token = () => randomBytes(32).toString("base64url");

interface Session {
  expires: number;
  /** The person signed in, for company sign-in. Absent: the owner, by link or admin token. */
  personId?: string | undefined;
}

/**
 * Browser sessions for the web UI. The owner signs in with the one-time link
 * `roai serve` prints and opens, or by pasting the admin token. Everyone else
 * signs in with their company account. Sessions live in memory: restarting
 * Purser signs everyone out.
 */
export class Sessions {
  private readonly sessions = new Map<string, Session>();
  private readonly codes = new Map<string, number>();
  private attempts: number[] = [];

  constructor(private readonly now: () => Date) {}

  /** A login code that works once, for 15 minutes. */
  issueLoginCode(): string {
    const code = token();
    this.codes.set(code, this.now().getTime() + LOGIN_CODE_TTL_MS);
    return code;
  }

  /** Spends a login code. Returns a new session id, or null if the code is unknown, used or stale. */
  redeemLoginCode(code: string): string | null {
    const expires = this.codes.get(code);
    if (expires === undefined) return null;
    this.codes.delete(code);
    if (expires <= this.now().getTime()) return null;
    return this.create();
  }

  /**
   * Signs in with the admin token. Returns a session id, "invalid", or
   * "rate_limited" after too many attempts in a minute.
   */
  loginWithToken(
    candidate: string,
    adminToken: string,
  ): string | "invalid" | "rate_limited" {
    const now = this.now().getTime();
    this.attempts = this.attempts.filter((t) => t > now - 60_000);
    if (this.attempts.length >= LOGIN_ATTEMPTS_PER_MINUTE)
      return "rate_limited";
    this.attempts.push(now);
    return safeEqual(candidate, adminToken) ? this.create() : "invalid";
  }

  isValid(id: string | undefined): boolean {
    return this.get(id) !== null;
  }

  /** The live session, or null. A person's session says who they are. */
  get(id: string | undefined): Session | null {
    if (!id) return null;
    const session = this.sessions.get(id);
    if (session === undefined) return null;
    if (session.expires <= this.now().getTime()) {
      this.sessions.delete(id);
      return null;
    }
    return session;
  }

  /** Starts a session for a person who signed in with their company account. */
  signIn(personId: string): string {
    return this.create(personId);
  }

  /** Signs a person out everywhere, as when they leave the company. Returns how many sessions ended. */
  endAllFor(personId: string): number {
    let ended = 0;
    for (const [id, session] of this.sessions) {
      if (session.personId === personId) {
        this.sessions.delete(id);
        ended++;
      }
    }
    return ended;
  }

  end(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }

  private create(personId?: string): string {
    const id = token();
    this.sessions.set(id, {
      expires: this.now().getTime() + SESSION_TTL_MS,
      personId,
    });
    return id;
  }
}
