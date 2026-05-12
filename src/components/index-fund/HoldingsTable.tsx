"use client";

import { Badge } from "@/components/ui/Badge";
import { fmtAssetSymbol, fmtPct, fmtUsd } from "@/lib/format";
import { cn } from "@/components/ui/cn";

/**
 * Turn the rebalance worker's compact driver string
 *   "anchor base 28.0% · 30d 10.0% (×1.12) · 4 signals (×1.12)"
 * into investor-readable prose:
 *   "Core (28%). 30d momentum +10% (boost ×1.12). 4 signals (boost ×1.12)."
 *
 * The (×1.12) multipliers in the source string are the tilt the weighting
 * engine applied; rendering them as "boost ×1.12" / "trim ×0.88" makes the
 * direction explicit. Pure transform — DB row is unchanged.
 */
function humanizeRationale(raw: string | null | undefined): string {
  if (!raw) return "—";
  return raw
    .replace(/\banchor base ([\d.]+)%/i, (_m, pct: string) => `Core (${pct}%)`)
    .replace(
      /\b30d ([\-\d.]+)% \(×([\d.]+)\)/i,
      (_m, ret: string, mult: string) => {
        const r = parseFloat(ret);
        const m = parseFloat(mult);
        const sign = r >= 0 ? "+" : "";
        const tilt =
          m > 1.05 ? ` (boost ×${m.toFixed(2)})` :
          m < 0.95 ? ` (trim ×${m.toFixed(2)})` : "";
        return `30d momentum ${sign}${r.toFixed(1)}%${tilt}`;
      },
    )
    .replace(
      /\b30d ([\-\d.]+)%(?! \()/i,
      (_m, ret: string) => {
        const r = parseFloat(ret);
        const sign = r >= 0 ? "+" : "";
        return `30d momentum ${sign}${r.toFixed(1)}%`;
      },
    )
    // Anchored with \b on BOTH sides so the regex doesn't match
    // "6 signal" greedily (leaving a trailing "s") when the alternation
    // `signals?` permits the shorter form.
    .replace(
      /\b(\d+) signals?\b ?\(×([\d.]+)\)/i,
      (_m, n: string, mult: string) => {
        const m = parseFloat(mult);
        const tilt =
          m > 1.05 ? ` (boost ×${m.toFixed(2)})` :
          m < 0.95 ? ` (trim ×${m.toFixed(2)})` : "";
        return `${n} signal${n === "1" ? "" : "s"}${tilt}`;
      },
    )
    .replace(
      /\b(\d+) signals?\b(?! \(×)/i,
      (_m, n: string) => `${n} signal${n === "1" ? "" : "s"}`,
    )
    .replace(/\s+·\s+/g, ". ")
    .concat(".")
    .replace(/\.\.+$/, ".");
}

export interface PositionView {
  asset_id: string;
  symbol: string;
  name: string;
  sodex_symbol: string;
  market: "spot" | "perp" | null;
  target_weight: number;
  quantity: number;
  avg_entry_price: number | null;
  current_price: number | null;
  current_value_usd: number;
  unrealised_pnl_usd: number | null;
  unrealised_pnl_pct: number | null;
  current_weight: number;
  rationale: string | null;
}

export function HoldingsTable({
  positions,
  cashUsd,
  navTotal,
}: {
  positions: PositionView[];
  cashUsd: number;
  navTotal: number;
}) {
  const cashWeight = navTotal > 0 ? cashUsd / navTotal : 0;

  return (
    <div className="overflow-hidden">
      <table className="w-full">
        <thead className="border-b border-line bg-surface-2">
          <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
            <th className="px-3 py-2 text-left">Asset</th>
            <th className="px-3 py-2 text-left">Mkt</th>
            <th className="px-3 py-2 text-right">Target</th>
            <th className="px-3 py-2 text-right">Current</th>
            <th className="px-3 py-2 text-right">Drift</th>
            <th className="px-3 py-2 text-right">Quantity</th>
            <th className="px-3 py-2 text-right">Avg Entry</th>
            <th className="px-3 py-2 text-right">Last Px</th>
            <th className="px-3 py-2 text-right">Value</th>
            <th className="px-3 py-2 text-right">P&L</th>
            <th className="px-3 py-2 text-left">Why</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {positions.map((p) => {
            const drift = p.current_weight - p.target_weight;
            return (
              <tr
                key={p.asset_id}
                className="text-xs transition-colors hover:bg-surface-2"
              >
                <td className="px-3 py-2">
                  <div className="font-mono font-medium text-fg">
                    {fmtAssetSymbol(
                      p.symbol,
                      p.symbol.toLowerCase().startsWith("ssi") ? "index" : undefined,
                    )}
                  </div>
                  <div className="text-[10px] text-fg-dim">{p.name}</div>
                </td>
                <td className="px-3 py-2">
                  {p.market ? (
                    <Badge tone="default">{p.market.toUpperCase()}</Badge>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="tabular px-3 py-2 text-right text-fg">
                  {(p.target_weight * 100).toFixed(2)}%
                </td>
                <td className="tabular px-3 py-2 text-right text-fg">
                  {(p.current_weight * 100).toFixed(2)}%
                </td>
                <td
                  className={cn(
                    "tabular px-3 py-2 text-right",
                    drift > 0.005
                      ? "text-positive"
                      : drift < -0.005
                        ? "text-negative"
                        : "text-fg-dim",
                  )}
                >
                  {drift >= 0 ? "+" : ""}
                  {(drift * 100).toFixed(2)}%
                </td>
                <td className="tabular px-3 py-2 text-right text-fg-muted">
                  {p.quantity.toFixed(p.quantity < 1 ? 4 : 2)}
                </td>
                <td className="tabular px-3 py-2 text-right text-fg-dim">
                  {p.avg_entry_price != null
                    ? `$${p.avg_entry_price.toFixed(p.avg_entry_price < 1 ? 4 : 2)}`
                    : "—"}
                </td>
                <td className="tabular px-3 py-2 text-right text-fg">
                  {p.current_price != null
                    ? `$${p.current_price.toFixed(p.current_price < 1 ? 4 : 2)}`
                    : "—"}
                </td>
                <td className="tabular px-3 py-2 text-right font-medium text-fg">
                  {fmtUsd(p.current_value_usd)}
                </td>
                <td
                  className={cn(
                    "tabular px-3 py-2 text-right",
                    (p.unrealised_pnl_usd ?? 0) > 0
                      ? "text-positive"
                      : (p.unrealised_pnl_usd ?? 0) < 0
                        ? "text-negative"
                        : "text-fg-muted",
                  )}
                >
                  {p.unrealised_pnl_usd != null
                    ? fmtUsd(p.unrealised_pnl_usd)
                    : "—"}
                  {p.unrealised_pnl_pct != null ? (
                    <div className="text-[10px] font-normal">
                      {fmtPct(p.unrealised_pnl_pct)}
                    </div>
                  ) : null}
                </td>
                <td
                  className="px-3 py-2 align-top text-[11px] leading-snug text-fg-muted"
                  style={{ minWidth: "14rem", maxWidth: "22rem" }}
                >
                  {p.rationale ? (
                    <span
                      className="whitespace-normal"
                      title={p.rationale}
                    >
                      {humanizeRationale(p.rationale)}
                    </span>
                  ) : (
                    <span className="text-fg-dim">—</span>
                  )}
                </td>
              </tr>
            );
          })}
          {/* Cash row */}
          <tr className="text-xs bg-surface-2/30">
            <td className="px-3 py-2">
              <div className="font-mono font-medium text-fg">USDC</div>
              <div className="text-[10px] text-fg-dim">Cash reserve</div>
            </td>
            <td className="px-3 py-2">
              <Badge tone="default">CASH</Badge>
            </td>
            <td className="px-3 py-2 text-right text-fg-muted">—</td>
            <td className="tabular px-3 py-2 text-right text-fg">
              {(cashWeight * 100).toFixed(2)}%
            </td>
            <td className="px-3 py-2 text-right text-fg-dim">—</td>
            <td className="px-3 py-2 text-right text-fg-muted">—</td>
            <td className="px-3 py-2 text-right text-fg-dim">—</td>
            <td className="tabular px-3 py-2 text-right text-fg">$1.00</td>
            <td className="tabular px-3 py-2 text-right font-medium text-fg">
              {fmtUsd(cashUsd)}
            </td>
            <td className="px-3 py-2 text-right text-fg-dim">—</td>
            <td className="px-3 py-2 text-[11px] text-fg-dim">
              cash reserve (configurable in settings)
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
