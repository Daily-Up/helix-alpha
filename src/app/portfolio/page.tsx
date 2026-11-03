import { Shell } from "@/components/layout/Shell";
import { PortfolioDashboard } from "@/components/portfolio/PortfolioDashboard";
import { Market } from "@/lib/sodex";
import type { SymbolMeta } from "@/lib/sodex-onchain/useSodexTradeActions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function PortfolioPage() {
  // Per-symbol metadata (tick/step/precision/fee/ID) keyed by sodex symbol, so
  // the Perps tab's TP/SL + cancel work for any open position's market — the
  // same map the trade terminal passes.
  const perpSymbols = await Market.getSymbols("perp").catch(() => []);
  const symbolMeta: Record<string, SymbolMeta> = {};
  for (const s of perpSymbols) {
    const name = (s.name ?? "").toUpperCase();
    if (!name) continue;
    symbolMeta[name] = {
      symbolID: s.id,
      tickSize: Number(s.tickSize) || 0,
      stepSize: Number(s.stepSize) || 0,
      pricePrecision: s.pricePrecision ?? 2,
      quantityPrecision: s.quantityPrecision ?? 5,
      takerFee: Number(s.takerFee) || 0.0004,
    };
  }

  return (
    <Shell>
      <div className="dash-page-enter flex flex-col gap-5">
        <header>
          <h1 className="dash-title">Portfolio</h1>
          <p className="mt-2 dash-description">
            Your live SoDEX portfolio on mainnet — equity, balances, positions
            and Helix-routed activity, scoped to the connected account.
          </p>
        </header>

        <PortfolioDashboard symbolMeta={symbolMeta} />
      </div>
    </Shell>
  );
}
