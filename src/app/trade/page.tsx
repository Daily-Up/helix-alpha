import { Shell } from "@/components/layout/Shell";
import { TradeTerminal, type TerminalAsset } from "@/components/trade/TradeTerminal";
import { Assets } from "@/lib/db";
import { Market } from "@/lib/sodex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Order categories in the picker. */
const KIND_RANK: Record<string, number> = {
  token: 0,
  rwa: 1,
  stock: 2,
  index: 3,
  commodity: 4,
  treasury: 5,
  macro: 6,
};

// SoDEX returns no category on its symbols, so classify the base ticker.
// Known stock / commodity / index perps that aren't in the Helix universe are
// listed here; anything unrecognised defaults to crypto.
const STOCKS = new Set([
  "NVDA", "AMZN", "BABA", "TSLA", "AAPL", "MSFT", "GOOGL", "GOOG", "META",
  "MSTR", "COIN", "CRWD", "MRNA", "NBIS", "TSM", "SAMSUNG", "KIOXIA", "SPCX",
  "ZHIPU", "UNITREE", "CXMT", "DRAM", "NFLX", "AMD", "PLTR", "HOOD", "AVGO",
  "ORCL", "SMCI", "ASML", "INTC", "QCOM", "MU", "ARM", "UBER", "SHOP", "DIS",
  "BA", "JPM", "WMT", "COST", "MRVL", "DELL", "IBM", "CSCO", "ADBE", "CRM",
  "NOW", "SNOW", "NET", "DDOG", "PANW", "ANET", "ABNB", "RBLX", "RIVN", "LCID",
  "NIO", "XPEV", "LI", "SOUN", "BBAI", "RGTI", "QBTS", "IONQ", "PYPL", "SQ",
]);
const COMMODITIES = new Set([
  "COPPER", "NATGAS", "SILVER", "GOLD", "PLATINUM", "PALLADIUM", "OIL",
  "BRENT", "WTI", "SLV", "GLD", "USO", "NG", "ALUMINUM", "ZINC", "NICKEL",
  "CORN", "WHEAT", "SOYBEAN", "SUGAR", "COFFEE",
]);
const INDICES = new Set([
  "USTECH100", "US500", "SPX500", "SPX", "NDX", "NAS100", "US30", "DJI",
  "DJIA", "RUT", "RTY", "VIX", "DAX", "FTSE", "NIKKEI", "HSI", "US2000",
]);
function categoryKind(base: string): string {
  const b = base.toUpperCase();
  if (INDICES.has(b)) return "index";
  if (COMMODITIES.has(b)) return "commodity";
  if (STOCKS.has(b)) return "stock";
  return "token";
}

export default async function TradePage() {
  // Perps-only terminal. Build the market list from SoDEX's FULL live perp
  // catalogue (every tradable perp), enriching each with Helix universe data
  // (name / kind / logo) when we have it, and classifying the rest.
  const [all, perpSymbols] = await Promise.all([
    Assets.getAllAssets(),
    Market.getSymbols("perp").catch(() => []),
  ]);

  const byBase = new Map<string, (typeof all)[number]>();
  for (const a of all) {
    const base = a.symbol.toUpperCase();
    if (!byBase.has(base)) byBase.set(base, a);
  }

  const seen = new Set<string>();
  const assets: TerminalAsset[] = perpSymbols
    .filter((s) => !s.status || s.status === "TRADING")
    .map((s): TerminalAsset | null => {
      const perp = (s.name ?? "").toUpperCase(); // e.g. "BTC-USD"
      if (!perp || seen.has(perp)) return null;
      seen.add(perp);
      const base = (s.baseCoin || perp.split("-")[0] || perp).toUpperCase();
      const db = byBase.get(base);
      // Prefer an explicit stock / commodity / index classification over the
      // DB kind (the universe files some of these as "macro"); otherwise take
      // the DB kind, else default to crypto.
      const derived = categoryKind(base);
      const kind = derived !== "token" ? derived : (db?.kind ?? "token");
      return {
        id: db?.id ?? `perp-${perp}`,
        symbol: db?.symbol ?? base,
        name: db?.name ?? s.displayName ?? base,
        kind,
        sodex_symbol: perp,
        market: "perp",
      };
    })
    .filter((a): a is TerminalAsset => a !== null)
    .sort(
      (x, y) =>
        (KIND_RANK[x.kind] ?? 9) - (KIND_RANK[y.kind] ?? 9) ||
        x.symbol.localeCompare(y.symbol),
    );

  return (
    <Shell bleed>
      <TradeTerminal assets={assets} />
    </Shell>
  );
}
