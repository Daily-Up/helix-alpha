import { Shell } from "@/components/layout/Shell";
import { TradeTerminal, type TerminalAsset } from "@/components/trade/TradeTerminal";
import { Assets } from "@/lib/db";
import { Market } from "@/lib/sodex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Order assets for the picker: crypto first, then equities, then indices. */
const KIND_RANK: Record<string, number> = {
  token: 0,
  rwa: 1,
  stock: 2,
  index: 3,
  treasury: 4,
  macro: 5,
};

export default async function TradePage() {
  // Perps-only terminal. Pull SoDEX's live perp symbol list so we can route
  // every asset to its perp market — including the crypto majors the universe
  // maps to spot (BTC → BTC-USD), not just the ones already perp-mapped.
  const [all, perpSymbols] = await Promise.all([
    Assets.getAllAssets(),
    Market.getSymbols("perp").catch(() => []),
  ]);
  const perpSet = new Set(perpSymbols.map((s) => s.name.toUpperCase()));

  const seen = new Set<string>();
  const assets: TerminalAsset[] = all
    .map((a): TerminalAsset | null => {
      // Prefer an existing perp mapping; otherwise try "<SYMBOL>-USD".
      let perp: string | null = null;
      if (a.tradable?.market === "perp") perp = a.tradable.symbol;
      else {
        const cand = `${a.symbol.toUpperCase()}-USD`;
        if (perpSet.has(cand)) perp = cand;
      }
      if (!perp) return null;
      // De-dupe when two assets resolve to the same perp (e.g. tok/rwa ONDO).
      if (seen.has(perp)) return null;
      seen.add(perp);
      return {
        id: a.id,
        symbol: a.symbol,
        name: a.name,
        kind: a.kind,
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
