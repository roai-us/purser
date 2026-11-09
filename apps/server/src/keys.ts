import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Agent keys start with this prefix so secret scanners and people can recognise them. */
export const AGENT_KEY_PREFIX = "purser_";

/** A new agent key: the prefix plus 256 random bits. Shown once, never stored. */
export function generateAgentKey(): string {
  return AGENT_KEY_PREFIX + randomBytes(32).toString("base64url");
}

/**
 * Keys are 256-bit random values, so a plain SHA-256 is enough to store them
 * safely; a slow password hash would only add latency to every request.
 */
export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** "purser_ab...wxyz": enough to recognise a key, useless to an attacker. */
export function keyHint(key: string): string {
  const body = key.slice(AGENT_KEY_PREFIX.length);
  return `${AGENT_KEY_PREFIX}${body.slice(0, 2)}...${key.slice(-4)}`;
}

/** Constant-time string comparison for the admin token. */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

/** "sk-o...wxyz" for a provider key: enough to recognise it. Short keys show only their end. */
export function secretHint(key: string): string {
  return key.length >= 16
    ? `${key.slice(0, 4)}...${key.slice(-4)}`
    : `...${key.slice(-2)}`;
}
