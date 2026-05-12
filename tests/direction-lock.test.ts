/**
 * Direction-lock validator tests (Phase G, invariant I-47).
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  checkDirectionLock,
  loadDirectionProfiles,
  _setDirectionLockCache,
  _resetDirectionLockCache,
  DIRECTION_LOCK_CONVICTION_CAP,
} from "../src/lib/calibration/direction-lock";
import { loadCorpus } from "../src/lib/calibration/corpus";

beforeAll(() => {
  _resetDirectionLockCache();
  _setDirectionLockCache(loadCorpus());
});

describe("direction-lock validator (I-47)", () => {
  it("builds a profile per (subtype, asset_class) bucket from the corpus", () => {
    const profiles = loadDirectionProfiles();
    expect(profiles.size).toBeGreaterThan(20);
    // halving_event × large_cap_crypto should be long-locked.
    const halving = profiles.get("halving_event|large_cap_crypto");
    expect(halving).toBeDefined();
    expect(halving!.lock).toBe("long-only");
    // defi_exploit × small_cap_crypto should be short-locked.
    const exploit = profiles.get("defi_exploit|small_cap_crypto");
    expect(exploit).toBeDefined();
    expect(exploit!.lock).toBe("short-only");
  });

  it("flags a defi_exploit + LONG as a direction-lock violation", () => {
    const result = checkDirectionLock({
      subtype: "defi_exploit",
      asset_class: "small_cap_crypto",
      direction: "long",
    });
    expect(result.violation).toBe(true);
    expect(result.lock).toBe("short-only");
    expect(result.sample_size).toBeGreaterThanOrEqual(2);
    expect(result.reasoning).toMatch(/short-only/);
  });

  it("does NOT flag a defi_exploit + SHORT (direction agrees with lock)", () => {
    const result = checkDirectionLock({
      subtype: "defi_exploit",
      asset_class: "small_cap_crypto",
      direction: "short",
    });
    expect(result.violation).toBe(false);
    expect(result.lock).toBe("short-only");
  });

  it("does NOT flag a corpus-silent bucket — returns lock=unknown", () => {
    const result = checkDirectionLock({
      subtype: "completely_made_up_subtype",
      asset_class: "large_cap_crypto",
      direction: "long",
    });
    expect(result.violation).toBe(false);
    expect(result.lock).toBe("unknown");
    expect(result.sample_size).toBe(0);
  });

  it("does NOT flag a mixed bucket — both directions seen historically", () => {
    // big_tech_capex × big_tech is mixed in the corpus.
    const result = checkDirectionLock({
      subtype: "big_tech_capex",
      asset_class: "big_tech",
      direction: "long",
    });
    expect(result.lock).toBe("mixed");
    expect(result.violation).toBe(false);
  });

  it("conviction cap constant is defined and is 0.5 (REVIEW ceiling)", () => {
    // The cap value is part of the contract — changing it would change
    // post-flag tier behaviour. Locked at 0.5.
    expect(DIRECTION_LOCK_CONVICTION_CAP).toBe(0.5);
  });

  it("halving_event + SHORT violates lock; halving_event + LONG agrees", () => {
    const violation = checkDirectionLock({
      subtype: "halving_event",
      asset_class: "large_cap_crypto",
      direction: "short",
    });
    const agreement = checkDirectionLock({
      subtype: "halving_event",
      asset_class: "large_cap_crypto",
      direction: "long",
    });
    expect(violation.violation).toBe(true);
    expect(agreement.violation).toBe(false);
  });

  it("corporate_treasury_buy × crypto_proxy is long-locked (MSTR buys → MSTR up)", () => {
    const result = checkDirectionLock({
      subtype: "corporate_treasury_buy",
      asset_class: "crypto_proxy",
      direction: "long",
    });
    expect(result.lock).toBe("long-only");
    expect(result.violation).toBe(false);
  });
});
