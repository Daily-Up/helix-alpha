"use client";

import { useEffect, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { fmtRelative } from "@/lib/format";
import { DataTable, type Column } from "@/components/ui/DataTable";

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

  const columns: Column<SectorRow>[] = [
    {
      key: "sector",
      header: "Sector",
      role: "identifier",
      align: "left",
      render: (s) => s.sector_name,
    },
    {
      key: "dom",
      header: "Mkt Dominance",
      role: "magnitude",
      num: (s) => (s.marketcap_dom == null ? null : s.marketcap_dom * 100),
      unit: "%",
      dp: 2,
    },
    {
      key: "chg",
      header: "24h",
      role: "context",
      num: (s) => (s.change_pct_24h == null ? null : s.change_pct_24h * 100),
      unit: "%",
      sign: true,
      tone: "auto",
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={sorted}
      getKey={(s) => s.sector_name}
      minWidth={420}
    />
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

  const columns: Column<IndexRow>[] = [
    {
      key: "index",
      header: "Index",
      role: "identifier",
      align: "left",
      render: (r) => (
        <div className="flex flex-col leading-tight">
          <span className="font-medium text-fg">
            {r.ticker.toLowerCase().startsWith("ssi")
              ? `${r.ticker.slice(3).toUpperCase()}.ssi`
              : r.ticker}
          </span>
          <span className="text-[10px] text-fg-dim">{r.name}</span>
        </div>
      ),
    },
    { key: "price", header: "Price", role: "context", num: (r) => r.price, unit: "$", dp: 2 },
    {
      key: "d7",
      header: "7d",
      role: "magnitude",
      num: (r) => (r.roi_7d == null ? null : r.roi_7d * 100),
      unit: "%",
      sign: true,
      tone: "auto",
    },
    {
      key: "d24h",
      header: "24h",
      role: "context",
      num: (r) => (r.change_pct_24h == null ? null : r.change_pct_24h * 100),
      unit: "%",
      sign: true,
      tone: "auto",
    },
    {
      key: "m1",
      header: "1m",
      role: "context",
      num: (r) => (r.roi_1m == null ? null : r.roi_1m * 100),
      unit: "%",
      sign: true,
      tone: "auto",
    },
    {
      key: "m3",
      header: "3m",
      role: "context",
      num: (r) => (r.roi_3m == null ? null : r.roi_3m * 100),
      unit: "%",
      sign: true,
      tone: "auto",
    },
    {
      key: "y1",
      header: "1y",
      role: "context",
      num: (r) => (r.roi_1y == null ? null : r.roi_1y * 100),
      unit: "%",
      sign: true,
      tone: "auto",
    },
    {
      key: "ytd",
      header: "YTD",
      role: "context",
      num: (r) => (r.ytd == null ? null : r.ytd * 100),
      unit: "%",
      sign: true,
      tone: "auto",
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={sorted}
      getKey={(r) => r.ticker}
      minWidth={640}
    />
  );
}

// fmtRelative is unused in this file but keep the import path consistent
// with other dashboards that show "snapshot N min ago".
void fmtRelative;
