/**
 * Analysis pipelines — turn raw events + price data into structured insights.
 *
 * Today: impact engine. Coming: pattern discovery, lead/lag detector,
 * cross-asset correlation matrix.
 */

export {
  runImpactCompute,
  runImpactComputeWithAudit,
  type ImpactComputeSummary,
  type ImpactComputeOptions,
} from "./impact";

export {
  computePatterns,
  computePatternsByEventType,
  empiricalTradability,
  type Horizon,
  type PatternStats,
  type PatternsByType,
} from "./patterns";
