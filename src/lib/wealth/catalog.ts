/**
 * Catalog metadata + merge logic for the Wealth Index.
 *
 * SoDEX's Wealth API exposes funds and market quotes, but NOT the editorial
 * grouping shown on sodex.com/wealth (Stable Earn / Curated ETF / Specialty),
 * the display names, or short blurbs. Those are curated, so we keep a small
 * metadata table — transcribed from SoDEX's own Wealth page, not invented —
 * and fall back to a fundType-based bucket for any fund we don't recognise,
 * so new SoDEX funds still surface automatically.
 *
 * `buildCatalog` folds the live market quote into each fund. Every numeric
 * field is parsed from the API or left null; nothing here fabricates data.
 */

import type {
  WealthCategory,
  WealthFundRaw,
  WealthFundView,
  WealthQuoteRaw,
} from "./types";

const SODEX_WEALTH_URL = "https://sodex.com/wealth";

interface FundMeta {
  category: WealthCategory;
  displayName: string;
  blurb: string | null;
  /** alpha-biz.sodex.dev seoName for per-fund news (only when verified). */
  newsSeo: string | null;
}

/**
 * Editorial metadata, transcribed from sodex.com/wealth. `newsSeo` is set
 * only for funds whose news feed we verified, to avoid 404 guesses.
 */
const FUND_META: Record<string, FundMeta> = {
  // ── Stable Earn ──
  "Morpho-Earn": {
    category: "stable_earn",
    displayName: "USDC Earn",
    blurb: "Variable USDC yield, backed by prime collateral (Morpho-powered). Redeem anytime.",
    newsSeo: null,
  },
  vBOXX: {
    category: "stable_earn",
    displayName: "US Cash Yield",
    blurb: "Treasury-bill-style yield, on-chain. Short duration.",
    newsSeo: null,
  },
  // ── Curated ETF ──
  vQQQ: {
    category: "curated_etf",
    displayName: "US Tech 100",
    blurb: "Nasdaq-100 mega-cap tech, tokenised.",
    newsSeo: "stocks_qqq",
  },
  vVOO: {
    category: "curated_etf",
    displayName: "US 500",
    blurb: "S&P 500 broad-market exposure, tokenised.",
    newsSeo: "stocks_voo",
  },
  vSCHD: {
    category: "curated_etf",
    displayName: "US Selected Dividend",
    blurb: "Quality US dividend stocks.",
    newsSeo: null,
  },
  vVYM: {
    category: "curated_etf",
    displayName: "US Broad Dividend",
    blurb: "Broad US high-dividend basket.",
    newsSeo: null,
  },
  vVGT: {
    category: "curated_etf",
    displayName: "US Broad Tech",
    blurb: "Broad US information-technology sector.",
    newsSeo: null,
  },
  // ── Specialty ──
  CXMT: {
    category: "specialty",
    displayName: "CXMT Vault",
    blurb: "On-chain exposure to China's leading DRAM memory maker.",
    newsSeo: "stocks_changxin",
  },
  UNITREE: {
    category: "specialty",
    displayName: "Unitree Vault",
    blurb: "A leading Chinese humanoid-robotics company.",
    newsSeo: "stocks_unitree",
  },
  vSMH: {
    category: "specialty",
    displayName: "US Semis 25",
    blurb: "US semiconductor leaders.",
    newsSeo: null,
  },
  vSTRC: {
    category: "specialty",
    displayName: "Strategy Preferred Yield",
    blurb: "Strategy (MSTR) preferred-yield exposure.",
    newsSeo: null,
  },
};

export const CATEGORY_ORDER: WealthCategory[] = [
  "stable_earn",
  "curated_etf",
  "specialty",
];

function categoryFromType(fundType: string): WealthCategory {
  if (fundType === "bridged_vault") return "stable_earn";
  if (fundType === "escrow_vault") return "specialty";
  return "curated_etf"; // clob + anything else
}

function numOrNull(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Merge the funds list with the live market quotes into catalog view rows. */
export function buildCatalog(
  funds: WealthFundRaw[],
  quotes: WealthQuoteRaw[],
): WealthFundView[] {
  const quoteById = new Map(quotes.map((q) => [q.fundId, q]));

  return funds
    .filter((f) => f.fundStatus === "live")
    .map((f) => {
      const q = quoteById.get(f.fundId);
      const meta = FUND_META[f.fundId];
      const category = meta?.category ?? categoryFromType(f.fundType);

      const apy7d = numOrNull(q?.apy7d);
      const roi1Y = numOrNull(q?.roi1Y);
      const roiInception = numOrNull(q?.roiInception);
      // Genuine yield products only (Stable Earn / a real yield source). A
      // price-derived apy7d on an equity vault is NOT a yield — those show a
      // return, falling back to "Since Inception" when there's no 1-yr track.
      const isYield = category === "stable_earn" || !!q?.yieldSource;

      // Headline metric: APY for yield funds; else 1-year return; else
      // since-inception (new vaults with no 1-year track record).
      let headlineLabel = "1-Year Return";
      let headlineValue: number | null = roi1Y;
      if (isYield) {
        headlineLabel = "7D APY";
        headlineValue = apy7d;
      } else if (roi1Y == null && roiInception != null) {
        headlineLabel = "Since Inception";
        headlineValue = roiInception;
      }

      return {
        fundId: f.fundId,
        displayName: meta?.displayName ?? f.name,
        symbol: q?.symbol ?? f.share.coin.replace(/^[av]/, ""),
        category,
        fundType: f.fundType,
        blurb: meta?.blurb ?? null,
        isYield,
        price: numOrNull(q?.price),
        changePct: numOrNull(q?.changePct),
        roi1Y,
        roi1M: numOrNull(q?.roi1M),
        roiYtd: numOrNull(q?.roiYtd),
        roiInception,
        apy7d,
        dividendYield: numOrNull(q?.dividendYield),
        nav: numOrNull(f.nav),
        aum: numOrNull(f.aum),
        marketStatus: q?.marketStatus ?? null,
        headlineLabel,
        headlineValue,
        shareCoin: f.share.coin,
        spotSymbol: f.spot?.symbol ?? null,
        investUrl: SODEX_WEALTH_URL,
        newsSeo: meta?.newsSeo ?? null,
        asOf: q?.asOf ?? f.asOf ?? null,
      } satisfies WealthFundView;
    });
}

/** Group catalog rows by category, in display order. */
export function groupByCategory(
  rows: WealthFundView[],
): Array<{ category: WealthCategory; funds: WealthFundView[] }> {
  return CATEGORY_ORDER.map((category) => ({
    category,
    funds: rows.filter((r) => r.category === category),
  })).filter((g) => g.funds.length > 0);
}
