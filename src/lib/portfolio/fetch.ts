/**
 * Portfolio data layer — shared SoDEX fetchers + derivations.
 *
 * Isomorphic: every function here uses only `fetch` against SoDEX's public
 * read-only REST (CORS-open), so the same code runs server-side (the
 * equity-snapshot route) and client-side (the portfolio page), exactly like
 * the terminal already reads account state/trades straight from the browser.
 *
 * NO signing, NO order placement — all read-only. Numbers come off the wire as
 * decimal strings; we coerce at the edge.
 */

import { Market, spotGet, baseFor } from "@/lib/sodex";
import type { SodexTicker } from "@/lib/sodex";
import type {
  SodexPerpsAccountState,
  SodexTrade,
  SodexClosedPosition,
} from "@/lib/sodex-onchain/types";

// ── wire shapes not in the shared types ────────────────────────────────────

/** One row of GET /spot/accounts/{addr}/balances. */
export interface SpotBalance {
  id: number;
  coin: string;
  total: string;
  locked: string;
}

/** GET /{market}/accounts/{addr}/fee-rate. No 30d-volume field upstream. */
export interface FeeRate {
  makerFeeRate: number;
  takerFeeRate: number;
  feeTier: number;
  stakingTier: number;
  makerRebateTier: number;
}

const n = (v: unknown): number => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** Account-scoped GET against the perps or spot gateway (spotGet unwraps the
 *  SoDEX `{code,data}` envelope and retries transient failures). */
function accountGet<T>(
  market: "spot" | "perp",
  address: string,
  path: string,
  query?: object,
): Promise<T> {
  return spotGet<T>(`/accounts/${address}/${path}`, {
    baseOverride: baseFor(market),
    query,
  });
}

// ── account state ───────────────────────────────────────────────────────────

/** GET /perps/accounts/{addr}/state — equity (`av`), free margin (`am`),
 *  positions (`P`). A spot-only wallet returns the aid:0 zero-state. */
export async function fetchPerpsState(
  address: string,
): Promise<SodexPerpsAccountState> {
  return accountGet<SodexPerpsAccountState>("perp", address, "state");
}

/** GET /spot/accounts/{addr}/balances — plain holdings (no cost basis). */
export async function fetchSpotBalances(
  address: string,
): Promise<SpotBalance[]> {
  const data = await accountGet<{ balances?: SpotBalance[] }>(
    "spot",
    address,
    "balances",
  );
  return data?.balances ?? [];
}

/** GET /{market}/accounts/{addr}/fee-rate — maker/taker + tier. Best-effort. */
export async function fetchFeeRate(
  address: string,
  market: "spot" | "perp" = "perp",
): Promise<FeeRate | null> {
  try {
    const d = await accountGet<Record<string, unknown>>(
      market,
      address,
      "fee-rate",
    );
    if (!d) return null;
    return {
      makerFeeRate: n(d.makerFeeRate),
      takerFeeRate: n(d.takerFeeRate),
      feeTier: n(d.feeTier),
      stakingTier: n(d.stakingTier),
      makerRebateTier: n(d.makerRebateTier),
    };
  } catch {
    return null;
  }
}

// ── pricing ──────────────────────────────────────────────────────────────────

/** Strip SoDEX's wrapped-spot prefix (vBTC → BTC, wSOSO → SOSO). The convention
 *  is a lowercase `v`/`w` wrapper directly before the real UPPERCASE ticker, so
 *  the next char must be uppercase — that leaves clean names (BTC) and
 *  lowercase-run tokens (wstETH) untouched. */
export function stripWrapper(coin: string): string {
  return /^[vw][A-Z]/.test(coin) ? coin.slice(1) : coin;
}

/** A spot/perps price lookup for valuing holdings. Spot coins price off their
 *  `{wrapped}_vUSDC` pair's last (vBTC_vUSDC, WSOSO_vUSDC); a coin with only a
 *  perp prices off its `{BASE}-USD` mark; the quote stablecoin is $1. */
export interface PriceContext {
  spot: Map<string, number>;
  perps: Map<string, number>;
  /** USD value of `amount` of `coin`, or null if no price is known. */
  priceOf: (coin: string) => number | null;
}

export async function fetchPriceContext(): Promise<PriceContext> {
  const [spotT, perpT] = await Promise.all([
    Market.getTickers("spot").catch(() => [] as SodexTicker[]),
    Market.getTickers("perp").catch(() => [] as SodexTicker[]),
  ]);
  const spot = new Map<string, number>();
  for (const t of spotT) {
    const px = n(t.lastPx);
    if (px > 0) spot.set(t.symbol.toUpperCase(), px);
  }
  const perps = new Map<string, number>();
  for (const t of perpT) {
    const row = t as SodexTicker & { markPrice?: string };
    const px = n(row.markPrice ?? t.lastPx);
    if (px > 0) perps.set(t.symbol.toUpperCase(), px);
  }
  const priceOf = (coin: string): number | null => {
    const raw = coin.toUpperCase();
    const base = stripWrapper(coin).toUpperCase();
    if (base === "USDC" || base === "USD" || base === "USDT") return 1;
    // SoDEX spot pairs are "{wrappedCoin}_vUSDC" — match the wrapped coin
    // directly first (handles both v* and w* wrappers, e.g. WSOSO_vUSDC), then
    // fall back to base-derived forms before trying the perp mark.
    const spotPx =
      spot.get(`${raw}_VUSDC`) ??
      spot.get(`V${base}_VUSDC`) ??
      spot.get(`W${base}_VUSDC`) ??
      spot.get(`${base}_USDC`);
    if (spotPx != null) return spotPx;
    const perpPx = perps.get(`${base}-USD`) ?? perps.get(`${base}-USDC`);
    if (perpPx != null) return perpPx;
    return null;
  };
  return { spot, perps, priceOf };
}

// ── equity composition (route + page) ────────────────────────────────────────

export interface EquityComposition {
  perps_equity: number;
  spot_equity: number;
  total_equity: number;
  perps_upnl: number;
  /** Free collateral on perps (`am`). */
  free_collateral: number;
  /** Notional value of open perp positions (Σ |size| × mark). */
  perps_positions_value: number;
}

/** Perps equity = `av`; spot equity = Σ holding × price; totals + uPnL. The
 *  one derivation both the snapshot route and the overview card rely on.
 *
 *  Errors propagate (not swallowed): a transient SoDEX failure must NOT be
 *  recorded as a $0 snapshot — that would carve a false dip into the equity
 *  curve. The caller (route) 502s and skips the insert; the client keeps its
 *  last-good values. A genuinely empty account is different: a spot-only wallet
 *  gets the perps aid:0 zero-state (av:"0") and a perps-only wallet gets empty
 *  spot balances — both succeed, so both are recorded truthfully. */
export async function computeEquityComposition(
  address: string,
): Promise<EquityComposition> {
  const [state, balances, prices] = await Promise.all([
    fetchPerpsState(address),
    fetchSpotBalances(address),
    fetchPriceContext(),
  ]);

  const perps_equity = state ? n(state.av) : 0;
  const free_collateral = state ? n(state.am) : 0;
  const perps_upnl = perpsUnrealizedPnl(state);
  const perps_positions_value = (state?.P ?? []).reduce((s, p) => {
    const sz = Math.abs(n(p.sz));
    if (sz === 0) return s;
    const mark = prices.perps.get((p.s ?? "").toUpperCase()) ?? n(p.ep);
    return s + sz * mark;
  }, 0);

  let spot_equity = 0;
  for (const b of balances) {
    const total = n(b.total);
    if (total === 0) continue;
    const px = prices.priceOf(b.coin);
    if (px != null) spot_equity += total * px;
  }

  return {
    perps_equity,
    spot_equity,
    total_equity: perps_equity + spot_equity,
    perps_upnl,
    free_collateral,
    perps_positions_value,
  };
}

/** Σ unrealised PnL across open perp positions (signed). */
export function perpsUnrealizedPnl(
  state: SodexPerpsAccountState | null,
): number {
  if (!state?.P) return 0;
  return state.P.reduce((s, p) => s + (p.ur != null ? n(p.ur) : 0), 0);
}

// ── spot holdings table ───────────────────────────────────────────────────────

export interface SpotHolding {
  coin: string;
  /** Display ticker (v-prefix stripped). */
  display: string;
  total: number;
  /** Settled (free) = total − locked. */
  settled: number;
  /** Unsettled (locked). */
  unsettled: number;
  /** USD mark, or null when no price is known. */
  price: number | null;
  /** USD value (total × price), or null. */
  value: number | null;
}

export interface SpotHoldingsResult {
  holdings: SpotHolding[];
  totalValue: number;
}

/** Valued spot holdings for the Spot tab table. Avg-cost / uPnL are not
 *  derivable from SoDEX (plain holdings, no cost basis) — the table shows "—". */
export async function fetchSpotHoldings(
  address: string,
  prices?: PriceContext,
): Promise<SpotHoldingsResult> {
  const [balances, ctx] = await Promise.all([
    fetchSpotBalances(address).catch(() => [] as SpotBalance[]),
    prices ? Promise.resolve(prices) : fetchPriceContext(),
  ]);
  const holdings: SpotHolding[] = [];
  let totalValue = 0;
  for (const b of balances) {
    const total = n(b.total);
    const locked = n(b.locked);
    if (total === 0 && locked === 0) continue;
    const price = ctx.priceOf(b.coin);
    const value = price != null ? total * price : null;
    if (value != null) totalValue += value;
    holdings.push({
      coin: b.coin,
      display: stripWrapper(b.coin).toUpperCase(),
      total,
      settled: Math.max(0, total - locked),
      unsettled: locked,
      price,
      value,
    });
  }
  holdings.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  return { holdings, totalValue };
}

// ── trades: 30d volume, realized PnL, Helix strip ─────────────────────────────

const DAY = 24 * 60 * 60 * 1000;

/** Page an account's fills (newest-first) back to `sinceMs`, bounded by
 *  `maxPages`. SoDEX honours startTime server-side; the final filter guards a
 *  gateway that ignores it. */
async function pageTrades(
  market: "spot" | "perp",
  address: string,
  sinceMs: number,
  maxPages = 6,
): Promise<SodexTrade[]> {
  const PAGE = 200;
  const out: SodexTrade[] = [];
  let endTime: number | undefined;
  for (let i = 0; i < maxPages; i++) {
    let batch: SodexTrade[] = [];
    try {
      batch = await accountGet<SodexTrade[]>(market, address, "trades", {
        limit: PAGE,
        startTime: sinceMs > 0 ? sinceMs : undefined,
        endTime,
      });
    } catch {
      break;
    }
    if (!batch?.length) break;
    out.push(...batch);
    if (batch.length < PAGE) break;
    const oldest = batch[batch.length - 1];
    if (oldest.time <= sinceMs) break;
    endTime = oldest.time - 1;
  }
  return sinceMs > 0 ? out.filter((t) => t.time >= sinceMs) : out;
}

const tradeValue = (t: SodexTrade) => n(t.price) * n(t.quantity);

export interface VolumeBreakdown {
  perps: number;
  spot: number;
  total: number;
}

export interface HelixWindow {
  volume: number;
  fills: number;
  builderFees: number;
}

export interface HelixStripStats {
  d1: HelixWindow;
  w1: HelixWindow;
  all: HelixWindow;
}

export interface TradeStats {
  volume30d: VolumeBreakdown;
  helix: HelixStripStats;
  /** Realized perp PnL over the last 30d (from closed positions). */
  perpsRealized30d: number;
}

const emptyWindow = (): HelixWindow => ({ volume: 0, fills: 0, builderFees: 0 });

function helixWindow(trades: SodexTrade[], sinceMs: number): HelixWindow {
  const w = emptyWindow();
  for (const t of trades) {
    if (!(t.clOrdID ?? "").startsWith("helix-")) continue;
    if (sinceMs > 0 && t.time < sinceMs) continue;
    w.volume += tradeValue(t);
    w.fills += 1;
    w.builderFees += n(t.builderFee);
  }
  return w;
}

/** One trade sweep per market → 30d volume (perps/spot/total), Helix-routed
 *  stats for 1D/1W/All, and realized perp PnL (30d). Helix trades are swept
 *  over a wider (90d) window so the "All" column isn't truncated to 30d. */
export async function fetchTradeStats(address: string): Promise<TradeStats> {
  const now = Date.now();
  const since90 = now - 90 * DAY;
  const since30 = now - 30 * DAY;

  const [perpTrades, spotTrades, closed] = await Promise.all([
    pageTrades("perp", address, since90, 8),
    pageTrades("spot", address, since90, 8),
    fetchClosedPositions(address, since30).catch(
      () => [] as SodexClosedPosition[],
    ),
  ]);

  const in30 = (t: SodexTrade) => t.time >= since30;
  const perpsVol = perpTrades.filter(in30).reduce((s, t) => s + tradeValue(t), 0);
  const spotVol = spotTrades.filter(in30).reduce((s, t) => s + tradeValue(t), 0);

  const allHelix = [...perpTrades, ...spotTrades];
  const helix: HelixStripStats = {
    d1: helixWindow(allHelix, now - DAY),
    w1: helixWindow(allHelix, now - 7 * DAY),
    all: helixWindow(allHelix, 0),
  };

  const perpsRealized30d = closed.reduce(
    (s, p) => s + (p.active ? 0 : n(p.realizedPnL)),
    0,
  );

  return {
    volume30d: { perps: perpsVol, spot: spotVol, total: perpsVol + spotVol },
    helix,
    perpsRealized30d,
  };
}

/** Closed perp positions updated since `sinceMs` (realized-PnL source). */
export async function fetchClosedPositions(
  address: string,
  sinceMs: number,
): Promise<SodexClosedPosition[]> {
  const rows = await accountGet<SodexClosedPosition[]>(
    "perp",
    address,
    "positions/history",
    { limit: 200 },
  );
  return (rows ?? []).filter((p) => !p.active && p.updatedAt >= sinceMs);
}

// ── chart range helper ────────────────────────────────────────────────────────

export type EquityRange = "1D" | "1W" | "1M" | "all";

/** Epoch-ms floor for a chart range (0 = all history). */
export function rangeSince(range: EquityRange, now = Date.now()): number {
  switch (range) {
    case "1D":
      return now - DAY;
    case "1W":
      return now - 7 * DAY;
    case "1M":
      return now - 30 * DAY;
    default:
      return 0;
  }
}

// ── unified balances (SoDEX-style portfolio table) ────────────────────────────
//
// SoDEX's own portfolio composes several public, address-keyed sources — there
// is no single "balances" endpoint. The on-exchange tier we cover here:
//   • GET /spot/accounts/{addr}/balances         → Spot venue
//   • GET /perps/accounts/{addr}/state           → Margin & Futures venue
//                                                   (B[].wb/mr/px/wm, P[].ur)
//   • GET /perps/markets/coins                   → collateral ratio + eligibility
//   • GET wealth.sodex.dev/.../funds             → vault NAVs + fund types
//   • GET wealth.sodex.dev/.../users/{addr}/fund-details → vault holdings
//
// NOT covered (on-chain wallet tokens like un-deposited SOSO, staked sSOSO, and
// the earn APY) — those need the valuechain RPC + staking/earn services; see the
// "on-chain tier" follow-up in docs/PORTFOLIO_PLAN.md. Totals here exclude them.

const WEALTH_BASE = "https://wealth.sodex.dev/api/v1/wealth";

/** Per-coin collateral config from /perps/markets/coins. marginRatio > 0 ⇒
 *  usable as Multi-Asset-Margin collateral (and IS the collateral ratio); "0" ⇒
 *  not eligible. The live source of truth — no hardcoded docs ratio table. */
export interface CoinConfig {
  marginRatio: number;
  price: number | null;
}

/** GET /perps/markets/coins → map keyed by UPPERCASE coin name (VBTC, VQQQ…). */
export async function fetchCoinsConfig(): Promise<Map<string, CoinConfig>> {
  const rows = await spotGet<
    Array<{ id: number; name: string; marginRatio?: string; price?: string }>
  >("/markets/coins", { baseOverride: baseFor("perp") }).catch(() => []);
  const m = new Map<string, CoinConfig>();
  for (const r of rows ?? []) {
    if (!r?.name) continue;
    m.set(r.name.toUpperCase(), {
      marginRatio: n(r.marginRatio),
      price: r.price != null ? n(r.price) : null,
    });
  }
  return m;
}

/** One SoDEX Wealth fund. fundType: "escrow_vault" (true vault, distinct aXXX
 *  share token), "bridged_vault" (e.g. Morpho-Earn → vsoUSDC, already counted in
 *  perps margin) or "clob" (tokenised stock, share coin = the vXXX token itself,
 *  already counted in spot/perps). nav is USD per share (absent for clob). */
export interface WealthFund {
  fundId: string;
  name: string;
  fundType: string;
  nav: number | null;
  shareCoin: string;
}

/** GET wealth/funds → map keyed by fundId. */
export async function fetchWealthFunds(): Promise<Map<string, WealthFund>> {
  const rows = await spotGet<Array<Record<string, unknown>>>("/funds", {
    baseOverride: WEALTH_BASE,
  }).catch(() => []);
  const m = new Map<string, WealthFund>();
  for (const r of rows ?? []) {
    const fundId = String(r.fundId ?? "");
    if (!fundId) continue;
    const share = (r.share ?? {}) as { coin?: string };
    m.set(fundId, {
      fundId,
      name: String(r.name ?? fundId),
      fundType: String(r.fundType ?? ""),
      nav: r.nav != null ? n(r.nav) : null,
      shareCoin: String(share.coin ?? ""),
    });
  }
  return m;
}

export interface WealthHolding {
  fundId: string;
  shareCoin: string;
  shares: number;
}

/** GET wealth/users/{addr}/fund-details → the user's share balance per fund,
 *  plus the fundIds SoDEX itself marks as unavailable (counted elsewhere). */
export async function fetchWealthHoldings(address: string): Promise<{
  holdings: WealthHolding[];
  unavailableFundIds: string[];
}> {
  const d = await spotGet<{
    totals?: Array<Record<string, unknown>>;
    unavailableTotalsFundIds?: string[];
  }>(`/users/${address}/fund-details`, { baseOverride: WEALTH_BASE }).catch(
    () => ({ totals: [], unavailableTotalsFundIds: [] }),
  );
  const holdings: WealthHolding[] = [];
  for (const t of d?.totals ?? []) {
    const share = (t.share ?? {}) as { coin?: string };
    holdings.push({
      fundId: String(t.fundId ?? ""),
      shareCoin: String(share.coin ?? ""),
      shares: n(t.shares),
    });
  }
  return { holdings, unavailableFundIds: d?.unavailableTotalsFundIds ?? [] };
}

/** The account a balance lives in — drives the "(Spot)" / "(Margin & Futures)" /
 *  "(Vault)" row label and the available action set. */
export type BalanceVenue = "Spot" | "Margin & Futures" | "Vault";
export type BalanceAction =
  | "Transfer"
  | "Deposit"
  | "Withdraw"
  | "Subscribe"
  | "Redeem";

export interface VenueBalance {
  venue: BalanceVenue;
  /** Raw on-exchange asset symbol for this venue (vBTC, WSOSO, vsoUSDC, aUNITREE). */
  asset: string;
  /** Display total. For the Margin & Futures quote (USDC) this folds in futures
   *  uPnL so the venue subtotal reconciles to the account's equity (`av`). */
  total: number;
  available: number;
  price: number | null;
  usd: number | null;
  /** Collateral value this balance contributes to margin (= wb × px × mr);
   *  Margin & Futures venue only. */
  collateralValue?: number;
  /** Collateral ratio (haircut) for this venue's asset; Margin & Futures only. */
  ratio?: number;
}

export interface UnifiedHolding {
  /** Display ticker, wrapper stripped (USDC, BTC, SOSO, soUSDC, QQQ, UNITREE). */
  symbol: string;
  /** Symbol to resolve a logo from. */
  logo: string;
  total: number;
  available: number;
  usd: number | null;
  venues: VenueBalance[];
  /** Eligible as multi-asset-margin collateral (coins.marginRatio > 0). */
  multiAssetMargin: boolean;
  /** Currently counting toward margin (held in the perps account with wm > 0). */
  activeAsMargin: boolean;
  /** Collateral ratio to show on the badge, when eligible. */
  marginRatio: number | null;
  /** Fund-like (Subscribe/Redeem) vs plain token (Deposit/Withdraw). */
  actions: BalanceAction[];
}

export interface CollateralAsset {
  symbol: string;
  balance: number;
  price: number;
  ratio: number;
  /** balance × price × ratio. */
  value: number;
}

export interface CollateralBreakdown {
  assets: CollateralAsset[];
  /** Σ value — collateral currently backing margin. */
  total: number;
  /** Free collateral (`am`). */
  freeCollateral: number;
  /** Held in Spot, collateral-eligible, but not yet posted as margin. */
  eligibleNotActive: Array<{ symbol: string; ratio: number }>;
}

export interface PortfolioBalances {
  holdings: UnifiedHolding[];
  /** Σ holdings.usd — the on-exchange + vault total (excludes on-chain/staked). */
  totalUsd: number;
  perpsEquity: number;
  spotEquity: number;
  vaultEquity: number;
  collateral: CollateralBreakdown;
}

/** Strip SoDEX's wrapped-asset prefix for display: vBTC→BTC, WSOSO→SOSO,
 *  vsoUSDC→soUSDC, aUNITREE→UNITREE. */
export function displaySymbol(asset: string): string {
  if (/^v[a-z]/.test(asset)) return asset.slice(1); // vsoUSDC → soUSDC
  if (/^[vw][A-Z0-9]/.test(asset)) return asset.slice(1); // vBTC→BTC, WSOSO→SOSO
  if (/^a[A-Z]/.test(asset)) return asset.slice(1); // aUNITREE→UNITREE
  return asset;
}

/** One sweep of the on-exchange + vault sources → the unified balances model
 *  behind the portfolio's Balances tab, the Overview collateral breakdown, and
 *  the "count every asset once" total. Read-only; errors on any one source are
 *  swallowed so a single outage can't blank the whole table. */
export async function fetchPortfolioBalances(
  address: string,
): Promise<PortfolioBalances> {
  const [spotBalances, perps, coins, funds, wealth, ctx] = await Promise.all([
    fetchSpotBalances(address).catch(() => [] as SpotBalance[]),
    fetchPerpsState(address).catch(() => null),
    fetchCoinsConfig().catch(() => new Map<string, CoinConfig>()),
    fetchWealthFunds().catch(() => new Map<string, WealthFund>()),
    fetchWealthHoldings(address).catch(() => ({
      holdings: [] as WealthHolding[],
      unavailableFundIds: [] as string[],
    })),
    fetchPriceContext().catch(
      () =>
        ({
          spot: new Map(),
          perps: new Map(),
          priceOf: () => null,
        }) as PriceContext,
    ),
  ]);

  // Price for an asset: coins-config index price, then the live perps mark, then
  // the spot/perps ticker fallback; stablecoins are $1.
  const priceFor = (asset: string): number | null => {
    const base = stripWrapper(asset).toUpperCase();
    if (base === "USDC" || base === "USD" || base === "USDT") return 1;
    const cfg = coins.get(asset.toUpperCase());
    if (cfg?.price != null) return cfg.price;
    return ctx.priceOf(asset);
  };

  // Share coins of every Wealth fund — a balance whose symbol is one of these is
  // "fund-like" (Subscribe/Redeem instead of Deposit/Withdraw).
  const fundShareCoins = new Set<string>();
  for (const f of funds.values()) {
    if (f.shareCoin) fundShareCoins.add(f.shareCoin.toUpperCase());
  }

  const bySymbol = new Map<string, UnifiedHolding>();
  const ensure = (asset: string): UnifiedHolding => {
    const symbol = displaySymbol(asset);
    let h = bySymbol.get(symbol);
    if (!h) {
      h = {
        symbol,
        logo: symbol,
        total: 0,
        available: 0,
        usd: null,
        venues: [],
        multiAssetMargin: false,
        activeAsMargin: false,
        marginRatio: null,
        actions: ["Transfer", "Deposit", "Withdraw"],
      };
      bySymbol.set(symbol, h);
    }
    return h;
  };

  // ── Spot venue ──
  let spotEquity = 0;
  for (const b of spotBalances) {
    const total = n(b.total);
    const locked = n(b.locked);
    if (total === 0 && locked === 0) continue;
    const price = priceFor(b.coin);
    const usd = price != null ? total * price : null;
    if (usd != null) spotEquity += usd;
    const h = ensure(b.coin);
    h.venues.push({
      venue: "Spot",
      asset: b.coin,
      total,
      available: Math.max(0, total - locked),
      price,
      usd,
    });
  }

  // ── Margin & Futures venue ──
  const marginAssets = new Set<string>(); // assets with collateral posted
  const marginRowsRef: VenueBalance[] = [];
  let marginGross = 0;
  for (const b of perps?.B ?? []) {
    const wb = n(b.wb);
    if (wb === 0) continue;
    const px = n(b.px) || priceFor(b.a) || 0;
    const mr = n(b.mr);
    const available = b.aw != null ? n(b.aw) : wb;
    const usd = px > 0 ? wb * px : null;
    const collateralValue = b.wm != null ? n(b.wm) : wb * px * mr;
    if (usd != null) marginGross += usd;
    if (collateralValue > 0) marginAssets.add(b.a.toUpperCase());
    const row: VenueBalance = {
      venue: "Margin & Futures",
      asset: b.a,
      total: wb,
      available,
      price: px > 0 ? px : null,
      usd,
      collateralValue,
      ratio: mr,
    };
    marginRowsRef.push(row);
    ensure(b.a).venues.push(row);
  }
  // Fold futures uPnL + any valuation residual into the quote (USDC) margin row,
  // so the Margin & Futures subtotal reconciles to account equity `av` exactly —
  // mirroring how SoDEX attributes uPnL to the USDC line.
  const av = perps ? n(perps.av) : 0;
  let perpsEquity = marginGross;
  if (marginRowsRef.length > 0 && perps) {
    const quote = marginRowsRef.find(
      (r) => stripWrapper(r.asset).toUpperCase() === "USDC",
    );
    if (quote) {
      const residual = av - marginGross; // uPnL + valuation/rounding diff
      quote.total += residual; // USDC is $1, so units == USD
      quote.usd = (quote.usd ?? 0) + residual;
      perpsEquity = av;
    }
  }

  // ── Vault venue (escrow_vault only; dedup against spot/perps) ──
  const spotPerpsAssets = new Set<string>([
    ...spotBalances.map((b) => b.coin.toUpperCase()),
    ...(perps?.B ?? []).map((b) => b.a.toUpperCase()),
  ]);
  let vaultEquity = 0;
  for (const wh of wealth.holdings) {
    if (wh.shares <= 0) continue;
    const fund = funds.get(wh.fundId);
    if (!fund || fund.fundType !== "escrow_vault") continue; // bridged/clob counted elsewhere
    if (wealth.unavailableFundIds.includes(wh.fundId)) continue;
    if (spotPerpsAssets.has(wh.shareCoin.toUpperCase())) continue; // never double-count
    const price = fund.nav;
    const usd = price != null ? wh.shares * price : null;
    if (usd != null) vaultEquity += usd;
    const h = ensure(wh.shareCoin);
    h.venues.push({
      venue: "Vault",
      asset: wh.shareCoin,
      total: wh.shares,
      available: wh.shares,
      price,
      usd,
    });
  }

  // ── Badges, actions, totals per holding ──
  for (const h of bySymbol.values()) {
    let eligibleRatio = 0; // coins-config marginRatio → "Multi-Asset Margin"
    let activeRatio = 0; // perps mr → "Active as margin" (e.g. soUSDC)
    let fundLike = false;
    for (const v of h.venues) {
      const up = v.asset.toUpperCase();
      const cfgR = n(coins.get(up)?.marginRatio);
      if (cfgR > 0) eligibleRatio = Math.max(eligibleRatio, cfgR);
      if (v.venue === "Margin & Futures" && (v.collateralValue ?? 0) > 0) {
        h.activeAsMargin = true;
        if (v.ratio) activeRatio = Math.max(activeRatio, v.ratio);
      }
      if (fundShareCoins.has(up)) fundLike = true;
    }
    h.multiAssetMargin = eligibleRatio > 0;
    // Active assets show the ratio actually backing margin (perps mr); eligible
    // ones show the config ratio.
    h.marginRatio =
      activeRatio > 0 ? activeRatio : eligibleRatio > 0 ? eligibleRatio : null;
    h.actions = fundLike
      ? ["Transfer", "Subscribe", "Redeem"]
      : ["Transfer", "Deposit", "Withdraw"];
    h.total = h.venues.reduce((s, v) => s + v.total, 0);
    h.available = h.venues.reduce((s, v) => s + v.available, 0);
    const usdVals = h.venues.filter((v) => v.usd != null);
    h.usd = usdVals.length ? usdVals.reduce((s, v) => s + (v.usd as number), 0) : null;
    // Vault / Margin sub-rows keep their natural order; Spot first for familiarity.
    h.venues.sort((a, b) => venueRank(a.venue) - venueRank(b.venue));
  }

  const holdings = [...bySymbol.values()].sort(
    (a, b) => (b.usd ?? 0) - (a.usd ?? 0),
  );
  const totalUsd = holdings.reduce((s, h) => s + (h.usd ?? 0), 0);

  // ── Collateral breakdown (Overview) ──
  const collateralAssets: CollateralAsset[] = [];
  for (const b of perps?.B ?? []) {
    const wb = n(b.wb);
    const px = n(b.px);
    const mr = n(b.mr);
    const value = b.wm != null ? n(b.wm) : wb * px * mr;
    if (value <= 0) continue;
    collateralAssets.push({
      symbol: displaySymbol(b.a),
      balance: wb,
      price: px,
      ratio: mr,
      value,
    });
  }
  collateralAssets.sort((a, b) => b.value - a.value);
  const eligibleNotActive: Array<{ symbol: string; ratio: number }> = [];
  for (const b of spotBalances) {
    if (n(b.total) <= 0) continue;
    const up = b.coin.toUpperCase();
    const ratio = n(coins.get(up)?.marginRatio);
    if (ratio > 0 && !marginAssets.has(up))
      eligibleNotActive.push({ symbol: displaySymbol(b.coin), ratio });
  }

  // Dev guard (Task 4): every asset counted exactly once — the row total must
  // reconcile to the sum of the disjoint sources. A soUSDC/vQQQ double-count
  // (vault fund-details on top of perps/spot) would blow this up.
  if (process.env.NODE_ENV !== "production") {
    const parts = spotEquity + perpsEquity + vaultEquity;
    if (Math.abs(totalUsd - parts) > 0.01) {
      console.warn(
        `[portfolio] balances total mismatch: Σrows=${totalUsd} vs ` +
          `spot(${spotEquity})+perps(${perpsEquity})+vault(${vaultEquity})=${parts} — ` +
          "an asset may be double-counted or missed",
      );
    }
  }

  return {
    holdings,
    totalUsd,
    perpsEquity,
    spotEquity,
    vaultEquity,
    collateral: {
      assets: collateralAssets,
      total: collateralAssets.reduce((s, a) => s + a.value, 0),
      freeCollateral: perps ? n(perps.am) : 0,
      eligibleNotActive,
    },
  };
}

function venueRank(v: BalanceVenue): number {
  return v === "Spot" ? 0 : v === "Margin & Futures" ? 1 : 2;
}
