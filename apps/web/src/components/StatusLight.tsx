import type { AgentState, Light } from "../api/types";
import { STATE_LABELS } from "../lib/format";

/** Green can make calls. Yellow hit a spending limit. Red was stopped, ended or has a lapsed key. */
export function lightOf(state: AgentState): Light {
  if (state === "running") return "green";
  return state === "at_limit" ? "yellow" : "red";
}

export const LIGHT_CLASS: Record<Light, string> = {
  green: "light light-on",
  yellow: "light light-warn",
  red: "light light-off",
};

/**
 * A green, yellow or red light. Decorative by default, because a text label sits
 * next to it; pass `label` when the light stands alone.
 */
export function StatusLight({
  state,
  label,
}: {
  state: AgentState;
  label?: string;
}) {
  return (
    <span
      className={LIGHT_CLASS[lightOf(state)]}
      {...(label
        ? { role: "img", "aria-label": label }
        : { "aria-hidden": true })}
      title={STATE_LABELS[state]}
    />
  );
}
