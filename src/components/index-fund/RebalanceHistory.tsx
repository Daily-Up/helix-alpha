"use client";

import { Badge } from "@/components/ui/Badge";
import { fmtPct, fmtRelative, fmtUsd } from "@/lib/format";
import { cn } from "@/components/ui/cn";

export interface RebalanceView {
  id: string;
  rebalanced_at: number;
  triggered_by: string;
  pre_nav: number;
  post_nav: number;
  old_weights: Record<string, number>;
  new_weights: Record<string, number>;
  trades_made: Array<{
    asset_id: string;
    side: "buy" | "sell";
    size_usd: number;
    fill_price: number;
  }>;
  reasoning: string;
  reviewer_model: string | null;
}

export function RebalanceHistory({
  rebalances,
}: {
  rebalances: RebalanceView[];
}) {
  if (rebalances.length === 0) {
    return (
      <div className="rounded border border-line bg-surface p-6 text-center text-sm text-fg-muted">
        No rebalances yet. Click <strong>Rebalance Now</strong> to make the
        first one.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {rebalances.map((r) => {
        const pnlDelta = r.post_nav - r.pre_nav;
        const buys = r.trades_made.filter((t) => t.side === "buy");
        const sells = r.trades_made.filter((t) => t.side === "sell");
        return (
          <article
            key={r.id}
            className="flex flex-col gap-2 rounded-md border border-line bg-surface px-4 py-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="accent">REBALANCE</Badge>
              <Badge tone="default">{r.triggered_by}</Badge>
              {r.reviewer_model && r.reviewer_model !== "rules-only" ? (
                <Badge tone="info">CLAUDE-REVIEWED</Badge>
              ) : (
                <Badge tone="default">RULES ONLY</Badge>
              )}
              <span className="text-xs text-fg-muted">
                {r.trades_made.length} trades · {buys.length} buys ·{" "}
                {sells.length} sells
              </span>
              <span className="ml-auto tabular text-xs text-fg-dim">
                {fmtRelative(r.rebalanced_at)}
              </span>
            </div>

            <p className="text-sm leading-relaxed text-fg">{r.reasoning}</p>

            <div className="flex flex-wrap gap-3 text-[11px] text-fg-muted">
              <span>
                <span className="text-fg-dim">NAV:</span>{" "}
                <span className="tabular text-fg">{fmtUsd(r.pre_nav)}</span> →{" "}
                <span className="tabular text-fg">{fmtUsd(r.post_nav)}</span>
              </span>
              <span
                className={cn(
                  "tabular",
                  pnlDelta > 0
                    ? "text-positive"
                    : pnlDelta < 0
                      ? "text-negative"
                      : "text-fg-muted",
                )}
              >
                Δ {fmtUsd(pnlDelta)} ({fmtPct((pnlDelta / r.pre_nav) * 100)})
              </span>
            </div>

            {/* Top weight changes */}
            <div className="flex flex-col gap-1 pt-1 text-[11px]">
              <span className="text-fg-dim uppercase tracking-wider">
                Weight changes
              </span>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {topWeightChanges(r.old_weights, r.new_weights, 6).map(
                  (c) => (
                    <span key={c.asset_id} className="text-fg-muted">
                      <span className="font-mono text-fg">{c.asset_id}:</span>{" "}
                      <span className="tabular">
                        {(c.old * 100).toFixed(1)}% →{" "}
                        {(c.new_w * 100).toFixed(1)}%
                      </span>{" "}
                      <span
                        className={cn(
                          "tabular",
                          c.delta > 0 ? "text-positive" : "text-negative",
                        )}
                      >
                        ({c.delta >= 0 ? "+" : ""}
                        {(c.delta * 100).toFixed(1)}%)
                      </span>
                    </span>
                  ),
                )}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function topWeightChanges(
  oldW: Record<string, number>,
  newW: Record<string, number>,
  limit: number,
): Array<{ asset_id: string; old: number; new_w: number; delta: number }> {
  const ids = new Set([...Object.keys(oldW), ...Object.keys(newW)]);
  const out: Array<{ asset_id: string; old: number; new_w: number; delta: number }> = [];
  for (const id of ids) {
    const o = oldW[id] ?? 0;
    const n = newW[id] ?? 0;
    out.push({ asset_id: id, old: o, new_w: n, delta: n - o });
  }
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, limit);
}
