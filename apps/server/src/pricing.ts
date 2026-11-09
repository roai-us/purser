import type { TokenUsage } from "./types.js";

/** Prices in US dollars per million tokens. */
export interface Rates {
  input: number;
  output: number;
  /** Reading from the prompt cache. Defaults to the input rate. */
  cacheRead?: number | undefined;
  /** Writing to a 5-minute prompt cache. Defaults to 1.25 times the input rate. */
  cacheWrite5m?: number | undefined;
  /** Writing to a 1-hour prompt cache. Defaults to 2 times the input rate. */
  cacheWrite1h?: number | undefined;
}

export interface ModelPrice extends Rates {
  /** Different rates once a request's total input passes a threshold. */
  above?: { inputTokens: number; rates: Rates } | undefined;
}

export interface PriceTable {
  /** The date these prices were last checked against the sources. */
  asOf: string;
  sources: string[];
  notes: string[];
  models: Record<string, ModelPrice>;
  /**
   * Used for any model not in the table. It is deliberately the most
   * expensive rate in the table, so a cap trips early rather than late.
   */
  fallback: Rates;
}

export interface PriceMatch {
  rates: Rates;
  /** The table entry that matched, or null when the fallback was used. */
  matched: string | null;
}

/**
 * True when `model` is `family` itself, a dated or suffixed version of it
 * ("gpt-4o-2024-08-06"), or a routing variant of it ("openai/gpt-4o:nitro").
 */
export function modelMatches(model: string, family: string): boolean {
  return (
    model === family ||
    model.startsWith(`${family}-`) ||
    model.startsWith(`${family}:`)
  );
}

/** Finds the longest table entry that matches the model, so "gpt-4o-mini" beats "gpt-4o". */
export function findPrice(
  table: PriceTable,
  model: string,
  totalInputTokens: number,
): PriceMatch {
  let best: string | null = null;
  for (const family of Object.keys(table.models)) {
    if (
      modelMatches(model, family) &&
      (best === null || family.length > best.length)
    ) {
      best = family;
    }
  }
  if (best === null) return { rates: table.fallback, matched: null };
  const price = table.models[best] as ModelPrice;
  const rates =
    price.above && totalInputTokens > price.above.inputTokens
      ? price.above.rates
      : price;
  return { rates, matched: best };
}

export function totalInputTokens(usage: TokenUsage): number {
  return (
    usage.inputTokens +
    usage.cacheReadTokens +
    usage.cacheWrite5mTokens +
    usage.cacheWrite1hTokens
  );
}

export function costUsd(usage: TokenUsage, rates: Rates): number {
  const cacheRead = rates.cacheRead ?? rates.input;
  const write5m = rates.cacheWrite5m ?? rates.input * 1.25;
  const write1h = rates.cacheWrite1h ?? rates.input * 2;
  return (
    (usage.inputTokens * rates.input +
      usage.outputTokens * rates.output +
      usage.cacheReadTokens * cacheRead +
      usage.cacheWrite5mTokens * write5m +
      usage.cacheWrite1hTokens * write1h) /
    1_000_000
  );
}
