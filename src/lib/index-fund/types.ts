/**
 * Shared types for the AlphaIndex AI-managed portfolio.
 */

import type { Asset } from "@/lib/universe";

export interface CandidateScore {
  asset: Asset;
  /** Sum of recent signal pressure (positive = bullish accumulation). */
  signal_score: number;
  /** Sector momentum bonus from sector_snapshots. */
  sector_score: number;
  /** ETF flow tailwind (BTC/ETH/SOL etc with active flows). */
  flow_score: number;
  /** Combined raw score before normalization. */
  composite_score: number;
  /** Reasons / data points behind the score (for transparency). */
  drivers: string[];
}

export interface CandidatePortfolio {
  /** Map of asset_id → target weight (fraction 0..1). Sums to 1 with cash. */
  weights: Record<string, number>;
  /** Cash (USDC) reserve weight. */
  cash_weight: number;
  /** Per-asset rationale for the UI / Claude review. */
  scores: CandidateScore[];
  /** Diagnostic counters. */
  meta: {
    candidates_considered: number;
    above_min_threshold: number;
    capped_at_max: number;
  };
}
