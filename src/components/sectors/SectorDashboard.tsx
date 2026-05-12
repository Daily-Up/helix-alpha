"use client";

import { useEffect, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { fmtFracPct, fmtRelative } from "@/lib/format";
import { cn } from "@/components/ui/cn";

interface SectorRow {
  snapshot_at: number;
  sector_name: string;
  change_pct_24h: number | null;
  marketcap_dom: number | null;
}

interface IndexRow {
  ticker: string;
  name: string;
  price: number | null;
  change_pct_24h: number | null;
  roi_7d: number | null;
  roi_1m: number | null;
  roi_3m: number | null;
  roi_1y: number | null;
  ytd: number | null;
}

interface Response {
  sectors: SectorRow[];
  indices: IndexRow[];
}

export function SectorDashboard() {
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/data/sectors")
      .then((r) => r.json())
      .then((d: Response) => setData(d))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="rounded border border-line bg-surface p-6 text-center text-sm text-fg-muted">
        Loading sectors…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Sector dominance bars */}
      <Card>
        <CardHeader>
          <CardTitle>Sector Dominance · Right Now</CardTitle>
          <span className="text-xs text-fg-muted">
            {data?.sectors.length ?? 0} sectors · sorted by dominance
          </span>
        </CardHeader>
        <CardBody>
          <SectorDominance sectors={data?.sectors ?? []} />
        </CardBody>
      </Card>

      {/* SSI index momentum */}
      <Card>
        <CardHeader>
          <CardTitle>Narrative Cycle · SSI Index Momentum</CardTitle>
          <span className="text-xs text-fg-muted">
            {data?.indices.length ?? 0} sector indexes · live
          </span>
        </CardHeader>
        <CardBody className="p-0">
          <IndexMomentumTable indices={data?.indices ?? []} />
        </CardBody>
      </Card>
    </div>
  );
}

/** Horizontal bars showing each sector's market-cap dominance + 24h change. */
function SectorDominance({ sectors }: { sectors: SectorRow[] }) {
  if (sectors.length === 0) {
    return (
      <div className="text-center text-sm text-fg-muted">
        No sector snapshots yet — run{" "}
        <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">
          npm run ingest:all
        </code>
      </div>
    );
  }

  const sorted = [...sectors].sort(
    (a, b) => (b.marketcap_dom ?? 0) - (a.marketcap_dom ?? 0),
  );
  const maxDom = Math.max(...sorted.map((s) => s.marketcap_dom ?? 0), 0.01);

  return (
    <div className="flex flex-col gap-1.5">
      {sorted.map((s) => {
        const dom = s.marketcap_dom ?? 0;
        const widthPct = (dom / maxDom) * 100;
        const change = s.change_pct_24h ?? 0;
        const tone =
          change > 0.005
            ? "bg-positive/40"
            : change < -0.005
              ? "bg-negative/40"
              : "bg-line-2";
        return (
          <div
            key={s.sector_name}
            className="grid grid-cols-[100px_1fr_70px_70px] items-center gap-3 text-xs"
          >
            <span className="font-medium text-fg">{s.sector_name}</span>
            <div className="relative h-5 overflow-hidden rounded bg-surface-2">
              <div
                className={cn("h-full rounded transition-all", tone)}
                style={{ width: `${widthPct}%` }}
              />
            </div>
            <span className="tabular text-right text-fg-muted">
              {(dom * 100).toFixed(2)}%
            </span>
            <span
              className={cn(
                "tabular text-right tabular-nums",
                change > 0
                  ? "text-positive"
                  : change < 0
                    ? "text-negative"
                    : "text-fg-muted",
              )}
            >
              {fmtFracPct(change)}
            </span>
          </div>
        );
      })}
      <div className="mt-2 grid grid-cols-[100px_1fr_70px_70px] gap-3 px-0.5 text-[10px] uppercase tracking-wider text-fg-dim">
        <span>Sector</span>
        <span>Dominance</span>
        <span className="text-right">Mkt Dom</span>
        <span className="text-right">24h</span>
      </div>
    </div>
  );
}

/** SSI sector indexes ranked by recent momentum. */
function IndexMomentumTable({ indices }: { indices: IndexRow[] }) {
  if (indices.length === 0) {
    return (
      <div className="p-6 text-center text-sm text-fg-muted">
        No indices loaded.
      </div>
    );
  }

  // Sort by 7d ROI by default — the "narrative heating up" signal.
  const sorted = [...indices].sort(
    (a, b) => (b.roi_7d ?? -Infinity) - (a.roi_7d ?? -Infinity),
  );

  return (
    <div className="overflow-hidden">
      <table className="w-full">
        <thead className="border-b border-line bg-surface-2">
          <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
            <th className="px-3 py-2 text-left">Index</th>
            <th className="px-3 py-2 text-right">Price</th>
            <th className="px-3 py-2 text-right">24h</th>
            <th className="px-3 py-2 text-right">7d</th>
            <th className="px-3 py-2 text-right">1m</th>
            <th className="px-3 py-2 text-right">3m</th>
            <th className="px-3 py-2 text-right">1y</th>
            <th className="px-3 py-2 text-right">YTD</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {sorted.map((row, idx) => (
            <tr
              key={row.ticker}
              className="text-xs transition-colors hover:bg-surface-2"
            >
              <td className="px-3 py-2">
                <div className="flex items-baseline gap-2">
                  <span className="tabular text-fg-dim">{idx + 1}</span>
                  <span className="font-mono font-medium text-fg">
                    {row.ticker.toLowerCase().startsWith("ssi")
                      ? `${row.ticker.slice(3).toUpperCase()}.ssi`
                      : row.ticker}
                  </span>
                </div>
                <div className="text-[10px] text-fg-dim">{row.name}</div>
              </td>
              <td className="tabular px-3 py-2 text-right text-fg">
                {row.price != null ? `$${row.price.toFixed(2)}` : "—"}
              </td>
              <PctCell value={row.change_pct_24h} />
              <PctCell value={row.roi_7d} highlight />
              <PctCell value={row.roi_1m} />
              <PctCell value={row.roi_3m} />
              <PctCell value={row.roi_1y} />
              <PctCell value={row.ytd} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PctCell({
  value,
  highlight = false,
}: {
  value: number | null;
  highlight?: boolean;
}) {
  const tone =
    value == null
      ? "text-fg-dim"
      : value > 0
        ? "text-positive"
        : value < 0
          ? "text-negative"
          : "text-fg-muted";
  return (
    <td
      className={cn(
        "tabular px-3 py-2 text-right",
        tone,
        highlight && "font-medium",
      )}
    >
      {value == null ? "—" : fmtFracPct(value)}
    </td>
  );
}

// fmtRelative is unused in this file but keep the import path consistent
// with other dashboards that show "snapshot N min ago".
void fmtRelative;
