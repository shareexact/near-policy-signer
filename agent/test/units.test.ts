import { describe, expect, it } from "vitest";
import { formatAmount, parseAmount } from "../src/units.js";

describe("units", () => {
  it("parses exact decimals without floats", () => {
    expect(parseAmount("2.5", 18)).toBe(2_500_000_000_000_000_000n);
    expect(parseAmount("0.000000000000000001", 18)).toBe(1n);
    expect(parseAmount("100", 6)).toBe(100_000_000n);
    // 0.1 + 0.2 would not survive floating point.
    expect(parseAmount("0.3", 18)).toBe(300_000_000_000_000_000n);
  });
  it("refuses excess precision and junk", () => {
    expect(() => parseAmount("1.1234567", 6)).toThrow(/more than 6 decimals/);
    for (const bad of ["-1", "1e18", "abc", "1.", ".5", ""]) expect(() => parseAmount(bad, 18)).toThrow();
  });
  it("round-trips", () => {
    expect(formatAmount(parseAmount("12.034", 18), 18)).toBe("12.034");
    expect(formatAmount(5n, 0)).toBe("5");
  });
});
