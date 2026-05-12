/**
 * Direction-lock validator (Phase G, invariant I-47).
 *
 * The calibration corpus aggregates into 28 (subtype × asset_class)
 * buckets. 22 of them are direction-locked — every historical
 * observation moved the same way:
 *   - defi_exploit × any           → always short
 *   - halving_event × large_cap    → always long
 *   - regulatory_etf_approval × *  → always long
 *   - corporate_treasury_buy × *   → always long
 *   - token_unlock × *             → always short
 *   - fed_decision × large_cap     → always short (corpus snapshot)
 *
 * When Claude's classification assigns a direction-locked bucket with
 * the opposite direction, we soft-flag the signal:
 *   - reasoning gets a `direction_lock_violation` note
 *   - conviction is capped at 0.5 (REVIEW tier ceiling)
 *
 * We deliberately don't hard-reject. The corpus is finite (95 events,
 * 13 subtypes); a real reversal might emerge that wasn't in the
 * training data. Soft-flagging surfaces the contradiction for human
 * review without blocking legitimate edge cases.
 *
 * Companion tests: tests/direction-lock.test.ts
 */

import { loadCorpus, type CalibrationCorpus } from "./corpus";

export type CorpusDirection = "long" | "short";
export type DirectionLock = "long-only" | "short-only" | "mixed";

export interface BucketProfile {
  subtype: string;
  asset_class: string;
  lock: DirectionLock;
  sample_size: number;
  /** Number of long observations in this bucket. */
  long_n: number;
  /** Number of short observations. */
  short_n: number;
}

let _profiles: Map<string, BucketProfile> | null = null;

function key(subtype: string, assetClass: string): string {
  return `${subtype}|${assetClass}`;
}

/** Build (or rebuild) the bucket-direction map from the corpus. Cached. */
export function loadDirectionProfiles(): Map<string, BucketProfile> {
  if (_profiles) return _profiles;
  const corpus = loadCorpus();
  _profiles = buildProfiles(corpus);
  return _profiles;
}

export function _resetDirectionLockCache(): void {
  _profiles = null;
}

export function _setDirectionLockCache(corpus: CalibrationCorpus): void {
  _profiles = buildProfiles(corpus);
}

function buildProfiles(corpus: CalibrationCorpus): Map<string, BucketProfile> {
  const counts = new Map<string, { long: number; short: number }>();
  for (const e of corpus.events) {
    const k = key(e.catalyst_subtype, e.asset_class);
    const c = counts.get(k) ?? { long: 0, short: 0 };
    if (e.direction === "long") c.long++;
    else c.short++;
    counts.set(k, c);
  }
  const out = new Map<string, BucketProfile>();
  for (const [k, c] of counts) {
    const [subtype, asset_class] = k.split("|");
    let lock: DirectionLock = "mixed";
    if (c.long > 0 && c.short === 0) lock = "long-only";
    else if (c.short > 0 && c.long === 0) lock = "short-only";
    out.set(k, {
      subtype: subtype!,
      asset_class: asset_class!,
      lock,
      sample_size: c.long + c.short,
      long_n: c.long,
      short_n: c.short,
    });
  }
  return out;
}

export interface DirectionLockCheck {
  /** True when a violation was detected. */
  violation: boolean;
  /** The bucket's lock state ('long-only' | 'short-only' | 'mixed' | 'unknown'). */
  lock: DirectionLock | "unknown";
  /** Sample size backing the lock — bigger n = stronger evidence. */
  sample_size: number;
  reasoning: string;
}

/**
 * Soft-check a classification against the corpus direction lock.
 *
 * Returns violation=true ONLY when:
 *   - bucket exists in corpus AND
 *   - bucket is direction-locked AND
 *   - proposed direction contradicts the lock
 *
 * Unknown buckets (corpus silent) → violation=false. Mixed buckets
 * → violation=false. We only flag clear contradictions against
 * unanimous historical evidence.
 */
export function checkDirectionLock(input: {
  subtype: string;
  asset_class: string;
  direction: CorpusDirection;
}): DirectionLockCheck {
  const profiles = loadDirectionProfiles();
  const profile = profiles.get(key(input.subtype, input.asset_class));
  if (!profile) {
    return {
      violation: false,
      lock: "unknown",
      sample_size: 0,
      reasoning: `corpus silent on (${input.subtype} × ${input.asset_class})`,
    };
  }
  if (profile.lock === "mixed") {
    return {
      violation: false,
      lock: "mixed",
      sample_size: profile.sample_size,
      reasoning: `bucket (n=${profile.sample_size}) is mixed direction — no lock`,
    };
  }
  // Locked bucket. Violation only when proposed direction contradicts.
  const proposedAgrees =
    (profile.lock === "long-only" && input.direction === "long") ||
    (profile.lock === "short-only" && input.direction === "short");
  if (proposedAgrees) {
    return {
      violation: false,
      lock: profile.lock,
      sample_size: profile.sample_size,
      reasoning: `direction agrees with corpus ${profile.lock} (n=${profile.sample_size})`,
    };
  }
  return {
    violation: true,
    lock: profile.lock,
    sample_size: profile.sample_size,
    reasoning:
      `Claude assigned direction=${input.direction} but corpus says ` +
      `(${input.subtype} × ${input.asset_class}) is ${profile.lock} ` +
      `across n=${profile.sample_size} observations`,
  };
}

/** Conviction ceiling applied when a direction-lock violation fires. */
export const DIRECTION_LOCK_CONVICTION_CAP = 0.5;
