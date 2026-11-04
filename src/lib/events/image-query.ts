/**
 * image-query — turn a classified event into an Unsplash SEARCH QUERY for its
 * hero photo. Keyed off the event's dominant asset/sector + category (and, for
 * security stories, the event type), e.g. "semiconductor chip", "oil refinery",
 * "bitcoin", "stock exchange trading floor", "cybersecurity".
 *
 * Guardrails:
 *   • NEVER a person's name (no queries built from authors/executives) — the
 *     query comes only from the asset/sector/category, which are never people.
 *   • Concept imagery only, so no identifiable individuals are implied.
 * The chosen photo is cached per event server-side, so this runs once per event.
 */

import type { AssetRef, MarketCategory } from "./market-map";

/** The fields of a StreamEvent this mapper reads (kept minimal + client-safe). */
export interface ImageQueryInput {
  event_type: string | null;
  category: MarketCategory;
  tradable: AssetRef[];
  assets: AssetRef[];
}

// ── Sector buckets by base ticker (concept imagery, not logos) ───────────────
const SEMICONDUCTOR = new Set([
  "NVDA", "AMD", "TSM", "INTC", "MU", "ASML", "AVGO", "QCOM", "ARM", "SMCI",
  "MRVL", "SNDK", "KIOXIA", "DRAM", "CXMT", "SAMSUNG",
]);
const EV_AUTO = new Set(["TSLA", "RIVN", "LCID", "NIO", "XPEV", "LI"]);
const BANKS_FIN = new Set(["JPM", "HOOD", "COIN", "PYPL", "SQ"]);
const INTERNET_SW = new Set([
  "META", "GOOGL", "GOOG", "AMZN", "MSFT", "AAPL", "NFLX", "ORCL", "CRM", "ADBE",
  "NOW", "SNOW", "NET", "DDOG", "PANW", "CRWD", "SHOP", "UBER", "ABNB", "RBLX",
]);
const AEROSPACE = new Set(["BA", "SPCX"]);
const BIOTECH = new Set(["MRNA"]);
const QUANTUM = new Set(["RGTI", "QBTS", "IONQ"]);

// Crypto majors get their own term; everything else is generic.
const CRYPTO_TERM: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  XRP: "cryptocurrency coins",
  DOGE: "cryptocurrency coins",
};

// Commodity base → scene.
const COMMODITY_TERM: Record<string, string> = {
  GOLD: "gold bars",
  XAUT: "gold bars",
  SILVER: "silver bars",
  SLV: "silver bars",
  OIL: "oil refinery",
  WTI: "oil refinery",
  CL: "oil refinery",
  BRENT: "oil refinery",
  BRENTOIL: "oil refinery",
  NATGAS: "natural gas pipeline",
  NG: "natural gas pipeline",
  COPPER: "copper mine",
  PLATINUM: "platinum metal",
  PALLADIUM: "platinum metal",
  CORN: "corn field",
  WHEAT: "wheat field",
  SOYBEAN: "soybean field",
  SUGAR: "sugar cane",
  COFFEE: "coffee beans",
};

/** The Unsplash search query for an event's hero photo. */
export function buildImageQuery(ev: ImageQueryInput): string {
  const main = ev.tradable[0] ?? ev.assets[0] ?? null;
  const ticker = (main?.ticker ?? "").toUpperCase();

  // 1. Security stories → security imagery (no asset scene needed).
  if (ev.event_type === "exploit" || ev.event_type === "security") {
    return "cybersecurity data breach";
  }

  // 2. Specific sector by ticker (equities + commodities).
  if (COMMODITY_TERM[ticker]) return COMMODITY_TERM[ticker];
  if (SEMICONDUCTOR.has(ticker)) return "semiconductor chip";
  if (EV_AUTO.has(ticker)) return "electric vehicle charging";
  if (AEROSPACE.has(ticker)) return "aerospace rocket";
  if (BIOTECH.has(ticker)) return "biotech laboratory";
  if (QUANTUM.has(ticker)) return "quantum computer";
  if (BANKS_FIN.has(ticker)) return "modern bank building";
  if (INTERNET_SW.has(ticker)) return "data center servers";

  // 3. Fall back to the broad category.
  switch (ev.category) {
    case "crypto":
      return CRYPTO_TERM[ticker] ?? "cryptocurrency blockchain";
    case "equity":
      return "stock exchange trading floor";
    case "commodity":
      return "commodity raw materials";
    case "index":
      return "stock market display board";
    case "macro":
      // Monetary-policy events lean to central-bank imagery.
      return ev.event_type === "macro"
        ? "federal reserve building"
        : "global economy finance";
    default:
      return "financial markets";
  }
}
