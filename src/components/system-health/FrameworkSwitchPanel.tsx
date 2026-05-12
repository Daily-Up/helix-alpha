"use client";

/**
 * Framework switch history panel — Part 3 of v2.1 attribution.
 *
 * Renders the last 10 v1↔v2.1 switches with trailing 30d return
 * context so we can later ask "did the user switch right after a
 * bad month?" (I-38).
 */

import { useEffect, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";

interface SwitchRow {
  id: string;
  switched_at: string;
  from_version: string;
  to_version: string;
  user_confirmed_understanding: boolean;
  live_nav_at_switch: number;
  shadow_nav_at_switch: number;
  v1_30d_return: number | null;
  v2_30d_return: number | null;
  notes: string | null;
}

export function FrameworkSwitchPanel() {
  const [rows, setRows] = useState<SwitchRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/data/framework-switches");
        const j = await r.json();
        if (!cancelled && j.ok) setRows(j.rows ?? []);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <Card>
        <CardBody>
          <div className="text-sm text-negative">
            Switch history unavailable: {error}
          </div>
        </CardBody>
      </Card>
    );
  }
  if (!rows) {
    return (
      <Card>
        <CardBody>
          <div className="text-sm text-fg-dim">Loading switch history…</div>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Framework switch history</CardTitle>
        <span className="text-xs text-fg-muted">
          last {rows.length} v1 ↔ v2.1 switches with trailing 30d context
        </span>
      </CardHeader>
      <CardBody className="!p-0">
        {rows.length === 0 ? (
          <div className="px-4 py-3 text-sm text-fg-dim">
            No framework switches recorded. Switches are journaled here
            when you change the live framework via the AlphaIndex
            framework selector.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="border-b border-line bg-surface-2">
              <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
                <th className="px-3 py-2 text-left">When</th>
                <th className="px-3 py-2 text-left">Direction</th>
                <th className="px-3 py-2 text-right">Live NAV</th>
                <th className="px-3 py-2 text-right">v1 30d</th>
                <th className="px-3 py-2 text-right">v2.1 30d</th>
                <th className="px-3 py-2 text-left">Confirmed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.id} className="transition-colors hover:bg-surface-2">
                  <td className="px-3 py-2 text-fg-muted">{r.switched_at}</td>
                  <td className="px-3 py-2 text-fg">
                    <span className="font-mono text-[11px]">
                      {r.from_version} → {r.to_version}
                    </span>
                  </td>
                  <td className="tabular px-3 py-2 text-right text-fg">
                    ${r.live_nav_at_switch.toFixed(0)}
                  </td>
                  <td className={cn("tabular px-3 py-2 text-right", retCls(r.v1_30d_return))}>
                    {fmtRet(r.v1_30d_return)}
                  </td>
                  <td className={cn("tabular px-3 py-2 text-right", retCls(r.v2_30d_return))}>
                    {fmtRet(r.v2_30d_return)}
                  </td>
                  <td className="px-3 py-2 text-[10px]">
                    {r.user_confirmed_understanding ? (
                      <span className="rounded border border-positive/40 bg-positive/10 px-1.5 py-0.5 text-positive">
                        ack
                      </span>
                    ) : (
                      <span className="rounded border border-line bg-surface-2 px-1.5 py-0.5 text-fg-dim">
                        n/a (revert)
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardBody>
    </Card>
  );
}

function fmtRet(n: number | null): string {
  if (n == null) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}
function retCls(n: number | null): string {
  if (n == null) return "text-fg-dim";
  return n >= 0 ? "text-positive" : "text-negative";
}
