/**
 * Weight computation engine v2 — anchored portfolio with momentum tilts.
 *
 * Why v2 exists: v1 used 24h sector momentum × 100 in the score, which
 * drowned out everything else. One day of green for the L2 sector pushed
 * ARB and OP each to 16% — multi-year downtrend assets sized like majors.
 *
 * v2 design principles:
 *   1. ANCHOR by market cap. BTC, ETH, SOL, gold and MAG7 always get a
 *      base allocation regardless of signals.
 *   2. MOMENTUM = 30-day return, not 24h sector flicker. Long-term price
 *      action is what matters for "is this asset healthy".
 *   3. SIGNALS tilt within constraints. Strong signals add ±50% to base
 *      weight, never more.
 *   4. CAP non-anchor assets at 5%. Even with the strongest signal an
 *      altcoin can't exceed 5%, preventing concentration risk.
 *   5. HARD FLOOR — assets with sustained -20%+ 30d return AND no positive
 *      signals are excluded entirely. Don't fight a downtrend.
 */

import { Assets, db, Settings } from "@/lib/db";
import type { Asset } from "@/lib/universe";
import type { CandidatePortfolio, CandidateScore } from "./types";

// ─────────────────────────────────────────────────────────────────────────
// Anchor allocation — always-in-the-portfolio assets, market-cap-weighted.
// Sums to 76%, leaving 24% for tilts (capped per-asset at 5%).
// ─────────────────────────────────────────────────────────────────────────

const ANCHOR_WEIGHTS: Record<string, number> = {
  "tok-btc":     0.28,
  "tok-eth":     0.16,
  "tok-sol":     0.07,
  "tok-bnb":     0.05,
  "rwa-xaut":    0.07, // Gold — uncorrelated hedge
  "idx-ssimag7": 0.07, // Crypto Magnificent 7
  "tok-xrp":     0.03,
  "tok-link":    0.03,
};

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

const TILT_BUDGET = 1 - sum(Object.values(ANCHOR_WEIGHTS)); // 0.24

/** Per-asset cap for non-anchor assets. Strongest signal still can't exceed this. */
const NON_ANCHOR_CAP = 0.05;
/** Per-asset cap for anchors — they can flex up by ~25% from base. */
const ANCHOR_MAX = 0.35;

interface SignalAggRow {
  asset_id: string;
  signed_score: number;
  count: number;
}

/**
 * Aggregate recent signals per asset. LONG = +conviction with linear
 * time-decay over the window. SHORT = -conviction.
 */
function aggregateSignals(windowMs: number): Map<string, SignalAggRow> {
  const cutoff = Date.now() - windowMs;
  interface Row {
    asset_id: string;
    direction: "long" | "short";
    confidence: number;
    fired_at: number;
  }
  const rows = db()
    .prepare<[number], Row>(
      `SELECT asset_id, direction, confidence, fired_at
       FROM signals
       WHERE fired_at >= ?
         AND status IN ('pending', 'executed')`,
    )
    .all(cutoff);

  const out = new Map<string, SignalAggRow>();
  const now = Date.now();
  for (const r of rows) {
    const ageMs = now - r.fired_at;
    const decay = Math.max(0, 1 - ageMs / windowMs);
    const signed = (r.direction === "long" ? 1 : -1) * r.confidence * decay;
    const acc = out.get(r.asset_id) ?? {
      asset_id: r.asset_id,
      signed_score: 0,
      count: 0,
    };
    acc.signed_score += signed;
    acc.count += 1;
    out.set(r.asset_id, acc);
  }
  return out;
}

/**
 * 30-day return per asset from daily klines, expressed as a fraction
 * (e.g. 0.10 = +10%, -0.30 = -30%). Skips assets with insufficient history.
 */
function loadMomentum30d(): Map<string, number> {
  interface Row {
    asset_id: string;
    last_close: number;
    earlier_close: number;
  }
  const rows = db()
    .prepare<[], Row>(
      `WITH ranked AS (
         SELECT asset_id, close,
                ROW_NUMBER() OVER (PARTITION BY asset_id ORDER BY date DESC) AS rn
         FROM klines_daily
       )
       SELECT
         a.asset_id   AS asset_id,
         a.close      AS last_close,
         b.close      AS earlier_close
       FROM ranked a
       JOIN ranked b ON b.asset_id = a.asset_id AND b.rn = 30
       WHERE a.rn = 1`,
    )
    .all();

  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.last_close > 0 && r.earlier_close > 0) {
      out.set(r.asset_id, (r.last_close - r.earlier_close) / r.earlier_close);
    }
  }
  return out;
}

/**
 * Translate a 30d return into a tilt multiplier in roughly [0.4, 1.6].
 * Smooth tanh curve so extreme returns saturate.
 */
function momentumToMultiplier(ret30d: number | undefined): number {
  if (ret30d == null) return 1.0;
  return 1 + 0.6 * Math.tanh(ret30d * 2);
}

/**
 * Translate accumulated signal score into a tilt multiplier in [0.5, 1.5].
 */
function signalsToMultiplier(signedScore: number): number {
  return 1 + 0.5 * Math.tanh(signedScore / 2);
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

export interface ComputeOptions {
  /** Lookback window for signal aggregation. Default 14 days. */
  windowMs?: number;
  /** Override settings (used by tests). */
  settings?: Partial<ReturnType<typeof Settings.getSettings>>;
  /** Zero out the signal layer — used by attribution (Part 3) to build
   *  the momentum-only counterfactual. Does NOT affect live rebalancing. */
  skipSignals?: boolean;
}

export function computeCandidatePortfolio(
  opts: ComputeOptions = {},
): CandidatePortfolio {
  const settings = { ...Settings.getSettings(), ...opts.settings };
  const windowMs = opts.windowMs ?? 14 * 24 * 60 * 60 * 1000;

  const signalAgg = opts.skipSignals
    ? new Map<string, SignalAggRow>()
    : aggregateSignals(windowMs);
  const momentum = loadMomentum30d();
  const cashFrac = settings.index_cash_reserve_pct / 100;

  // ── Step 1: Anchor weights ────────────────────────────────────
  const anchorWeights: Record<string, number> = {};
  const scores: CandidateScore[] = [];

  for (const [assetId, baseW] of Object.entries(ANCHOR_WEIGHTS)) {
    const asset = Assets.getAssetById(assetId);
    if (!asset?.tradable) continue;

    const sig = signalAgg.get(assetId);
    const ret30 = momentum.get(assetId);
    const mMom = momentumToMultiplier(ret30);
    const mSig = signalsToMultiplier(sig?.signed_score ?? 0);

    const tilted = baseW * mMom * mSig;
    const capped = Math.min(tilted, ANCHOR_MAX);
    anchorWeights[assetId] = capped;

    const drivers: string[] = [];
    drivers.push(`anchor base ${(baseW * 100).toFixed(1)}%`);
    if (ret30 != null)
      drivers.push(`30d ${(ret30 * 100).toFixed(1)}% (×${mMom.toFixed(2)})`);
    if (sig)
      drivers.push(
        `${sig.count} signal${sig.count !== 1 ? "s" : ""} (×${mSig.toFixed(2)})`,
      );

    scores.push({
      asset,
      signal_score: sig?.signed_score ?? 0,
      sector_score: ret30 ?? 0,
      flow_score: 0,
      composite_score: tilted,
      drivers,
    });
  }

  // ── Step 2: Tilt budget — top non-anchor assets by signal+momentum ──
  const allAssets = Assets.getAllAssets().filter(
    (a) => a.tradable && !ANCHOR_WEIGHTS[a.id],
  );

  interface TiltCandidate {
    asset: Asset;
    score: number;
    ret30: number | undefined;
    sigScore: number;
    sigCount: number;
  }
  const tiltCandidates: TiltCandidate[] = [];

  // Stricter inclusion bars to avoid "barely positive on one weak axis" picks
  // sneaking in (e.g. ENA on a single low-conviction signal).
  const STRONG_MOMENTUM_THRESHOLD = 0.15; // ≥+15% 30d return
  const STRONG_SIGNAL_THRESHOLD   = 0.5;  // accumulated conviction ≥0.5
  const MIN_COMPOSITE_FOR_PICK    = 0.30; // must clear this combined score

  for (const asset of allAssets) {
    const sig = signalAgg.get(asset.id);
    const ret30 = momentum.get(asset.id);
    const sigScoreRaw = sig?.signed_score ?? 0;

    // HARD FLOOR: don't fight a downtrend.
    if (ret30 != null && ret30 < -0.2 && sigScoreRaw <= 0) continue;
    // Need data on at least one axis.
    if (ret30 == null && sigScoreRaw <= 0) continue;

    const strongMomentum = ret30 != null && ret30 >= STRONG_MOMENTUM_THRESHOLD;
    const strongSignal = sigScoreRaw >= STRONG_SIGNAL_THRESHOLD;

    // Pick must be carried by at least ONE strong axis. Marginal positives
    // on both don't qualify — that's how noise picks get in.
    if (!strongMomentum && !strongSignal) continue;

    const momScore = ret30 != null ? Math.tanh(ret30 * 2) : 0; // -1..1
    const sigScore = Math.tanh(sigScoreRaw / 2); // -1..1
    const composite = 0.5 * momScore + 0.5 * sigScore;
    if (composite < MIN_COMPOSITE_FOR_PICK) continue;

    tiltCandidates.push({
      asset,
      score: composite,
      ret30,
      sigScore: sigScoreRaw,
      sigCount: sig?.count ?? 0,
    });
  }

  tiltCandidates.sort((a, b) => b.score - a.score);

  // Allocate top candidates from the tilt budget, capped per-asset.
  const tiltWeights: Record<string, number> = {};
  let remaining = TILT_BUDGET;
  for (const c of tiltCandidates) {
    if (remaining <= 0.005) break;
    // Score-proportional desired weight, capped at NON_ANCHOR_CAP.
    const desired = Math.min(NON_ANCHOR_CAP, c.score * 0.05);
    const take = Math.min(desired, remaining);
    if (take >= 0.01) {
      tiltWeights[c.asset.id] = take;
      remaining -= take;

      const drivers: string[] = [];
      if (c.ret30 != null)
        drivers.push(`30d ${(c.ret30 * 100).toFixed(1)}%`);
      if (c.sigCount > 0)
        drivers.push(
          `${c.sigCount} signal${c.sigCount !== 1 ? "s" : ""} (${c.sigScore >= 0 ? "+" : ""}${c.sigScore.toFixed(2)})`,
        );
      scores.push({
        asset: c.asset,
        signal_score: c.sigScore,
        sector_score: c.ret30 ?? 0,
        flow_score: 0,
        composite_score: c.score,
        drivers,
      });
    }
  }

  // ── Step 3: Combine + scale to (1 - cash) ─────────────────────
  const combined: Record<string, number> = { ...anchorWeights, ...tiltWeights };
  const combinedSum = sum(Object.values(combined));
  const targetSum = 1 - cashFrac;
  const scale = combinedSum > 0 ? targetSum / combinedSum : 0;

  const finalWeights: Record<string, number> = {};
  for (const [id, w] of Object.entries(combined)) {
    finalWeights[id] = w * scale;
  }

  return {
    weights: finalWeights,
    cash_weight: cashFrac,
    scores: scores.sort((a, b) => b.composite_score - a.composite_score),
    meta: {
      candidates_considered:
        allAssets.length + Object.keys(ANCHOR_WEIGHTS).length,
      above_min_threshold: Object.keys(finalWeights).length,
      capped_at_max: 0,
    },
  };
}
