/**
 * UI-primitives ratchet guard (design-notes.md, "Make it stick").
 *
 * The app must not grow NEW instances of the anti-patterns the shared
 * primitives replace. Existing debt is tolerated via a baseline; any
 * INCREASE fails CI. As screens migrate onto <Num>/<Addr>/<Action>, lower
 * the baseline — it only ever ratchets down.
 *
 *   raw .toFixed()   → use <Num> (precision by magnitude class)
 *   toLocaleString() → use <Num compact>
 *   0x…slice(-n)     → use <Addr> (one truncation format, click-to-copy)
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Baselines — the count on the day the guard landed. Only lower these.
// Ratcheted 161→90 / 7→3 after the full-app primitive migration (21 screens).
const BASELINE = { toFixed: 90, toLocaleString: 18, addrSlice: 3 };

const ROOTS = ["src/components", "src/app"];
// The primitives themselves are the ONE place these are allowed.
const ALLOW = ["src/components/ui/"];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

function count(re: RegExp): number {
  let n = 0;
  for (const root of ROOTS) {
    for (const f of walk(root)) {
      if (ALLOW.some((a) => f.replace(/\\/g, "/").includes(a))) continue;
      const src = readFileSync(f, "utf8");
      n += (src.match(re) ?? []).length;
    }
  }
  return n;
}

describe("UI primitives — ratchet guard", () => {
  it("does not add new raw .toFixed() (use <Num>)", () => {
    expect(count(/\.toFixed\(/g)).toBeLessThanOrEqual(BASELINE.toFixed);
  });
  it("does not add new toLocaleString() number formats (use <Num compact>)", () => {
    expect(count(/toLocaleString\(/g)).toBeLessThanOrEqual(BASELINE.toLocaleString);
  });
  it("does not add new local address truncation (use <Addr>)", () => {
    expect(count(/slice\(0, ?[0-9]+\)[^;\n]{0,24}slice\(-[0-9]+\)/g)).toBeLessThanOrEqual(BASELINE.addrSlice);
  });
});
