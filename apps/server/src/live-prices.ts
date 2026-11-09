import type { Rates } from "./pricing.js";

const REFRESH_MS = 3_600_000;
const RETRY_MS = 300_000;
const TIMEOUT_MS = 10_000;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A price per token as a price per million, or null if it isn't a real price. */
function perMillion(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const price = Number(value);
  // openrouter/auto lists -1: the price depends on the model it picks.
  return Number.isFinite(price) && price >= 0 ? price * 1_000_000 : null;
}

/**
 * OpenRouter's own prices for its hundreds of models, which the dated price
 * table can't keep up with. Only used to estimate a call OpenRouter didn't
 * report a charge for, such as one cut off before its end, so a cheap or free
 * model isn't charged at the table's highest rate.
 */
export class OpenRouterPrices {
  private rates = new Map<string, Rates>();
  private nextCheck = 0;

  constructor(
    private readonly fetchFn: typeof fetch,
    private readonly now: () => Date,
  ) {}

  /**
   * Loads the list if it's due. It never makes a call wait, so an estimate
   * made before the first load finishes falls back to the price table.
   */
  refresh(upstreamBase: string, apiKey: string): void {
    const at = this.now().getTime();
    if (at < this.nextCheck) return;
    this.nextCheck = at + REFRESH_MS;
    this.load(upstreamBase, apiKey).catch(() => {
      // Keep what we have, and try again sooner than usual.
      this.nextCheck = at + RETRY_MS;
    });
  }

  /** The rates for a model id. A variant not listed itself uses its base model's. */
  find(model: string | null): Rates | null {
    if (model === null) return null;
    return (
      this.rates.get(model) ?? this.rates.get(model.split(":")[0] ?? "") ?? null
    );
  }

  private async load(upstreamBase: string, apiKey: string): Promise<void> {
    const response = await this.fetchFn(`${upstreamBase}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const body: unknown = await response.json();
    if (!isObject(body) || !Array.isArray(body.data)) {
      throw new Error("unexpected model list");
    }
    const rates = new Map<string, Rates>();
    for (const model of body.data as unknown[]) {
      if (!isObject(model) || typeof model.id !== "string") continue;
      if (!isObject(model.pricing)) continue;
      const input = perMillion(model.pricing.prompt);
      const output = perMillion(model.pricing.completion);
      if (input !== null && output !== null) {
        rates.set(model.id, { input, output });
      }
    }
    if (rates.size === 0) throw new Error("no prices in the model list");
    this.rates = rates;
  }
}
