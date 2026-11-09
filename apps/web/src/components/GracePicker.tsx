import { useId } from "react";
import { GRACE_OPTIONS } from "../lib/format";

/** Picks no grace period at all and lets each agent's own schedule decide. */
export const USE_POLICY = -1;

/** When the old key should stop working. */
export function GracePicker({
  value,
  onChange,
  policyGraceDays,
  mixedPolicies,
}: {
  value: number;
  onChange: (minutes: number) => void;
  /** This agent's rotation schedule overlap, offered as a choice. */
  policyGraceDays?: number | undefined;
  /** Several agents: offer "use each agent's own schedule". */
  mixedPolicies?: boolean;
}) {
  const name = useId();
  const options: { minutes: number; label: string }[] = [];
  if (mixedPolicies) {
    options.push({
      minutes: USE_POLICY,
      label: "Each agent's own rotation schedule",
    });
  }
  options.push(...GRACE_OPTIONS);
  if (
    policyGraceDays !== undefined &&
    policyGraceDays > 0 &&
    !options.some((o) => o.minutes === policyGraceDays * 1440)
  ) {
    options.push({
      minutes: policyGraceDays * 1440,
      label: `After ${policyGraceDays} days (this agent's schedule)`,
    });
  }
  return (
    <fieldset className="grace">
      <legend>When should the old key stop working?</legend>
      {options.map((option) => (
        <label key={option.minutes} className="radio">
          <input
            type="radio"
            name={name}
            value={option.minutes}
            checked={value === option.minutes}
            onChange={() => onChange(option.minutes)}
          />
          {option.label}
        </label>
      ))}
      <p className="hint">
        A delay gives you time to paste the new key into the tool before the old
        one stops. Stopping the agent cancels both keys at once.
      </p>
    </fieldset>
  );
}
