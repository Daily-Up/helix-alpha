"use client";

/**
 * Token Unlocks — a forward calendar of scheduled supply unlocks, and the
 * SHORT trade plan for the ones worth fading. The model (see lib/unlocks/plan):
 * the negative impact is front-loaded, so we arm a short a week or two before
 * a large team/investor cliff and cover shortly after — "short the
 * anticipation, not the event." Unlock shorts execute RIGHT HERE (not from
 * Live Signals): a candidate that's in its entry window has a one-click Short.
 * Data: DefiLlama emissions (keyless).
 */

import { useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { AssetCell } from "@/components/ui/AssetLogo";
import { Num } from "@/components/ui/Num";
import { cn } from "@/components/ui/cn";
import { ExecuteLiveButton } from "@/components/sodex/ExecuteLiveButton";
import { fmtCountdown } from "./format";
import type { UnlockRowWithPlan } from "@/app/api/data/unlocks/route";

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

const RECIPIENT_LABEL: Record<string, string> = {
  team: "Team",
  investor: "Investor",
  mixed: "Team + VC",
  other: "Community",
};

function PhaseChip({ u }: { u: UnlockRowWithPlan }) {
  const p = u.plan;
  if (p.phase === "entry") {
    return (
      <span className="rounded-[3px] bg-negative/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em] text-negative">
        Short now
      </span>
    );
  }
  if (p.phase === "watching") {
    return (
      <span className="text-[11px] text-fg-muted">
        arms {fmtCountdown(p.entryAt)}
      </span>
    );
  }
  if (p.phase === "holding") {
    return <span className="text-[11px] text-fg-muted">cover soon</span>;
  }
  return <span className="text-[11px] text-fg-dim">—</span>;
}

function ConvictionBadge({ u }: { u: UnlockRowWithPlan }) {
  const p = u.plan;
  const cls =
    p.priority === "high"
      ? "bg-accent/15 text-accent-2"
      : p.priority === "medium"
        ? "bg-surface-2 text-fg-muted"
        : "bg-transparent text-fg-dim";
  return (
    <span className={cn("rounded-[3px] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em]", cls)}>
      {p.priority} · {(p.conviction * 100).toFixed(0)}
    </span>
  );
}

function CandidateCard({ u }: { u: UnlockRowWithPlan }) {
  const p = u.plan;
  const armed = p.phase === "entry";
  return (
    <div
      className={cn(
        "rounded-lg border p-3.5",
        armed ? "border-negative/40 bg-negative/[0.04]" : "border-line bg-surface/40",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <AssetCell
          logoSymbol={u.symbol}
          primary={u.symbol}
          secondary={u.asset_name ?? u.protocol_slug}
        />
        <div className="flex flex-col items-end gap-1">
          <ConvictionBadge u={u} />
          <PhaseChip u={u} />
        </div>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-2 text-center">
        <Metric label="Unlock" value={fmtCountdown(u.unlock_at)} sub={u.unlock_date} />
        <Metric label="Size" value={<Num value={u.unlock_value_usd} unit="$" compact tier="secondary" />} />
        <Metric label="% float" value={<Num value={u.pct_of_circulating} unit="%" dp={2} tier="secondary" />} />
        <Metric label="From" value={RECIPIENT_LABEL[p.recipientClass] ?? "—"} />
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-fg-muted">{p.note}</p>

      <div className="mt-2.5">
        <ExecuteLiveButton
          signal={{
            signal_id: `unlock:${u.id}`,
            symbol: u.sodex_symbol ?? u.symbol,
            side: "sell",
            suggested_size_usd: p.suggestedSizeUsd,
            stop_pct: p.stopPct,
            target_pct: p.targetPct,
            price_usd: u.price_usd ?? 0,
          }}
        />
        {!armed && (
          <div className="mt-1 text-[10px] text-fg-dim">
            Early — plan enters T−{p.entryLeadDays}d. You can still short now.
          </div>
        )}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
}) {
  return (
    <div className="flex flex-col">
      <span className="font-[var(--font-jetbrains-mono)] text-[9px] uppercase tracking-wider text-fg-dim">
        {label}
      </span>
      <span className="text-[13px] text-fg">{value}</span>
      {sub && <span className="text-[9px] text-fg-dim">{sub}</span>}
    </div>
  );
}

export function UnlocksDashboard() {
  const [rows, setRows] = useState<UnlockRowWithPlan[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/data/unlocks?limit=250");
        const json = (await res.json()) as {
          unlocks?: UnlockRowWithPlan[];
          error?: string;
        };
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

  const { candidates, usd30d } = useMemo(() => {
    const list = rows ?? [];
    const now = Date.now();
    // One card per token — its NEXT eligible unlock (soonest first).
    const seen = new Set<string>();
    const cands = list
      .filter((u) => u.plan.eligible)
      .sort((a, b) => a.unlock_at - b.unlock_at)
      .filter((u) => {
        if (seen.has(u.symbol)) return false;
        seen.add(u.symbol);
        return true;
      });
    const usd = list
      .filter((u) => u.unlock_at <= now + MONTH_MS)
      .reduce((s, u) => s + (u.unlock_value_usd ?? 0), 0);
    return { candidates: cands, usd30d: usd };
  }, [rows]);

  const columns: Column<UnlockRowWithPlan>[] = [
    {
      key: "asset",
      header: "Token",
      role: "identifier",
      render: (u) => (
        <AssetCell logoSymbol={u.symbol} primary={u.symbol} secondary={u.asset_name ?? u.protocol_slug} />
      ),
    },
    {
      key: "countdown",
      header: "Unlocks",
      role: "lead",
      render: (u) => <span title={u.unlock_date}>{fmtCountdown(u.unlock_at)}</span>,
    },
    { key: "usd", header: "USD size", role: "magnitude", num: (u) => u.unlock_value_usd, unit: "$", compact: true, tone: "negative" },
    { key: "supply", header: "% of float", role: "context", num: (u) => u.pct_of_circulating, unit: "%", dp: 2 },
    {
      key: "recipient",
      header: "From",
      role: "context",
      render: (u) => RECIPIENT_LABEL[u.plan.recipientClass] ?? "—",
    },
    { key: "date", header: "Date", role: "context", render: (u) => u.unlock_date },
    {
      key: "plan",
      header: "Short plan",
      role: "identifier",
      align: "left",
      render: (u) => <PhaseChip u={u} />,
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <Card className={candidates.some((u) => u.plan.phase === "entry") ? "border-negative/25" : undefined}>
        <CardHeader>
          <CardTitle>Short candidates</CardTitle>
          <div className="flex items-center gap-4 text-[11px] text-fg-dim">
            <span>
              <Num value={usd30d} unit="$" compact tier="context" /> unlocking (30d)
            </span>
            <span className="text-negative">{candidates.length} candidates</span>
          </div>
        </CardHeader>
        <CardBody>
          {rows == null ? (
            <div className="text-sm text-fg-muted">Loading…</div>
          ) : candidates.length === 0 ? (
            <div className="py-6 text-center text-sm text-fg-dim">
              No shortable unlocks right now — team/investor cliffs ≥1% of float
              on a SoDEX perp. The calendar below tracks everything upcoming.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {candidates.slice(0, 6).map((u) => (
                <CandidateCard key={u.id} u={u} />
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Unlock calendar</CardTitle>
          <span className="text-[11px] text-fg-dim">DefiLlama emissions · daily</span>
        </CardHeader>
        <CardBody className="!p-0">
          {err && rows == null ? (
            <div className="px-4 py-3 text-xs text-negative">{err}</div>
          ) : rows == null ? (
            <div className="px-4 py-6 text-sm text-fg-muted">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-fg-dim">
              No upcoming unlocks tracked yet. The daily job populates this.
            </div>
          ) : (
            <DataTable<UnlockRowWithPlan>
              columns={columns}
              rows={rows}
              getKey={(u) => u.id}
              minWidth={720}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
