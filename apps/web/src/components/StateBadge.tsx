import type { AgentState } from "../api/types";
import { STATE_LABELS } from "../lib/format";

export function StateBadge({ state }: { state: AgentState }) {
  return <span className={`badge badge-${state}`}>{STATE_LABELS[state]}</span>;
}
