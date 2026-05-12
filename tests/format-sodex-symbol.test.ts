/**
 * fmtSodexSymbol — display shim for SoDEX trading pairs.
 *
 * SoDEX prefixes spot-pair coins with `v` (e.g. `vBTC_vUSDC`); we strip
 * the prefix and switch the separator to `/` so users see exchange-style
 * symbols. Perps (`BASE-USD`) pass through unchanged.
 */

import { describe, it, expect } from "vitest";
import { fmtSodexSymbol } from "../src/lib/format";

describe("fmtSodexSymbol", () => {
  it("strips leading v from each side of a spot pair and uses slash", () => {
    expect(fmtSodexSymbol("vBTC_vUSDC")).toBe("BTC/USDC");
    expect(fmtSodexSymbol("vETH_vUSDC")).toBe("ETH/USDC");
  });

  it("preserves multi-character bases like vMAG7ssi → MAG7ssi", () => {
    expect(fmtSodexSymbol("vMAG7ssi_vUSDC")).toBe("MAG7ssi/USDC");
  });

  it("passes perp markets through unchanged", () => {
    expect(fmtSodexSymbol("COIN-USD")).toBe("COIN-USD");
    expect(fmtSodexSymbol("NVDA-USD")).toBe("NVDA-USD");
  });

  it("returns '—' for null/undefined/empty", () => {
    expect(fmtSodexSymbol(null)).toBe("—");
    expect(fmtSodexSymbol(undefined)).toBe("—");
    expect(fmtSodexSymbol("")).toBe("—");
  });

  it("passes unknown shapes through unchanged (defensive)", () => {
    expect(fmtSodexSymbol("BTC")).toBe("BTC");
    expect(fmtSodexSymbol("custom-shape")).toBe("custom-shape");
  });

  it("does not strip a lowercase 'v' that isn't a SoDEX prefix", () => {
    // 'vUSDC' meets the SoDEX prefix shape (v + uppercase letter), so it
    // strips. But 'visa_token' wouldn't have a capital next to the v, so
    // the regex /^v(?=[A-Z0-9])/ leaves it alone. Defensive against
    // hypothetical token symbols that happen to start with a lowercase v.
    expect(fmtSodexSymbol("visa_token")).toBe("visa/token");
    // Whereas a real SoDEX pair strips cleanly:
    expect(fmtSodexSymbol("vSOL_vUSDC")).toBe("SOL/USDC");
  });
});
