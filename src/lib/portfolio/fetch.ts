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
