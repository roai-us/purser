import type { AgentState, KeyState, RotationPolicy } from "../api/types";

const usd = (digits: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
const usd2 = usd(2);
const usd4 = usd(4);

/** Dollars. Amounts under a cent keep four decimals so they don't read $0.00. */
export function formatUsd(amount: number): string {
  if (amount !== 0 && Math.abs(amount) < 0.01) return usd4.format(amount);
  return usd2.format(amount);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

/** Date and time in the viewer's locale. */
export function formatDateTime(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatDate(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  // A bare day such as 2026-11-07 is a UTC date. Show it as that day.
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  return date.toLocaleDateString(undefined, {
    dateStyle: "medium",
    ...(dayOnly ? { timeZone: "UTC" } : {}),
  });
}

/** "3 minutes ago", "in 2 hours". */
export function formatRelative(
  iso: string | undefined,
  now: number = Date.now(),
): string {
  if (!iso) return "Never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "Never";
  const seconds = Math.round((then - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, "second");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  return rtf.format(Math.round(seconds / 86400), "day");
}

export const STATE_LABELS: Record<AgentState, string> = {
  running: "Running",
  paused: "Stopped",
  at_limit: "At limit",
  expired: "Ended",
  key_expired: "Key expired",
};

/** Why an agent can't run, in a sentence fragment: "hr-helper is stopped". */
export const STATE_REASONS: Record<AgentState, string> = {
  running: "running",
  paused: "stopped",
  at_limit: "at its spending limit; raise it once to turn it back on",
  expired: "past its end date",
  key_expired: "waiting for a new key",
};

export const KEY_STATE_LABELS: Record<KeyState, string> = {
  ok: "Current",
  expiring: "Expiring soon",
  expired: "Expired",
};

export const ROTATION_OPTIONS = [0, 30, 60, 90, 180, 365] as const;

export function rotationLabel(policy: RotationPolicy | undefined): string {
  if (!policy) return "Not scheduled";
  const grace =
    policy.graceDays > 0
      ? `, old key works ${policy.graceDays} more ${policy.graceDays === 1 ? "day" : "days"}`
      : "";
  return `Every ${policy.everyDays} days${grace}`;
}

const EVENT_LABELS: Record<string, string> = {
  "agent.created": "Agent added",
  "agent.paused": "Agent stopped",
  "agent.resumed": "Agent turned on",
  "agent.limits_changed": "Limits changed",
  "agent.updated": "Agent edited",
  "agent.key_rotated": "Key rotated",
  "request.denied": "Request refused",
  "provider.key_set": "Provider key saved",
  "provider.key_rotated": "Provider key replaced",
  "provider.key_rejected": "New provider key failed its test",
  "provider.old_keys_deleted": "Old provider key marked as deleted",
  "provider.key_removed": "Provider key removed",
  "provider.tested": "Provider tested",
  kill_all: "Everything stopped",
  "key.expired": "Key expired",
  "agent.limit_raised": "Limit raised once",
  "agent.service_changed": "Service changed",
  "keys.rotated_all": "All keys rotated",
  "log.viewed": "Call log read",
  "settings.changed": "Settings changed",
};

export function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? type.replace(/[._]/g, " ");
}

/** Short, plain summary of an audit event's detail. */
export function eventSummary(detail: Record<string, unknown> | undefined) {
  if (!detail) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(detail)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "object") continue;
    parts.push(
      `${key.replace(/([A-Z])/g, " $1").toLowerCase()}: ${String(value)}`,
    );
  }
  return parts.slice(0, 4).join(", ");
}

export const GRACE_OPTIONS: readonly { minutes: number; label: string }[] = [
  { minutes: 0, label: "Right away" },
  { minutes: 60, label: "After 1 hour" },
  { minutes: 1440, label: "After 24 hours" },
  { minutes: 10080, label: "After 7 days" },
];
