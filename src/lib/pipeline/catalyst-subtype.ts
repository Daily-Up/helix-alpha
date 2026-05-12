/**
 * Stage 5 — Catalyst subtype taxonomy.
 *
 * The previous risk derivation was event_type-aware (regulatory: 3d,
 * exploit: 4h, etc.) but not catalyst-subtype-aware. Within "regulatory",
 * a Fed governor's statement decays differently from a Senate markup
 * vote. Within "security", a confirmed exploit and a yet-to-be-exploited
 * disclosure live on different timelines.
 *
 * This module:
 *   1. Infers a finer subtype from event_type + title heuristics.
 *   2. Maps each subtype to a horizon (decay profile) and vol-multiple
 *      target/stop. Concrete % is computed by multiplying by the
 *      asset's 30d realized volatility — so a "+18% target on BTC"
 *      isn't the same nominal as "+18% on AMZN".
 *   3. Provides a magnitude-aware cap for fundraising events: a $12M
 *      seed round on a $5B-cap chain shouldn't fire above INFO.
 *
 * Companion tests: tests/catalyst-subtype.test.ts
 */

import type { CatalystSubtype, RiskProfileV2 } from "./types";

interface SubtypeInferInput {
  title: string;
  sentiment: "positive" | "negative" | "neutral";
}

/**
 * Infer the catalyst subtype from the classifier's event_type + a
 * lightweight title scan. The classifier doesn't output subtype
 * directly (changing the prompt is a separate workstream); we derive
 * it deterministically here so tests can pin behavior.
 */
export function inferCatalystSubtype(
  eventType: string,
  input: SubtypeInferInput,
): CatalystSubtype {
  const t = input.title.toLowerCase();

  // ── event_type-driven subtypes always take precedence ──
  // The classifier set event_type with full body context; our title regex
  // below is a fallback heuristic. When event_type is one of the
  // unambiguous categories, we don't want a title-pattern subtype (e.g.
  // whale_flow) to override it. Real example: "Fidelity's $BTC ETF led
  // $277M in total outflows" was previously being labeled `whale_flow`
  // because "outflow" + "$277M" matched the broadened whale-flow regex,
  // even though the classifier had correctly tagged event_type=etf_flow.
  if (eventType === "etf_flow") return "etf_flow_reaction";

  // ── transient_operational (hours) ──
  // Outage/incident language suggests an issue that gets resolved fast.
  if (
    /\b(outage|down\s+for|service\s+(?:disrupt|down)|aws\s+issue|infrastructure\s+issue|maintenance|temporary)\b/.test(
      t,
    )
  ) {
    return "transient_operational";
  }

  // ── whale_flow (1-12h) ──
  // Covers (a) explicit "whale" mentions, (b) large transfer/deposit/
  // withdraw verbs, (c) "moved $Xm" patterns, (d) on-chain flow phrasings
  // common in real coverage:
  //   - "deposited 108,169 $ETH into Binance" (large size + exchange name)
  //   - "$115M XRP outflow from spot exchanges"
  //   - "$80M USDC withdrawn from Coinbase"
  //   - "spot exchanges saw $200M inflow"
  //
  // The heuristic is intentionally conservative: it requires either an
  // EXPLICIT dollar/token-size figure ($X[m|million|b|billion]) OR a
  // recognised exchange name in proximity to a flow verb. That keeps
  // generic "deposit was made" or "withdraw funds" from overfitting.
  const FLOW_VERB =
    /(deposit(?:ed|ing|s)?|withdraw(?:ed|ing|als?|n)?|outflow(?:s|ing)?|inflow(?:s|ing)?|transferred?|moved|sent|moving|leaving)/i;
  const EXCHANGE_NAMES =
    /(binance|coinbase|kraken|okx|bybit|bitfinex|bitget|gate\.?io|kucoin|huobi|upbit|bithumb|spot\s+exchanges?|cex(?:es)?)/i;
  const SIZE_FIGURE = /\$\s*\d[\d,.]*\s*(?:m|mn|million|b|bn|billion|k)\b/i;
  // Whale mention — direct.
  if (/\bwhale(?:s)?\b/i.test(t)) return "whale_flow";
  // "large transfer/deposit/withdraw" classic phrasing.
  if (
    /\blarge\s+(?:transfer|deposit|withdraw|outflow|inflow)/i.test(t)
  ) {
    return "whale_flow";
  }
  // "moved $Xm" classic.
  if (/\bmoved\s+\$\d+/i.test(t)) return "whale_flow";
  // Combined heuristic: flow verb + (size figure OR exchange name).
  if (FLOW_VERB.test(t) && (SIZE_FIGURE.test(t) || EXCHANGE_NAMES.test(t))) {
    return "whale_flow";
  }
  // Standalone outflow/inflow at significant size.
  if (
    /\b(outflow|inflow)s?\b/i.test(t) &&
    SIZE_FIGURE.test(t) &&
    EXCHANGE_NAMES.test(t)
  ) {
    return "whale_flow";
  }

  // ── exploit_disclosure (1-4h) — confirmed hack, funds drained ──
  if (
    eventType === "exploit" ||
    /\b(drained|hacked|exploited|stolen|funds\s+lost|attack\s+confirmed|flash\s+loan)\b/.test(
      t,
    )
  ) {
    return "exploit_disclosure";
  }

  // ── security_disclosure (6-24h) — vuln found, not yet exploited ──
  if (
    eventType === "security" ||
    /\b(vulnerability|critical\s+bug|security\s+(?:flaw|issue|disclosure)|cve-)\b/.test(
      t,
    )
  ) {
    return "security_disclosure";
  }

  // (etf_flow_reaction is handled at the top of this function — event_type
  //  takes precedence over title regex for unambiguous categories.)

  // ── earnings_reaction ──
  if (eventType === "earnings") return "earnings_reaction";

  // ── legislative_progress (gates on next event) ──
  if (
    /\b(senate|house|congress)\b.*\b(committee|markup|vote|hearing|bill|act)\b/.test(
      t,
    ) ||
    /\b(clarity\s+act|stable\s+act|fit21)\b/.test(t)
  ) {
    return "legislative_progress";
  }

  // ── regulatory_statement (3-7d) ──
  if (
    eventType === "regulatory" &&
    /\b(sec|cftc|treasury|fed|chairman|chair|commissioner|secretary)\b.*\b(says|announces|statement|comments|signals|warns|launched)\b/.test(
      t,
    )
  ) {
    return "regulatory_statement";
  }
  // ── regulatory_enforcement (1-3d) — letters, subpoenas, lawsuits ──
  if (
    eventType === "regulatory" &&
    /\b(letter|subpoena|lawsuit|sues|charges|fines?|enforcement|crackdown|targets?)\b/.test(
      t,
    )
  ) {
    return "regulatory_enforcement";
  }
  // Default regulatory → statement
  if (eventType === "regulatory") return "regulatory_statement";

  // ── macro subtypes ──
  if (eventType === "macro") {
    if (
      /\b(cpi|ppi|nfp|gdp|unemployment|retail\s+sales|pmi|jobs\s+report)\b/.test(
        t,
      )
    ) {
      return "macro_print";
    }
    if (/\b(attack|tanker|sanction|war|conflict|strait|blockade|geopolit)\b/.test(t)) {
      return "macro_geopolitical";
    }
    return "macro_print"; // default macro = print-style
  }

  // ── governance_vote ──
  if (eventType === "governance") return "governance_vote";

  // ── treasury_action ──
  if (eventType === "treasury") return "treasury_action";

  // ── partnership_announcement ──
  if (eventType === "partnership") return "partnership_announcement";

  // ── fundraising_announcement ──
  if (eventType === "fundraising") return "fundraising_announcement";

  // ── listing_event ──
  if (eventType === "listing") return "listing_event";

  // ── tech_update ──
  if (eventType === "tech_update") return "tech_update";

  // ── narrative_shift ──
  if (eventType === "narrative") return "narrative_shift";

  // ── social_platform_action ──
  if (eventType === "social_platform") return "social_platform_action";

  // ── unlock / airdrop ──
  if (eventType === "unlock") return "unlock_supply";
  if (eventType === "airdrop") return "airdrop_announcement";

  return "other";
}

/**
 * Risk profile per subtype.
 *
 * `target_vol_multiple` is "how many multiples of the asset's 1d vol
 * does the catalyst typically move". 1.0 means a typical 1-day move;
 * 2.5 means a 2.5x amplification. Concrete target_pct is computed
 * from the asset's 30d realized vol when available; falls back to a
 * hardcoded baseline when not.
 *
 * Annualized vol → daily ≈ vol / sqrt(365). For 30d realized vol of
 * 0.5 (50% annualized), daily vol ≈ 2.6%.
 *
 * Horizon is the catalyst's expected reaction window — the lifecycle
 * stage uses this to set expiresAt.
 */
const SUBTYPE_PROFILES: Record<
  CatalystSubtype,
  {
    target_vol_multiple: number;
    stop_vol_multiple: number;
    horizon: string;
    horizon_ms: number;
    /** Fallback target % when vol data is unavailable. */
    fallback_target_pct: number;
    fallback_stop_pct: number;
  }
> = {
  transient_operational: {
    target_vol_multiple: 1.5,
    stop_vol_multiple: 1.0,
    horizon: "4h",
    horizon_ms: 4 * 3600 * 1000,
    fallback_target_pct: 4,
    fallback_stop_pct: 3,
  },
  whale_flow: {
    target_vol_multiple: 2.0,
    stop_vol_multiple: 1.2,
    horizon: "8h",
    horizon_ms: 8 * 3600 * 1000,
    fallback_target_pct: 5,
    fallback_stop_pct: 3,
  },
  etf_flow_reaction: {
    // ETF flow data is daily-cadence — the print is news for ~1-2 days
    // before being absorbed. Vol multiple modest (institutional flow
    // is information, not a forced trade).
    target_vol_multiple: 2.0,
    stop_vol_multiple: 1.2,
    horizon: "2d",
    horizon_ms: 2 * 24 * 3600 * 1000,
    fallback_target_pct: 8,
    fallback_stop_pct: 4,
  },
  earnings_reaction: {
    target_vol_multiple: 3.0,
    stop_vol_multiple: 1.5,
    horizon: "3d",
    horizon_ms: 3 * 24 * 3600 * 1000,
    fallback_target_pct: 14,
    fallback_stop_pct: 6,
  },
  regulatory_statement: {
    target_vol_multiple: 3.5,
    stop_vol_multiple: 1.5,
    horizon: "5d",
    horizon_ms: 5 * 24 * 3600 * 1000,
    fallback_target_pct: 14,
    fallback_stop_pct: 6,
  },
  regulatory_enforcement: {
    target_vol_multiple: 2.5,
    stop_vol_multiple: 1.3,
    horizon: "2d",
    horizon_ms: 2 * 24 * 3600 * 1000,
    fallback_target_pct: 12,
    fallback_stop_pct: 5,
  },
  legislative_progress: {
    target_vol_multiple: 2.0,
    stop_vol_multiple: 1.0,
    horizon: "3d",
    horizon_ms: 3 * 24 * 3600 * 1000,
    fallback_target_pct: 10,
    fallback_stop_pct: 5,
  },
  macro_print: {
    target_vol_multiple: 2.0,
    stop_vol_multiple: 1.0,
    horizon: "5d",
    horizon_ms: 5 * 24 * 3600 * 1000,
    fallback_target_pct: 9,
    fallback_stop_pct: 4,
  },
  macro_geopolitical: {
    target_vol_multiple: 2.5,
    stop_vol_multiple: 1.2,
    horizon: "5d",
    horizon_ms: 5 * 24 * 3600 * 1000,
    fallback_target_pct: 12,
    fallback_stop_pct: 5,
  },
  exploit_disclosure: {
    target_vol_multiple: 3.5,
    stop_vol_multiple: 1.5,
    horizon: "4h",
    horizon_ms: 4 * 3600 * 1000,
    fallback_target_pct: 12,
    fallback_stop_pct: 4,
  },
  security_disclosure: {
    target_vol_multiple: 2.0,
    stop_vol_multiple: 1.2,
    horizon: "12h",
    horizon_ms: 12 * 3600 * 1000,
    fallback_target_pct: 10,
    fallback_stop_pct: 5,
  },
  governance_vote: {
    target_vol_multiple: 2.0,
    stop_vol_multiple: 1.5,
    horizon: "24h",
    horizon_ms: 24 * 3600 * 1000,
    fallback_target_pct: 15,
    fallback_stop_pct: 8,
  },
  treasury_action: {
    target_vol_multiple: 2.5,
    stop_vol_multiple: 1.3,
    horizon: "3d",
    horizon_ms: 3 * 24 * 3600 * 1000,
    fallback_target_pct: 16,
    fallback_stop_pct: 7,
  },
  partnership_announcement: {
    target_vol_multiple: 2.5,
    stop_vol_multiple: 1.5,
    horizon: "24h",
    horizon_ms: 24 * 3600 * 1000,
    fallback_target_pct: 18,
    fallback_stop_pct: 8,
  },
  fundraising_announcement: {
    target_vol_multiple: 2.5,
    stop_vol_multiple: 1.5,
    horizon: "5d",
    horizon_ms: 5 * 24 * 3600 * 1000,
    fallback_target_pct: 20,
    fallback_stop_pct: 8,
  },
  listing_event: {
    target_vol_multiple: 3.0,
    stop_vol_multiple: 1.5,
    horizon: "12h",
    horizon_ms: 12 * 3600 * 1000,
    fallback_target_pct: 20,
    fallback_stop_pct: 6,
  },
  tech_update: {
    target_vol_multiple: 2.5,
    stop_vol_multiple: 1.3,
    horizon: "5d",
    horizon_ms: 5 * 24 * 3600 * 1000,
    fallback_target_pct: 18,
    fallback_stop_pct: 7,
  },
  narrative_shift: {
    target_vol_multiple: 2.0,
    stop_vol_multiple: 1.5,
    horizon: "3d",
    horizon_ms: 3 * 24 * 3600 * 1000,
    fallback_target_pct: 18,
    fallback_stop_pct: 8,
  },
  social_platform_action: {
    target_vol_multiple: 2.5,
    stop_vol_multiple: 1.5,
    horizon: "24h",
    horizon_ms: 24 * 3600 * 1000,
    fallback_target_pct: 15,
    fallback_stop_pct: 8,
  },
  unlock_supply: {
    target_vol_multiple: 2.0,
    stop_vol_multiple: 1.0,
    horizon: "48h",
    horizon_ms: 48 * 3600 * 1000,
    fallback_target_pct: 12,
    fallback_stop_pct: 5,
  },
  airdrop_announcement: {
    target_vol_multiple: 3.0,
    stop_vol_multiple: 2.0,
    horizon: "3d",
    horizon_ms: 3 * 24 * 3600 * 1000,
    fallback_target_pct: 25,
    fallback_stop_pct: 10,
  },
  // ── Corpus-introduced subtypes (taxonomy_extensions in
  // data/calibration-corpus.json). Risk profiles below are seeded from
  // the empirical distribution of the corpus; the runtime base-rate
  // derivation in data/base-rates.json supersedes these once Phase B
  // generates the table. They remain as a fallback when no calibrated
  // entry exists for (subtype, asset_class).
  regulatory_action: {
    // Umbrella reg action used by corpus for elections, nominations,
    // policy shifts. Larger horizon than enforcement; meaningful tail.
    target_vol_multiple: 3.5,
    stop_vol_multiple: 1.5,
    horizon: "7d",
    horizon_ms: 7 * 24 * 3600 * 1000,
    fallback_target_pct: 18,
    fallback_stop_pct: 8,
  },
  regulatory_etf_approval: {
    target_vol_multiple: 4.0,
    stop_vol_multiple: 1.5,
    horizon: "14d",
    horizon_ms: 14 * 24 * 3600 * 1000,
    fallback_target_pct: 12,
    fallback_stop_pct: 5,
  },
  regulatory_taxonomy_ruling: {
    target_vol_multiple: 3.0,
    stop_vol_multiple: 1.5,
    horizon: "5d",
    horizon_ms: 5 * 24 * 3600 * 1000,
    fallback_target_pct: 14,
    fallback_stop_pct: 6,
  },
  fed_decision: {
    target_vol_multiple: 2.5,
    stop_vol_multiple: 1.2,
    horizon: "5d",
    horizon_ms: 5 * 24 * 3600 * 1000,
    fallback_target_pct: 10,
    fallback_stop_pct: 4,
  },
  geopolitical_escalation: {
    target_vol_multiple: 2.5,
    stop_vol_multiple: 1.2,
    horizon: "5d",
    horizon_ms: 5 * 24 * 3600 * 1000,
    fallback_target_pct: 10,
    fallback_stop_pct: 5,
  },
  geopolitical_deescalation: {
    target_vol_multiple: 2.5,
    stop_vol_multiple: 1.2,
    horizon: "5d",
    horizon_ms: 5 * 24 * 3600 * 1000,
    fallback_target_pct: 10,
    fallback_stop_pct: 5,
  },
  defi_exploit: {
    target_vol_multiple: 4.0,
    stop_vol_multiple: 1.5,
    horizon: "4h",
    horizon_ms: 4 * 3600 * 1000,
    fallback_target_pct: 18,
    fallback_stop_pct: 6,
  },
  corporate_treasury_buy: {
    target_vol_multiple: 2.5,
    stop_vol_multiple: 1.3,
    horizon: "3d",
    horizon_ms: 3 * 24 * 3600 * 1000,
    fallback_target_pct: 14,
    fallback_stop_pct: 6,
  },
  token_unlock: {
    target_vol_multiple: 2.0,
    stop_vol_multiple: 1.0,
    horizon: "48h",
    horizon_ms: 48 * 3600 * 1000,
    fallback_target_pct: 12,
    fallback_stop_pct: 5,
  },
  halving_event: {
    target_vol_multiple: 3.0,
    stop_vol_multiple: 1.5,
    horizon: "90d",
    horizon_ms: 90 * 24 * 3600 * 1000,
    fallback_target_pct: 20,
    fallback_stop_pct: 8,
  },
  manipulation_fud: {
    target_vol_multiple: 2.0,
    stop_vol_multiple: 1.2,
    horizon: "48h",
    horizon_ms: 48 * 3600 * 1000,
    fallback_target_pct: 8,
    fallback_stop_pct: 4,
  },
  semiconductor_earnings: {
    target_vol_multiple: 3.0,
    stop_vol_multiple: 1.5,
    horizon: "3d",
    horizon_ms: 3 * 24 * 3600 * 1000,
    fallback_target_pct: 12,
    fallback_stop_pct: 5,
  },
  big_tech_capex: {
    target_vol_multiple: 2.5,
    stop_vol_multiple: 1.3,
    horizon: "5d",
    horizon_ms: 5 * 24 * 3600 * 1000,
    fallback_target_pct: 10,
    fallback_stop_pct: 4,
  },
  ai_chip_export_policy: {
    target_vol_multiple: 3.0,
    stop_vol_multiple: 1.5,
    horizon: "5d",
    horizon_ms: 5 * 24 * 3600 * 1000,
    fallback_target_pct: 14,
    fallback_stop_pct: 6,
  },
  other: {
    target_vol_multiple: 2.0,
    stop_vol_multiple: 1.5,
    horizon: "24h",
    horizon_ms: 24 * 3600 * 1000,
    fallback_target_pct: 18,
    fallback_stop_pct: 8,
  },
};

/**
 * Resolve the risk profile for a subtype, vol-normalized when 30d
 * realized vol (annualized fraction, e.g. 0.50 = 50%) is provided.
 */
export function riskProfileForSubtype(
  subtype: CatalystSubtype,
  vol30d: number | null,
): RiskProfileV2 {
  const p = SUBTYPE_PROFILES[subtype];
  if (vol30d == null || !Number.isFinite(vol30d)) {
    return {
      target_vol_multiple: p.target_vol_multiple,
      stop_vol_multiple: p.stop_vol_multiple,
      target_pct: p.fallback_target_pct,
      stop_pct: p.fallback_stop_pct,
      horizon: p.horizon,
      horizon_ms: p.horizon_ms,
      subtype,
    };
  }
  // Convert annualized vol → daily, then scale by horizon.
  const dailyVol = vol30d / Math.sqrt(365);
  const horizonDays = p.horizon_ms / (24 * 3600 * 1000);
  // Move ~ daily vol × sqrt(horizon).
  const horizonScale = Math.sqrt(Math.max(0.5, horizonDays));
  const targetPct = Math.round(
    p.target_vol_multiple * dailyVol * 100 * horizonScale * 10,
  ) / 10;
  const stopPct =
    Math.round(p.stop_vol_multiple * dailyVol * 100 * horizonScale * 10) / 10;
  return {
    target_vol_multiple: p.target_vol_multiple,
    stop_vol_multiple: p.stop_vol_multiple,
    target_pct: Math.max(2, targetPct),
    stop_pct: Math.max(1.5, stopPct),
    horizon: p.horizon,
    horizon_ms: p.horizon_ms,
    subtype,
  };
}

/**
 * Cap fundraising tier when round size is small relative to market cap.
 * Sub-$50M rounds on multi-billion-cap chains are PR fluff that almost
 * never moves the underlying token.
 *
 * Rule:
 *   ratio = round_size / market_cap
 *   ratio < 0.005 (0.5%) → cap at INFO
 *   else → keep tier
 */
export function capForFundingMagnitude(
  tier: "auto" | "review" | "info",
  size: { round_size_usd: number; market_cap_usd: number | null },
): "auto" | "review" | "info" {
  if (size.market_cap_usd == null || size.market_cap_usd <= 0) return tier;
  const ratio = size.round_size_usd / size.market_cap_usd;
  if (ratio < 0.005) return "info";
  return tier;
}
