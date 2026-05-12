/**
 * fmtPrice — magnitude-aware price display.
 *
 * Fixes the "$80868.0000" line-noise problem on BTC while keeping
 * sub-dollar precision for memecoins and low-priced index tokens.
 */

import { describe, it, expect } from "vitest";
import { fmtPrice } from "../src/lib/format";

describe("fmtPrice", () => {
  it("renders BTC-scale prices with thousands separators and ≤2 decimals", () => {
    expect(fmtPrice(80868)).toBe("$80,868");
    expect(fmtPrice(80868.5)).toBe("$80,868.5");
    expect(fmtPrice(80868.55)).toBe("$80,868.55");
    // Doesn't add fake precision when the price is an integer thousand.
    expect(fmtPrice(100000)).toBe("$100,000");
  });

  it("renders stock-scale prices with 2 decimals", () => {
    expect(fmtPrice(150.42)).toBe("$150.42");
    expect(fmtPrice(45.3)).toBe("$45.30");
    expect(fmtPrice(1)).toBe("$1.00");
  });

  it("renders sub-dollar prices with 4 decimals", () => {
    expect(fmtPrice(0.5485)).toBe("$0.5485");
    expect(fmtPrice(0.01)).toBe("$0.0100");
  });

  it("renders tiny prices (<$0.01) with 6 decimals", () => {
    expect(fmtPrice(0.000123)).toBe("$0.000123");
    expect(fmtPrice(0.001234)).toBe("$0.001234");
  });

  it("handles negative numbers (e.g. signed deltas) correctly", () => {
    expect(fmtPrice(-80868)).toBe("$-80,868");
  });

  it("returns '—' for null/undefined/non-finite", () => {
    expect(fmtPrice(null)).toBe("—");
    expect(fmtPrice(undefined)).toBe("—");
    expect(fmtPrice(NaN)).toBe("—");
    expect(fmtPrice(Infinity)).toBe("—");
  });
});
