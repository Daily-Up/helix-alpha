import { Shell } from "@/components/layout/Shell";
import { TradeTerminal, type TerminalAsset } from "@/components/trade/TradeTerminal";
import { Assets } from "@/lib/db";

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
  const all = await Assets.getAllAssets();
  const assets: TerminalAsset[] = all
    .filter((a) => a.tradable)
    .map((a) => ({
      id: a.id,
      symbol: a.symbol,
      name: a.name,
      kind: a.kind,
      sodex_symbol: a.tradable?.symbol ?? null,
      market: a.tradable?.market ?? null,
    }))
    .sort(
      (x, y) =>
        (KIND_RANK[x.kind] ?? 9) - (KIND_RANK[y.kind] ?? 9) ||
        x.symbol.localeCompare(y.symbol),
    );

  return (
    <Shell>
      <div className="dash-page-enter flex flex-col gap-5">
        <header>
          <h1 className="dash-title">Trade Terminal</h1>
          <p className="mt-2 dash-description">
            Pick an asset and run a Setup — Helix reads the latest SoSoValue
            news and price action and calls the bias, the levels, and the
            reasoning. Then trade it live on SoDEX. Every setup cites the
            headlines behind it.
          </p>
        </header>

        <TradeTerminal assets={assets} />
      </div>
    </Shell>
  );
}
