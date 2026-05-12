/**
 * Default asset universe — what SosoAlpha tracks out of the box.
 *
 * Every asset has a SoSoValue routing hint (for analysis data). A subset
 * also has a `tradable` SoDEX symbol (for AlphaTrade execution).
 *
 * Symbols here are LOGICAL — currency_ids for tokens are resolved at
 * runtime by `resolveCurrencyId()`. ETF/stock/index/treasury tickers are
 * passed directly to the per-ticker endpoints. SoDEX symbols are
 * hand-mapped (verified via `npm run inspect:sodex`).
 */

import type { Asset, SodexTradable } from "./types";
import { AssetKind } from "./types";

// ─────────────────────────────────────────────────────────────────────────
// Helpers — keep declarations terse.
// ─────────────────────────────────────────────────────────────────────────

/** Helper: build a SoDEX spot tradable hint. */
const sx = (
  symbol: string,
  base: string,
  status: "TRADING" | "HALT" = "TRADING",
): SodexTradable => ({
  symbol,
  market: "spot",
  base,
  quote: "vUSDC",
  status,
});

/** Helper: build a SoDEX perpetual tradable hint. */
const px = (
  symbol: string,
  base: string,
  status: "TRADING" | "HALT" = "TRADING",
): SodexTradable => ({
  symbol,
  market: "perp",
  base,
  quote: "USD",
  status,
});

const token = (
  symbol: string,
  name: string,
  tags: Asset["tags"] = [],
  rank?: number,
  tradable?: SodexTradable,
): Asset => ({
  id: `tok-${symbol.toLowerCase()}`,
  symbol,
  name,
  kind: AssetKind.Token,
  tags,
  sosovalue: { kind: "token", currency_id: "", symbol: symbol.toLowerCase() },
  tradable,
  rank,
});

const rwa = (
  symbol: string,
  name: string,
  tags: Asset["tags"] = ["RWA"],
  tradable?: SodexTradable,
): Asset => ({
  id: `rwa-${symbol.toLowerCase()}`,
  symbol,
  name,
  kind: AssetKind.RWA,
  tags,
  sosovalue: { kind: "rwa", currency_id: "", symbol: symbol.toLowerCase() },
  tradable,
});

const etfFund = (
  ticker: string,
  name: string,
  underlying: string,
  country_code = "US",
): Asset => ({
  id: `etf-${ticker.toLowerCase()}`,
  symbol: ticker,
  name,
  kind: AssetKind.ETFFund,
  tags: [],
  sosovalue: { kind: "etf_fund", ticker, underlying, country_code },
});

const etfAgg = (symbol: string, country_code = "US"): Asset => ({
  id: `etfagg-${symbol.toLowerCase()}-${country_code.toLowerCase()}`,
  symbol: `${symbol}-ETF-${country_code}`,
  name: `${symbol} Spot ETFs (${country_code})`,
  kind: AssetKind.ETFAggregate,
  tags: [],
  sosovalue: { kind: "etf_aggregate", symbol, country_code },
});

const stock = (
  ticker: string,
  name: string,
  tags: Asset["tags"] = [],
  tradable?: SodexTradable,
): Asset => ({
  id: `stk-${ticker.toLowerCase()}`,
  symbol: ticker,
  name,
  kind: AssetKind.Stock,
  tags,
  sosovalue: { kind: "stock", ticker },
  tradable,
});

const treasury = (
  ticker: string,
  name: string,
  tags: Asset["tags"] = ["Treasury"],
): Asset => ({
  id: `trs-${ticker.toLowerCase()}`,
  symbol: ticker,
  name,
  kind: AssetKind.Treasury,
  tags,
  sosovalue: { kind: "treasury", ticker },
});

const index = (
  ticker: string,
  name: string,
  tags: Asset["tags"] = [],
  tradable?: SodexTradable,
): Asset => ({
  id: `idx-${ticker.toLowerCase()}`,
  symbol: ticker,
  name,
  kind: AssetKind.Index,
  tags,
  sosovalue: { kind: "index", ticker },
  tradable,
});

const macro = (event: string, tags: Asset["tags"] = ["Macro"]): Asset => ({
  id: `mac-${event.toLowerCase().replace(/\s+/g, "-")}`,
  symbol: event,
  name: event,
  kind: AssetKind.Macro,
  tags,
  sosovalue: { kind: "macro", event },
});

// ─────────────────────────────────────────────────────────────────────────
// The default universe
// ─────────────────────────────────────────────────────────────────────────

export const DEFAULT_UNIVERSE: Asset[] = [
  // ── Crypto majors ─────────────────────────────────────────────
  // Tradable SoDEX pairs are wired in via the 5th arg.
  token("BTC", "Bitcoin", ["majors", "L1"], 100, sx("vBTC_vUSDC", "vBTC")),
  token("ETH", "Ethereum", ["majors", "L1"], 99, sx("vETH_vUSDC", "vETH")),
  token("SOL", "Solana", ["majors", "L1"], 95, sx("vSOL_vUSDC", "vSOL")),
  token("XRP", "XRP", ["majors"], 90, sx("vXRP_vUSDC", "vXRP")),
  token("BNB", "BNB", ["majors", "L1"], 88, sx("vBNB_vUSDC", "vBNB")),
  token("DOGE", "Dogecoin", ["majors", "Meme"], 85, sx("vDOGE_vUSDC", "vDOGE")),
  token("HYPE", "Hyperliquid", ["DeFi"], 84, sx("vHYPE_vUSDC", "vHYPE")),
  token("AVAX", "Avalanche", ["L1"], 82, sx("vAVAX_vUSDC", "vAVAX")),
  token("LINK", "Chainlink", [], undefined, sx("vLINK_vUSDC", "vLINK")),
  token("TON", "Toncoin", ["L1"], undefined, sx("vTON_vUSDC", "vTON")),
  token("ADA", "Cardano", ["L1"], undefined, sx("vADA_vUSDC", "vADA")),
  token("SUI", "Sui", ["L1"], undefined, sx("vSUI_vUSDC", "vSUI")),
  token("LTC", "Litecoin", [], undefined, sx("vLTC_vUSDC", "vLTC")),
  token("XLM", "Stellar", [], undefined, sx("vXLM_vUSDC", "vXLM")),
  // Tradable as PERPETUAL on SoDEX (no spot pair).
  token("TRX", "TRON", ["L1"], undefined, px("TRX-USD", "TRX")),
  token("NEAR", "NEAR Protocol", ["L1"], undefined, px("NEAR-USD", "NEAR")),
  token("APT", "Aptos", ["L1"], undefined, px("APT-USD", "APT")),
  token("HBAR", "Hedera", ["L1"], undefined, px("HBAR-USD", "HBAR")),
  // Analysis-only L1s
  token("ATOM", "Cosmos", ["L1"]),
  token("INJ", "Injective", ["L1"]),
  token("TIA", "Celestia", ["L1"]),
  // Perp-only legacy crypto
  token("BCH", "Bitcoin Cash", [], undefined, px("BCH-USD", "BCH")),
  token("ETC", "Ethereum Classic", [], undefined, px("ETC-USD", "ETC")),
  token("FIL", "Filecoin", [], undefined, px("FIL-USD", "FIL")),
  token("XMR", "Monero", [], undefined, px("XMR-USD", "XMR")),
  token("DASH", "Dash", [], undefined, px("DASH-USD", "DASH")),
  token("AXS", "Axie Infinity", [], undefined, px("AXS-USD", "AXS")),
  token("CHZ", "Chiliz", [], undefined, px("CHZ-USD", "CHZ")),
  token("WLD", "Worldcoin", [], undefined, px("WLD-USD", "WLD")),

  // ── L2s ────────────────────────────────────────────────────────
  token("ARB", "Arbitrum", ["L2"], undefined, sx("vARB_vUSDC", "vARB")),
  token("OP", "Optimism", ["L2"], undefined, px("OP-USD", "OP")),
  token("MNT", "Mantle", ["L2"]),

  // ── DeFi blue chips ────────────────────────────────────────────
  token("UNI", "Uniswap", ["DeFi"], undefined, sx("vUNI_vUSDC", "vUNI")),
  token("AAVE", "Aave", ["DeFi"], undefined, sx("vAAVE_vUSDC", "vAAVE")),
  token("MKR", "Maker", ["DeFi"]),
  token("LDO", "Lido DAO", ["DeFi"]),
  token("PENDLE", "Pendle", ["DeFi"]),
  token("ENA", "Ethena", ["DeFi"], undefined, px("ENA-USD", "ENA")),
  token("ONDO", "Ondo Finance", ["DeFi", "RWA"], undefined, px("ONDO-USD", "ONDO")),

  // ── AI / Meme narratives (most tradable on perps) ──────────────
  token("TAO", "Bittensor", ["AI"], undefined, px("TAO-USD", "TAO")),
  token("VIRTUAL", "Virtuals Protocol", ["AI"], undefined, px("VIRTUAL-USD", "VIRTUAL")),
  token("PEPE", "Pepe", ["Meme"], undefined, sx("vPEPE_vUSDC", "vPEPE")),
  token("SHIB", "Shiba Inu", ["Meme"], undefined, sx("vSHIB_vUSDC", "vSHIB")),
  token("WIF", "dogwifhat", ["Meme"], undefined, px("WIF-USD", "WIF")),
  token("BONK", "Bonk (1000BONK perp)", ["Meme"], undefined, px("1000BONK-USD", "1000BONK")),
  token("FARTCOIN", "Fartcoin", ["Meme"], undefined, px("FARTCOIN-USD", "FARTCOIN")),
  token("TRUMP", "Official Trump", ["Meme"], undefined, px("TRUMP-USD", "TRUMP")),
  token("PENGU", "Pudgy Penguins", ["Meme"], undefined, px("PENGU-USD", "PENGU")),
  token("PUMP", "Pump.fun", ["Meme"], undefined, px("PUMP-USD", "PUMP")),
  token("WLFI", "World Liberty Financial", ["Meme"], undefined, px("WLFI-USD", "WLFI")),

  // ── Tokenised RWA / commodities ────────────────────────────────
  // Stablecoins & gold tokens — XAUT is liquid-tradable on SoDEX.
  rwa(
    "XAUT",
    "Tether Gold",
    ["RWA"],
    sx("vXAUt_vUSDC", "vXAUt"),
  ),
  rwa("PAXG", "PAX Gold"),
  rwa("ONDO", "Ondo Finance"),
  rwa("USDS", "USDS Stablecoin", ["Stablecoin"]),
  rwa(
    "USDT",
    "Tether USD",
    ["Stablecoin"],
    sx("vUSDT_vUSDC", "vUSDT"),
  ),

  // ── SoSoValue platform token ──────────────────────────────────
  token(
    "WSOSO",
    "Wrapped SOSO",
    [],
    undefined,
    sx("WSOSO_vUSDC", "WSOSO"),
  ),

  // ── ETF aggregates (per-asset US flows) ────────────────────────
  etfAgg("BTC"),
  etfAgg("ETH"),
  etfAgg("SOL"),
  etfAgg("XRP"),
  etfAgg("DOGE"),
  etfAgg("LINK"),
  etfAgg("LTC"),
  etfAgg("HBAR"),
  etfAgg("AVAX"),
  etfAgg("DOT"),

  // ── ETF individual funds (BTC) ─────────────────────────────────
  etfFund("IBIT", "iShares Bitcoin Trust", "BTC"),
  etfFund("FBTC", "Fidelity Wise Origin Bitcoin Fund", "BTC"),
  etfFund("GBTC", "Grayscale Bitcoin Trust", "BTC"),
  etfFund("ARKB", "ARK 21Shares Bitcoin ETF", "BTC"),
  etfFund("BITB", "Bitwise Bitcoin ETF", "BTC"),
  etfFund("HODL", "VanEck Bitcoin Trust", "BTC"),

  // ── ETF individual funds (ETH) ─────────────────────────────────
  etfFund("ETHA", "iShares Ethereum Trust", "ETH"),
  etfFund("FETH", "Fidelity Ethereum Fund", "ETH"),
  etfFund("ETHE", "Grayscale Ethereum Trust", "ETH"),
  etfFund("ETHW", "Bitwise Ethereum ETF", "ETH"),

  // ── Crypto stocks ──────────────────────────────────────────────
  // Many of these ARE tradable on SoDEX perpetuals (COIN-USD, HOOD-USD,
  // CRCL-USD, MSTR-USD, etc.) — see px() entries below. PYPL/BLOCK/MARA
  // /RIOT are research-only.
  stock("COIN", "Coinbase Global", ["Exchange"], px("COIN-USD", "COIN")),
  stock("HOOD", "Robinhood Markets", ["Exchange"], px("HOOD-USD", "HOOD")),
  stock("PYPL", "PayPal Holdings", ["Exchange"]),
  stock("BLOCK", "Block Inc", ["Exchange"]),
  stock("CRCL", "Circle Internet Group", ["Stablecoin"], px("CRCL-USD", "CRCL")),
  stock("RIOT", "Riot Platforms", ["Mining"]),
  stock("MARA", "MARA Holdings", ["Mining"]),
  stock("CIFR", "Cipher Mining", ["Mining"]),
  stock("IREN", "IREN Limited", ["Mining"]),
  stock("WULF", "TeraWulf", ["Mining"]),
  stock("HUT", "Hut 8 Mining", ["Mining"]),

  // ── Tokenized US equities (use PERPS — they're always-on, vs spot HALT) ──
  // We prefer perps for these because the spot markets HALT outside
  // US trading hours; perps trade 24/7.
  stock("AAPL", "Apple", [], px("AAPL-USD", "AAPL")),
  stock("TSLA", "Tesla", [], px("TSLA-USD", "TSLA")),
  stock("GOOGL", "Alphabet", [], px("GOOGL-USD", "GOOGL")),
  stock("MSFT", "Microsoft", [], px("MSFT-USD", "MSFT")),
  stock("AMZN", "Amazon", [], px("AMZN-USD", "AMZN")),
  stock("NVDA", "NVIDIA", [], px("NVDA-USD", "NVDA")),
  stock("META", "Meta Platforms", [], px("META-USD", "META")),
  // Additional perp-only equities
  stock("AMD", "AMD", ["Mining"], px("AMD-USD", "AMD")),
  stock("INTC", "Intel", [], px("INTC-USD", "INTC")),
  stock("MU", "Micron", [], px("MU-USD", "MU")),
  stock("ORCL", "Oracle", [], px("ORCL-USD", "ORCL")),
  stock("PLTR", "Palantir", [], px("PLTR-USD", "PLTR")),
  stock("TSM", "TSMC", [], px("TSM-USD", "TSM")),

  // ── BTC treasury companies ─────────────────────────────────────
  // MSTR is BOTH a treasury and tradable as a perp (MSTR-USD).
  // We mark the perp on the treasury entry so signals on MSTR earnings/
  // BTC purchases route to a tradable instrument.
  {
    id: "trs-mstr",
    symbol: "MSTR",
    name: "Strategy (MicroStrategy)",
    kind: AssetKind.Treasury,
    tags: ["Treasury"] as Asset["tags"],
    sosovalue: { kind: "treasury" as const, ticker: "MSTR" },
    tradable: px("MSTR-USD", "MSTR"),
  } satisfies Asset,
  treasury("TSLA-TR", "Tesla Treasury"),
  treasury("XYZ", "Block (formerly Square)"),
  treasury("GME", "GameStop"),

  // ── SSI sector indexes (analysis only) ────────────────────────
  index("ssimag7", "SoSoValue Magnificent 7 Index"),
  index("ssicefi", "SoSoValue CeFi Index"),
  index("ssidefi", "SoSoValue DeFi Index"),
  index("ssipayfi", "SoSoValue PayFi Index"),
  index("ssimeme", "SoSoValue Meme Index"),
  index("ssiai", "SoSoValue AI Index"),
  index("ssirwa", "SoSoValue RWA Index"),
  index("ssinft", "SoSoValue NFT Index"),
  index("ssisocialfi", "SoSoValue SocialFi Index"),
  index("ssilayer1", "SoSoValue Layer1 Index"),
  index("ssilayer2", "SoSoValue Layer2 Index"),
  index("ssidepin", "SoSoValue DePIN Index"),
  index("ssigamefi", "SoSoValue GameFi Index"),

  // ── Liquid SSI tokens tradable on SoDEX ───────────────────────
  // Note: ticker on SoSoValue side (lowercase "ssimag7") is different
  // from the SoDEX trading pair (vMAG7ssi_vUSDC). We use ssi-prefixed
  // ids and store the SoDEX symbol explicitly.
  index(
    "ssimag7",
    "MAG7.ssi (Magnificent 7 Index)",
    [],
    sx("vMAG7ssi_vUSDC", "vMAG7.ssi"),
  ),
  index(
    "ssidefi",
    "DEFI.ssi (DeFi Sector Index)",
    [],
    sx("vDEFIssi_vUSDC", "vDEFI.ssi"),
  ),
  index(
    "ssimeme",
    "MEME.ssi (Meme Sector Index)",
    [],
    sx("vMEMEssi_vUSDC", "vMEME.ssi"),
  ),
  index(
    "ussi",
    "USSI (Universe SoSoValue Index)",
    [],
    sx("vUSSI_vUSDC", "vUSSI"),
  ),

  // ── Macro indicators (calendar events — not directly tradable) ─
  macro("CPI"),
  macro("Core CPI"),
  macro("Nonfarm Payrolls"),
  macro("FOMC"),
  macro("PPI"),
  macro("Existing Home Sales"),
  macro("ISM Manufacturing PMI"),
  macro("ISM Non-Manufacturing PMI"),

  // ── Commodities & equity-index perps (SoDEX perpetuals) ─────────
  // These let macro / commodity / equity news get routed to a tradable
  // instrument — e.g. an oil price spike → trade CL-USD, an S&P move →
  // trade US500-USD. Stored as `kind=index` for unified handling.
  {
    id: "perp-cl",
    symbol: "CL",
    name: "Crude Oil (WTI)",
    kind: AssetKind.Index,
    tags: ["Macro"] as Asset["tags"],
    sosovalue: { kind: "macro" as const, event: "Crude Oil" },
    tradable: px("CL-USD", "CL"),
  } satisfies Asset,
  {
    id: "perp-silver",
    symbol: "SILVER",
    name: "Silver",
    kind: AssetKind.Index,
    tags: ["Macro"] as Asset["tags"],
    sosovalue: { kind: "macro" as const, event: "Silver" },
    tradable: px("SILVER-USD", "SILVER"),
  } satisfies Asset,
  {
    id: "perp-copper",
    symbol: "COPPER",
    name: "Copper",
    kind: AssetKind.Index,
    tags: ["Macro"] as Asset["tags"],
    sosovalue: { kind: "macro" as const, event: "Copper" },
    tradable: px("COPPER-USD", "COPPER"),
  } satisfies Asset,
  {
    id: "perp-natgas",
    symbol: "NATGAS",
    name: "Natural Gas",
    kind: AssetKind.Index,
    tags: ["Macro"] as Asset["tags"],
    sosovalue: { kind: "macro" as const, event: "Natural Gas" },
    tradable: px("NATGAS-USD", "NATGAS"),
  } satisfies Asset,
  {
    id: "perp-us500",
    symbol: "US500",
    name: "S&P 500 Index",
    kind: AssetKind.Index,
    tags: ["Macro"] as Asset["tags"],
    sosovalue: { kind: "macro" as const, event: "S&P 500" },
    tradable: px("US500-USD", "US500"),
  } satisfies Asset,
  {
    id: "perp-ustech100",
    symbol: "USTECH100",
    name: "Nasdaq 100 Index",
    kind: AssetKind.Index,
    tags: ["Macro"] as Asset["tags"],
    sosovalue: { kind: "macro" as const, event: "Nasdaq 100" },
    tradable: px("USTECH100-USD", "USTECH100"),
  } satisfies Asset,
];

// Deduplicate by id — the SSI indexes are listed twice (once analysis-only,
// once with SoDEX tradable hint) for readability. The SoDEX-marked entries
// win, since they have strictly more info.
const _seen = new Map<string, Asset>();
for (const a of DEFAULT_UNIVERSE) {
  const existing = _seen.get(a.id);
  if (!existing || (a.tradable && !existing.tradable)) {
    _seen.set(a.id, a);
  }
}
const _deduped = Array.from(_seen.values());
DEFAULT_UNIVERSE.length = 0;
DEFAULT_UNIVERSE.push(..._deduped);

/** Quick lookup helpers. */

export function findAsset(idOrSymbol: string): Asset | undefined {
  const lower = idOrSymbol.toLowerCase();
  return (
    DEFAULT_UNIVERSE.find((a) => a.id === lower) ??
    DEFAULT_UNIVERSE.find((a) => a.symbol.toLowerCase() === lower)
  );
}

export function assetsByKind(kind: Asset["kind"]): Asset[] {
  return DEFAULT_UNIVERSE.filter((a) => a.kind === kind);
}

export function assetsByTag(tag: Asset["tags"][number]): Asset[] {
  return DEFAULT_UNIVERSE.filter((a) => a.tags.includes(tag));
}

/** Only tradable assets (have a SoDEX pair). Used by AlphaTrade. */
export function tradableAssets(): Asset[] {
  return DEFAULT_UNIVERSE.filter((a) => !!a.tradable);
}
