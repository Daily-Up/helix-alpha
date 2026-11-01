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
      <div className="dash-page-enter flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h1 className="font-[var(--font-jetbrains-mono)] text-[11px] uppercase tracking-[0.18em] text-fg-dim">
            Trade Terminal · Live on SoDEX
          </h1>
          <span className="text-[11px] text-fg-dim">
            News-grounded setups · one-signature execution
          </span>
        </div>

        <TradeTerminal assets={assets} />
      </div>
    </Shell>
  );
}
