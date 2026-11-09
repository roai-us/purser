/**
 * Tracks every request an agent has open, so a kill can cut them mid-stream
 * instead of waiting for them to finish.
 */
export class InFlight {
  private readonly open = new Map<string, Set<AbortController>>();

  add(agentId: string, controller: AbortController): void {
    let set = this.open.get(agentId);
    if (!set) {
      set = new Set();
      this.open.set(agentId, set);
    }
    set.add(controller);
  }

  remove(agentId: string, controller: AbortController): void {
    const set = this.open.get(agentId);
    if (!set) return;
    set.delete(controller);
    if (set.size === 0) this.open.delete(agentId);
  }

  count(agentId: string): number {
    return this.open.get(agentId)?.size ?? 0;
  }

  /** Aborts every open request for the agent and returns how many there were. */
  abortAll(agentId: string, reason: string): number {
    const set = this.open.get(agentId);
    if (!set) return 0;
    const controllers = [...set];
    this.open.delete(agentId);
    for (const controller of controllers)
      controller.abort(new KillError(reason));
    return controllers.length;
  }
}

export class KillError extends Error {
  override name = "KillError";
}
