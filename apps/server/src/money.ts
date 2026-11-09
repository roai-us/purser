/** Dollars for people: cents normally, four decimals below a cent so small spend is visible. */
export function formatUsd(n: number): string {
  if (n !== 0 && Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
