import type { RotationPolicy } from "../api/types";

export const EXPIRY_CHOICES = ["never", "30", "60", "90", "custom"] as const;
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number];
export const ROTATE_EVERY = [0, 30, 60, 90, 180, 365] as const;
export const GRACE_DAYS = [0, 1, 3, 7, 14, 30] as const;

export interface KeyPolicy {
  expires: ExpiryChoice;
  /** yyyy-mm-dd, used when expires is "custom". */
  customDate: string;
  /** 0 means no schedule. */
  everyDays: number;
  graceDays: number;
}

const DAY = 86_400_000;

export function policyFromAgent(agent?: {
  keyExpiresAt?: string;
  rotation?: RotationPolicy;
}): KeyPolicy {
  return {
    expires: agent?.keyExpiresAt ? "custom" : "never",
    customDate: agent?.keyExpiresAt ? agent.keyExpiresAt.slice(0, 10) : "",
    everyDays: agent?.rotation?.everyDays ?? 0,
    graceDays: agent?.rotation?.graceDays ?? 0,
  };
}

/** The expiry date a policy asks for, or undefined for none. */
export function expiryFromPolicy(
  policy: KeyPolicy,
  now: number = Date.now(),
): string | undefined {
  if (policy.expires === "custom") {
    return policy.customDate
      ? new Date(`${policy.customDate}T23:59:59Z`).toISOString()
      : undefined;
  }
  if (policy.expires === "never") return undefined;
  return new Date(now + Number(policy.expires) * DAY).toISOString();
}

export function rotationFromPolicy(
  policy: KeyPolicy,
): RotationPolicy | undefined {
  return policy.everyDays > 0
    ? { everyDays: policy.everyDays, graceDays: policy.graceDays }
    : undefined;
}

/** Choices for when an agent's key expires and how often it is rotated. */
export function KeyPolicyFields({
  value,
  onChange,
}: {
  value: KeyPolicy;
  onChange: (value: KeyPolicy) => void;
}) {
  const set = (patch: Partial<KeyPolicy>) => onChange({ ...value, ...patch });
  return (
    <fieldset className="key-policy">
      <legend>Key expiry and rotation</legend>
      <div className="grid-2">
        <label className="field">
          <span>Key expires</span>
          <select
            value={value.expires}
            onChange={(e) => set({ expires: e.target.value as ExpiryChoice })}
          >
            <option value="never">Never</option>
            <option value="30">In 30 days</option>
            <option value="60">In 60 days</option>
            <option value="90">In 90 days</option>
            <option value="custom">On a date</option>
          </select>
        </label>
        {value.expires === "custom" ? (
          <label className="field">
            <span>Expiry date</span>
            <input
              type="date"
              value={value.customDate}
              onChange={(e) => set({ customDate: e.target.value })}
              required
            />
          </label>
        ) : (
          <span aria-hidden="true" />
        )}
        <label className="field">
          <span>Rotate automatically every</span>
          <select
            value={value.everyDays}
            onChange={(e) => set({ everyDays: Number(e.target.value) })}
          >
            {ROTATE_EVERY.map((days) => (
              <option key={days} value={days}>
                {days === 0 ? "Off" : `${days} days`}
              </option>
            ))}
          </select>
        </label>
        {value.everyDays > 0 && (
          <label className="field">
            <span>Old key keeps working for</span>
            <select
              value={value.graceDays}
              onChange={(e) => set({ graceDays: Number(e.target.value) })}
            >
              {GRACE_DAYS.map((days) => (
                <option key={days} value={days}>
                  {days === 0
                    ? "No overlap"
                    : `${days} ${days === 1 ? "day" : "days"}`}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p className="hint">
        Purser can't put the new key into your tool for you. When a key is due,
        the owner rotates it and pastes the new one; the old key keeps working
        for the grace period.
      </p>
    </fieldset>
  );
}
