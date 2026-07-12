"use client";

import { fmtAssetSymbol } from "@/lib/format";
import { DataTable, type Column } from "@/components/ui/DataTable";

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

/** Display row — only the fields the migrated table renders. */
interface HRow {
  key: string;
  symbol: string;
  name: string;
  market: string | null;
  weightPct: number;
  driftPct: number | null;
  valueUsd: number;
  pnlUsd: number | null;
  why: string | null;
  isCash?: boolean;
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

  const rows: HRow[] = positions.map((p) => ({
    key: p.asset_id,
    symbol: p.symbol,
    name: p.name,
    market: p.market,
    weightPct: p.current_weight * 100,
    driftPct: (p.current_weight - p.target_weight) * 100,
    valueUsd: p.current_value_usd,
    pnlUsd: p.unrealised_pnl_usd,
    why: p.rationale,
  }));
  rows.push({
    key: "__cash__",
    symbol: "USDC",
    name: "Cash reserve",
    market: null,
    weightPct: cashWeight * 100,
    driftPct: null,
    valueUsd: cashUsd,
    pnlUsd: null,
    why: "cash reserve (configurable in settings)",
    isCash: true,
  });

  // 11 flat columns → 6 role-based. Weight / Drift / P&L now ENCODE their
  // magnitude (bar scaled to the column max), so which holdings dominate and
  // which have drifted off target is skimmable, not computed. Target /
  // Quantity / Avg-Entry / Last-Px folded away — low-variance context.
  const columns: Column<HRow>[] = [
    {
      key: "asset",
      header: "Asset",
      role: "identifier",
      render: (r) => (
        <div className="flex flex-col leading-tight">
          <span className="font-medium text-fg">
            {fmtAssetSymbol(
              r.symbol,
              r.symbol.toLowerCase().startsWith("ssi") ? "index" : undefined,
            )}
            {r.market ? (
              <span className="ml-1.5 text-[9px] uppercase tracking-wider text-fg-dim">
                {r.market}
              </span>
            ) : null}
          </span>
          <span className="text-[10px] text-fg-dim">{r.name}</span>
        </div>
      ),
    },
    { key: "weight", header: "Weight", role: "magnitude", num: (r) => r.weightPct, unit: "%", dp: 1 },
    { key: "drift", header: "Drift", role: "magnitude", num: (r) => r.driftPct, unit: "%", sign: true, dp: 2, tone: "auto" },
    { key: "value", header: "Value", role: "lead", num: (r) => r.valueUsd, unit: "$", compact: true },
    { key: "pnl", header: "P&L", role: "magnitude", num: (r) => r.pnlUsd, unit: "$", sign: true, tone: "auto" },
    {
      key: "why",
      header: "Why",
      role: "context",
      align: "left",
      render: (r) => (
        <span className="whitespace-normal" title={r.why ?? undefined}>
          {r.isCash ? r.why : humanizeRationale(r.why)}
        </span>
      ),
    },
  ];

  return <DataTable columns={columns} rows={rows} getKey={(r) => r.key} minWidth={620} />;
}
