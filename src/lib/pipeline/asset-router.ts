/**
 * Stage 3 — Asset router with relevance scoring.
 *
 * Replaces the implicit "first tradable in affected_asset_ids" routing
 * with explicit relevance scoring per (event, asset) pair.
 *
 * Relevance levels (numeric scores in src/lib/pipeline/types.ts):
 *   subject              1.0  named subject of the catalyst
 *   directly_affected    0.8  named entity, not subject (counterparty)
 *   basket_with_member   0.5  basket containing a verified subject
 *   incidentally_mentioned 0.3 appears but not central
 *   basket_without_member 0.0 BLOCK — basket doesn't contain subject
 *
 * Bug-class-1 examples this prevents:
 *   - MAG7 selected as primary when COIN is the subject (COIN ∉ MAG7)
 *   - ssidefi selected when AAVE itself is tradable and named
 *   - MAG7 selected for MSTR treasury news (MSTR ∉ MAG7)
 *   - ARB selected for LayerZero vulnerability (ARB merely uses LayerZero)
 *
 * Companion tests: tests/asset-router.test.ts
 */

import {
  ASSET_RELEVANCE_SCORE,
  type AssetCandidate,
  type AssetRelevanceLevel,
  type AssetRouting,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────
// Index constituent membership
//
// Hardcoded for the indexes our universe actually uses. When a basket
// is a candidate primary, we MUST verify the named entity is in its
// constituent set; otherwise the basket is rejected (score 0).
//
// Source of truth:
//   ssimag7  — Magnificent 7: AAPL, MSFT, GOOGL, AMZN, META, NVDA, TSLA
//   ssidefi  — DeFi index: AAVE, UNI, MKR, COMP, CRV, SUSHI, etc.
//   ssirwa   — RWA index: ONDO, USDT, etc.
//   ssilayer1 — L1 index: ETH, SOL, ADA, DOT, AVAX, etc.
//   ssilayer2 — L2 index: ARB, OP, MATIC, etc.
//   ssicefi  — CeFi index: COIN, HOOD, etc.
//   ussi     — US crypto stocks: COIN, MSTR, MARA, RIOT, etc.
// ─────────────────────────────────────────────────────────────────────────

const INDEX_CONSTITUENTS: Record<string, ReadonlySet<string>> = {
  "idx-ssimag7": new Set([
    "stk-aapl",
    "stk-msft",
    "stk-googl",
    "stk-amzn",
    "stk-meta",
    "stk-nvda",
    "stk-tsla",
  ]),
  "idx-ssidefi": new Set([
    "tok-aave",
    "tok-uni",
    "tok-mkr",
    "tok-comp",
    "tok-crv",
    "tok-sushi",
    "tok-ldo",
    "tok-snx",
    "tok-1inch",
    "tok-bal",
  ]),
  "idx-ssilayer1": new Set([
    "tok-eth",
    "tok-sol",
    "tok-ada",
    "tok-dot",
    "tok-avax",
    "tok-near",
    "tok-apt",
    "tok-sui",
    "tok-bnb",
  ]),
  "idx-ssilayer2": new Set([
    "tok-arb",
    "tok-op",
    "tok-matic",
    "tok-base",
    "tok-strk",
    "tok-mnt",
  ]),
  "idx-ssirwa": new Set([
    "tok-ondo",
    "rwa-usdt",
    "rwa-usdc",
    "rwa-xaut",
    "tok-pendle",
  ]),
  "idx-ssicefi": new Set([
    "stk-coin",
    "stk-hood",
    "stk-block",
    "stk-pypl",
  ]),
  "idx-ussi": new Set([
    "stk-coin",
    "stk-hood",
    "stk-mstr",
    "trs-mstr",
    "stk-mara",
    "stk-riot",
    "stk-iren",
    "stk-cifr",
    "stk-crcl",
  ]),
};

/** True iff `assetId` is a known constituent of `indexId`. */
export function isIndexConstituent(
  indexId: string,
  assetId: string,
): boolean {
  return INDEX_CONSTITUENTS[indexId]?.has(assetId) ?? false;
}

/** Names by symbol/word for substring matching in title checks. */
const SYMBOL_ALIASES: Record<string, string[]> = {
  BTC: ["btc", "bitcoin"],
  ETH: ["eth", "ether", "ethereum"],
  SOL: ["sol", "solana"],
  COIN: ["coin", "coinbase"],
  MSTR: ["mstr", "microstrategy", "strategy"],
  NVDA: ["nvda", "nvidia"],
  AAVE: ["aave"],
  ARB: ["arb", "arbitrum"],
  OP: ["op", "optimism"],
  MNT: ["mnt", "mantle"],
  HOOD: ["hood", "robinhood"],
  AMZN: ["amzn", "amazon"],
  META: ["meta", "facebook"],
  GOOGL: ["googl", "google", "alphabet"],
  AAPL: ["aapl", "apple"],
  TSLA: ["tsla", "tesla"],
  MSFT: ["msft", "microsoft"],
  USDT: ["usdt", "tether"],
  USDC: ["usdc", "circle"],
};

interface CandidateInput {
  asset_id: string;
  symbol: string;
  kind: string;
  tradable: boolean;
}

interface RelevanceCheckInput {
  candidate: CandidateInput;
  title: string;
  affected_asset_ids: string[];
  event_type: string;
}

export interface RelevanceResult {
  relevance: AssetRelevanceLevel;
  score: number;
  reason: string;
  /** Earliest position the asset's name appears in the title, in chars.
   *  Used as a tiebreaker when multiple candidates score "subject". */
  position?: number;
}

/**
 * Score how relevant `candidate` is to the event described by `title`.
 *
 * Algorithm:
 *   1. Resolve aliases for the candidate's symbol.
 *   2. If candidate is a basket index → verify a constituent is in
 *      affected_asset_ids. If not → BLOCK (basket_without_member).
 *   3. If candidate's name is in the FIRST 12 words of title →
 *      probably the subject (1.0).
 *   4. Otherwise if name appears anywhere in title → directly_affected (0.8).
 *   5. Otherwise if it's a basket with a member → 0.5.
 *   6. Otherwise it's only in affected_asset_ids → incidental (0.3).
 */
export function scoreAssetRelevance(
  input: RelevanceCheckInput,
): RelevanceResult {
  const { candidate, title, affected_asset_ids } = input;
  const titleLower = title.toLowerCase();

  // Resolve possible aliases for this candidate.
  const aliases = SYMBOL_ALIASES[candidate.symbol.toUpperCase()] ?? [
    candidate.symbol.toLowerCase(),
  ];

  // ── Basket asset path ──
  if (candidate.kind === "index" || candidate.kind === "etf") {
    // Find any constituent of this basket that's in affected_asset_ids.
    const constituents = INDEX_CONSTITUENTS[candidate.asset_id];
    if (!constituents) {
      // Unknown basket — fall back to incidental treatment.
      return {
        relevance: "incidentally_mentioned",
        score: ASSET_RELEVANCE_SCORE.incidentally_mentioned,
        reason: "unknown basket constituents",
      };
    }
    const memberHit = affected_asset_ids.find((id) => constituents.has(id));
    if (!memberHit) {
      // BUG CLASS 1 — block: basket whose constituents include none of
      // the named affected entities.
      return {
        relevance: "basket_without_member",
        score: ASSET_RELEVANCE_SCORE.basket_without_member,
        reason: `${candidate.asset_id} contains none of the affected entities`,
      };
    }
    return {
      relevance: "basket_with_member",
      score: ASSET_RELEVANCE_SCORE.basket_with_member,
      reason: `${candidate.asset_id} contains constituent ${memberHit}`,
    };
  }

  // ── Specific asset path (token / stock / treasury / rwa) ──
  let earliestPosition: number | null = null;
  for (const alias of aliases) {
    // Word-boundary match (string-source regex to avoid \b template-literal
    // backspace bug).
    const re = new RegExp("\\b" + alias.replace(/[^a-z0-9$]/g, "") + "\\b", "i");
    const m = titleLower.match(re);
    if (m && m.index !== undefined) {
      if (earliestPosition == null || m.index < earliestPosition) {
        earliestPosition = m.index;
      }
    }
    // Also try $TICKER pattern.
    const dpos = titleLower.indexOf("$" + alias);
    if (dpos >= 0 && (earliestPosition == null || dpos < earliestPosition)) {
      earliestPosition = dpos;
    }
  }

  // ── Macro special-case ──
  // For macro/regulatory/etf_flow events affecting majors (BTC/ETH/SOL),
  // the asset is broadly affected even when not literally in the
  // headline ("Fed dovish surprise" doesn't say BTC, but BTC is in the
  // affected set). Give them directly_affected.
  const MAJORS = new Set(["BTC", "ETH", "SOL"]);
  const isMacroLike = MACRO_LIKE_EVENT_TYPES.has(input.event_type);

  if (earliestPosition != null) {
    // Subject = appears in the first ~30 chars (roughly first 5 words).
    // Beyond that = directly_affected.
    if (earliestPosition < 30) {
      return {
        relevance: "subject",
        score: ASSET_RELEVANCE_SCORE.subject,
        reason: `${candidate.symbol} named in headline opening (pos ${earliestPosition})`,
        position: earliestPosition,
      } as RelevanceResult;
    }
    return {
      relevance: "directly_affected",
      score: ASSET_RELEVANCE_SCORE.directly_affected,
      reason: `${candidate.symbol} mentioned in title (pos ${earliestPosition})`,
      position: earliestPosition,
    } as RelevanceResult;
  }

  if (isMacroLike && MAJORS.has(candidate.symbol.toUpperCase())) {
    return {
      relevance: "directly_affected",
      score: ASSET_RELEVANCE_SCORE.directly_affected,
      reason: `${candidate.symbol} is a major asset broadly affected by ${input.event_type} events`,
    };
  }

  // Not in title — only in affected_asset_ids list.
  return {
    relevance: "incidentally_mentioned",
    score: ASSET_RELEVANCE_SCORE.incidentally_mentioned,
    reason: `${candidate.symbol} only present in classifier's affected_asset_ids`,
  };
}

interface RouteInput {
  title: string;
  candidates: CandidateInput[];
  affected_asset_ids: string[];
  event_type: string;
}

/** Macro-class events that should never select a single-asset primary —
 *  they must emit multi-asset output (primary + secondaries). */
const MACRO_LIKE_EVENT_TYPES = new Set([
  "macro",
  "regulatory",
  "etf_flow",
  "narrative",
]);

/**
 * Extract the symbol of the asset being listed in a listing-event title.
 * Used by the router for listing events to filter out candidates that
 * are quote currencies in the trading pair, not the listed asset.
 *
 * Examples:
 *   "Upbit will list PROS in KRW, BTC, USDT" → "PROS"
 *   "Upbit will list Pharos (PROS) for spot trading" → "PROS"
 *   "Coinbase lists BTC perpetual contracts" → "BTC"
 *   Returns null when no listing pattern matches.
 */
function extractListedSymbol(title: string): string | null {
  if (!title) return null;
  const t = title.trim();
  // "list X" / "launches X" / "list the X (SYMBOL)"
  const reA =
    /\b(?:will\s+)?(?:list|lists|listed|listing|launch(?:es|ed|ing)?|add(?:s|ed|ing)?|enable(?:s|d|ing)?|to\s+list)\s+(?:the\s+)?([A-Za-z][a-zA-Z0-9]{0,15})(?:\s*\(([A-Z][A-Z0-9]{0,9})\))?/i;
  const a = t.match(reA);
  if (a) return (a[2] ?? a[1]).toUpperCase();
  const b = t.match(
    /\b([A-Za-z][a-zA-Z0-9]{0,15})\s+(?:listing|listed)\b/i,
  );
  if (b) return b[1].toUpperCase();
  return null;
}

/**
 * Route an event to a primary asset + secondaries.
 *
 * Returns null primary when no candidate clears the relevance bar, in
 * which case the signal generator should drop the event entirely
 * (no signal).
 */
export function routeAssets(input: RouteInput): AssetRouting {
  const { candidates, title, affected_asset_ids, event_type } = input;

  // ── Listing-event special case ──
  // For listing events, the listed asset is what matters. If the
  // classifier proxies to a major (BTC/ETH/USDT) because the actual
  // listed token isn't in the universe, we need to BLOCK those
  // proxies — they happen to appear in the title only as the QUOTE
  // currency in the trading pair, not as the subject.
  let listedSymbolUpper: string | null = null;
  if (event_type === "listing") {
    listedSymbolUpper = extractListedSymbol(title);
  }

  const scored: Array<{
    candidate: CandidateInput;
    result: RelevanceResult;
  }> = candidates.map((c) => {
    const result = scoreAssetRelevance({
      candidate: c,
      title,
      affected_asset_ids,
      event_type,
    });
    // Listing-event override: if we extracted a listed symbol and
    // this candidate's symbol doesn't match it, force relevance to 0
    // (basket_without_member equivalent). This prevents BTC/USDT
    // trading-pair quote currencies from being treated as "subject"
    // when they appear later in the title.
    if (
      listedSymbolUpper &&
      c.symbol.toUpperCase() !== listedSymbolUpper
    ) {
      return {
        candidate: c,
        result: {
          relevance: "basket_without_member",
          score: 0,
          reason: `listing event subject is ${listedSymbolUpper}, not ${c.symbol}`,
        },
      };
    }
    return { candidate: c, result };
  });

  // Block all candidates with score 0 (basket_without_member).
  const rejected: AssetRouting["rejected"] = [];
  for (const s of scored) {
    if (s.result.score === 0) {
      rejected.push({
        candidate: {
          asset_id: s.candidate.asset_id,
          symbol: s.candidate.symbol,
          kind: s.candidate.kind,
          tradable: s.candidate.tradable,
          relevance: s.result.relevance,
          reason: s.result.reason,
        },
        reason: s.result.reason,
      });
    }
  }
  // Drop tradable=false candidates.
  for (const s of scored) {
    if (!s.candidate.tradable && s.result.score > 0) {
      rejected.push({
        candidate: {
          asset_id: s.candidate.asset_id,
          symbol: s.candidate.symbol,
          kind: s.candidate.kind,
          tradable: false,
          relevance: s.result.relevance,
          reason: s.result.reason,
        },
        reason: "not tradable",
      });
    }
  }

  const eligible = scored.filter(
    (s) => s.result.score > 0 && s.candidate.tradable,
  );
  if (eligible.length === 0) {
    return { primary: null, secondaries: [], rejected };
  }

  // ── Sort: relevance DESC, then non-basket, then earliest title position ──
  eligible.sort((a, b) => {
    if (a.result.score !== b.result.score) {
      return b.result.score - a.result.score;
    }
    // Tie on relevance: prefer specific over basket.
    const isABasket = a.candidate.kind === "index" || a.candidate.kind === "etf";
    const isBBasket = b.candidate.kind === "index" || b.candidate.kind === "etf";
    if (isABasket && !isBBasket) return 1;
    if (!isABasket && isBBasket) return -1;
    // Both non-basket (or both basket): the one named earliest in the
    // title is more likely the subject. Catches "Strategy added BTC"
    // routing to MSTR (pos 0) over BTC (pos 16).
    const aPos = a.result.position ?? 9999;
    const bPos = b.result.position ?? 9999;
    return aPos - bPos;
  });

  // For subject-specific events, the primary must be at relevance >= 0.5.
  // Below that, no primary.
  const top = eligible[0];
  if (top.result.score < 0.5) {
    rejected.push({
      candidate: {
        asset_id: top.candidate.asset_id,
        symbol: top.candidate.symbol,
        kind: top.candidate.kind,
        tradable: top.candidate.tradable,
        relevance: top.result.relevance,
        reason: top.result.reason,
      },
      reason:
        "best candidate below 0.5 relevance — no asset is a credible subject",
    });
    return { primary: null, secondaries: [], rejected };
  }

  const primary: AssetCandidate = {
    asset_id: top.candidate.asset_id,
    symbol: top.candidate.symbol,
    kind: top.candidate.kind,
    tradable: top.candidate.tradable,
    relevance: top.result.relevance,
    reason: top.result.reason,
  };

  const secondaries: AssetCandidate[] = eligible
    .slice(1)
    .filter((s) => s.result.score >= 0.5 || MACRO_LIKE_EVENT_TYPES.has(event_type))
    .map((s) => ({
      asset_id: s.candidate.asset_id,
      symbol: s.candidate.symbol,
      kind: s.candidate.kind,
      tradable: s.candidate.tradable,
      relevance: s.result.relevance,
      reason: s.result.reason,
    }));

  // Macro events: ensure we have at least 1-2 secondaries when possible,
  // since a Fed dovish event affecting only one asset is unusual.
  return { primary, secondaries, rejected };
}
