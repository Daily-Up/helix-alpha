"use client";

/**
 * Token Unlocks calendar — upcoming scheduled supply unlocks, soonest first,
 * with the SHORT signal each large unlock generated. A big unlock (measured
 * as % of circulating float) is predictable, datable sell pressure, so the
 * generator fires a short into it; the row links to /signals to execute it
 * one-click on the perp. Data: DefiLlama emissions (keyless).
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { AssetCell } from "@/components/ui/AssetLogo";
import { Num } from "@/components/ui/Num";
import { cn } from "@/components/ui/cn";
import { fmtCountdown } from "./format";
import type { UnlockJoinRow } from "@/app/api/data/unlocks/route";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function isActionable(u: UnlockJoinRow): boolean {
  return (
    !!u.signal_id &&
    (u.signal_tier === "auto" || u.signal_tier === "review") &&
    !!u.sodex_symbol &&
    u.sodex_symbol.includes("-USD") &&
    u.signal_status === "pending"
  );
}

function SignalBadge({ u }: { u: UnlockJoinRow }) {
  if (!u.signal_id) {
    return <span className="text-fg-dim">—</span>;
  }
  const tier = u.signal_tier ?? "info";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-[var(--font-jetbrains-mono)] text-[11px] font-medium text-negative">
        SHORT
      </span>
      <span
        className={cn(
          "rounded-[3px] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em]",
          tier === "auto"
            ? "bg-accent/15 text-accent-2"
            : tier === "review"
              ? "bg-surface-2 text-fg-muted"
              : "bg-transparent text-fg-dim",
        )}
      >
        {tier}
      </span>
    </span>
  );
}

export function UnlocksDashboard() {
  const [rows, setRows] = useState<UnlockJoinRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/data/unlocks?limit=250");
        const json = (await res.json()) as { unlocks?: UnlockJoinRow[]; error?: string };
        if (!alive) return;
        if (json.error) setErr(json.error);
        setRows(json.unlocks ?? []);
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const summary = useMemo(() => {
    const list = rows ?? [];
    const now = Date.now();
    const usd7d = list
      .filter((u) => u.unlock_at <= now + WEEK_MS)
      .reduce((s, u) => s + (u.unlock_value_usd ?? 0), 0);
    const shorts = list.filter(isActionable).length;
    return { usd7d, shorts, total: list.length };
  }, [rows]);

  const columns: Column<UnlockJoinRow>[] = [
    {
      key: "asset",
      header: "Token",
      role: "identifier",
      render: (u) => (
        <AssetCell
          logoSymbol={u.symbol}
          primary={u.symbol}
          secondary={u.asset_name ?? u.protocol_slug}
        />
      ),
    },
    {
      key: "countdown",
      header: "Unlocks",
      role: "lead",
      render: (u) => (
        <span title={u.unlock_date}>{fmtCountdown(u.unlock_at)}</span>
      ),
    },
    {
      key: "usd",
      header: "USD size",
      role: "magnitude",
      num: (u) => u.unlock_value_usd,
      unit: "$",
      compact: true,
      tone: "negative",
    },
    {
      key: "supply",
      header: "% of float",
      role: "context",
      num: (u) => u.pct_of_circulating,
      unit: "%",
      dp: 2,
    },
    {
      key: "kind",
      header: "Type",
      role: "context",
      render: (u) => <span className="capitalize">{u.unlock_kind ?? "—"}</span>,
    },
    {
      key: "date",
      header: "Date",
      role: "context",
      render: (u) => u.unlock_date,
    },
    {
      key: "signal",
      header: "Signal",
      role: "identifier",
      align: "left",
      render: (u) => <SignalBadge u={u} />,
    },
    {
      key: "act",
      header: "",
      role: "action",
      render: (u) =>
        isActionable(u) ? (
          <Link
            href="/signals"
            className="inline-flex items-center gap-1 rounded-[4px] border border-negative/40 bg-negative/10 px-2.5 py-1 text-[12px] font-medium text-negative transition-colors hover:bg-negative/20"
          >
            Short <span aria-hidden>→</span>
          </Link>
        ) : (
          <span className="text-[11px] text-fg-dim">
            {u.tradable_perp ? "—" : "no perp"}
          </span>
        ),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upcoming unlocks</CardTitle>
        <div className="flex items-center gap-4 text-[11px] text-fg-dim">
          <span>
            <Num value={summary.usd7d} unit="$" compact tier="context" /> unlocking
            (7d)
          </span>
          <span className="text-negative">{summary.shorts} shortable</span>
        </div>
      </CardHeader>
      <CardBody className="!p-0">
        {err && rows == null ? (
          <div className="px-4 py-3 text-xs text-negative">{err}</div>
        ) : rows == null ? (
          <div className="px-4 py-6 text-sm text-fg-muted">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-fg-dim">
            No upcoming unlocks tracked yet. The daily job populates this from
            DefiLlama emissions.
          </div>
        ) : (
          <DataTable<UnlockJoinRow>
            columns={columns}
            rows={rows}
            getKey={(u) => u.id}
            minWidth={760}
          />
        )}
      </CardBody>
    </Card>
  );
}
