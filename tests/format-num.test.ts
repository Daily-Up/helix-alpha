import { describe, it, expect } from "vitest";
import { formatNum } from "@/lib/format/num";

describe("formatNum — precision by magnitude class", () => {
  it("billions → 2dp B", () => {
    expect(formatNum(106_770_000_000, { unit: "$" }).text).toBe("$106.77B");
  });
  it("millions → 1dp M", () => {
    expect(formatNum(328_400_000, { unit: "$" }).text).toBe("$328.4M");
  });
  it("thousands → separated", () => {
    expect(formatNum(64197, { unit: "$" }).text).toBe("$64,197");
  });
  it("thousands compact → K", () => {
    expect(formatNum(9500, { unit: "$", compact: true }).text).toBe("$9.5K");
  });
  it("1..1000 → 2dp", () => {
    expect(formatNum(289.821858, { unit: "USDC" }).text).toBe("289.82 USDC");
  });
  it("sub-1 → ≤4 sig-dp, trailing zeros trimmed (never 0.00669586275)", () => {
    expect(formatNum(0.00669586275).text).toBe("0.0067");
    expect(formatNum(0.6695).text).toBe("0.6695");
  });
  it("sign + percent", () => {
    expect(formatNum(4.0, { unit: "%", sign: true }).text).toBe("+4.00%");
    expect(formatNum(-2.5, { unit: "%" }).text).toBe("-2.50%");
  });
  it("null/NaN → empty; zero flagged", () => {
    expect(formatNum(null).isEmpty).toBe(true);
    expect(formatNum(NaN).isEmpty).toBe(true);
    expect(formatNum(0).isZero).toBe(true);
  });
});
