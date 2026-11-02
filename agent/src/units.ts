// Exact decimal handling. No floating point anywhere: amounts are strings in
// and bigints out.

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** "2.5" with 18 decimals -> 2500000000000000000n. Rejects excess precision. */
export function parseAmount(text: string, decimals: number): bigint {
  const m = DECIMAL.exec(text.trim());
  if (!m) throw new Error(`amount "${text}" is not a plain decimal number`);
  const whole = m[1] ?? "0";
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`amount "${text}" has more than ${decimals} decimals`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export function formatAmount(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
