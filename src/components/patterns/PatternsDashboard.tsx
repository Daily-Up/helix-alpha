"use client";

import { useEffect, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Stat } from "@/components/ui/Stat";
import { Badge } from "@/components/ui/Badge";
import { fmtPct } from "@/lib/format";
import { cn } from "@/components/ui/cn";

interface PatternStats {
  event_type: string;
  sentiment: "positive" | "negative" | "neutral";
  horizon: "1d" | "3d" | "7d";
  n: number;
  avg_pct: number;
  median_pct: number;
  stddev_pct: number;
  hit_rate: number;
  empirical_tradability: number;
}

interface PatternsByType {
  event_type: string;
  best: PatternStats;
  all: PatternStats[];
}

interface Comparison {
  event_type: string;
  hardcoded: number;
  empirical: number | null;
  delta: number | null;
  verdict: "underrated" | "overrated" | "calibrated" | "insufficient_samples";
}

interface PerAsset {
  event_type: string;
  asset_id: string;
  n: number;
  avg: number;
}

interface PatternsResponse {
  sample_total: number;
  patterns_by_event_type: PatternsByType[];
  hardcoded_vs_empirical: Comparison[];
  per_asset: PerAsset[];
}

export function PatternsDashboard() {
  const [data, setData] = useState<PatternsResponse | null>(null);

  useEffect(() => {
    fetch("/api/data/patterns")
      .then((r) => r.json())
      .then(setData);
  }, []);

  if (!data) {
    return (
      <div className="rounded border border-line bg-surface p-6 text-sm text-fg-muted">
        Loading patterns…
      </div>
    );
  }

  const ranked = [...data.patterns_by_event_type]
    .filter((p) => p.best.n >= 2)
    .sort((a, b) => b.best.empirical_tradability - a.best.empirical_tradability);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Total samples" value={data.sample_total} />
        <Stat
          label="Event types tracked"
          value={data.patterns_by_event_type.length}
        />
        <Stat
          label="Calibrated"
          value={
            data.hardcoded_vs_empirical.filter((c) => c.verdict === "calibrated")
              .length
          }
          tone="positive"
        />
        <Stat
          label="Need recalibration"
          value={
            data.hardcoded_vs_empirical.filter(
              (c) =>
                c.verdict === "underrated" || c.verdict === "overrated",
            ).length
          }
          tone="accent"
        />
      </div>

      {/* Pattern leaderboard */}
      <Card>
        <CardHeader>
          <CardTitle>Empirical Pattern Library · 1d horizon</CardTitle>
          <span className="text-xs text-fg-muted">
            sorted by tradability · only n≥2
          </span>
        </CardHeader>
        <CardBody className="p-0">
          <table className="w-full">
            <thead className="border-b border-line bg-surface-2">
              <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
                <th className="px-3 py-2 text-left">Event type</th>
                <th className="px-3 py-2 text-left">Sentiment</th>
                <th className="px-3 py-2 text-right">N</th>
                <th className="px-3 py-2 text-right">Avg 1d</th>
                <th className="px-3 py-2 text-right">Median</th>
                <th className="px-3 py-2 text-right">Stdev</th>
                <th className="px-3 py-2 text-right">Hit rate</th>
                <th className="px-3 py-2 text-right">Tradability</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {ranked.map((p) => {
                const b = p.best;
                return (
                  <tr
                    key={p.event_type}
                    className="text-xs transition-colors hover:bg-surface-2"
                  >
                    <td className="px-3 py-2 font-mono font-medium text-fg">
                      {p.event_type}
                    </td>
                    <td className="px-3 py-2">
                      <Badge
                        tone={
                          b.sentiment === "positive"
                            ? "positive"
                            : b.sentiment === "negative"
                              ? "negative"
                              : "default"
                        }
                      >
                        {b.sentiment}
                      </Badge>
                    </td>
                    <td className="tabular px-3 py-2 text-right text-fg">
                      {b.n}
                    </td>
                    <td
                      className={cn(
                        "tabular px-3 py-2 text-right",
                        b.avg_pct > 0
                          ? "text-positive"
                          : b.avg_pct < 0
                            ? "text-negative"
                            : "text-fg-muted",
                      )}
                    >
                      {fmtPct(b.avg_pct)}
                    </td>
                    <td className="tabular px-3 py-2 text-right text-fg-muted">
                      {fmtPct(b.median_pct)}
                    </td>
                    <td className="tabular px-3 py-2 text-right text-fg-dim">
                      {b.stddev_pct.toFixed(2)}%
                    </td>
                    <td className="tabular px-3 py-2 text-right text-fg">
                      {(b.hit_rate * 100).toFixed(0)}%
                    </td>
                    <td className="tabular px-3 py-2 text-right">
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 font-mono",
                          b.empirical_tradability > 0.6
                            ? "bg-positive/15 text-positive"
                            : b.empirical_tradability > 0.3
                              ? "bg-warning/15 text-warning"
                              : "bg-line-2 text-fg-muted",
                        )}
                      >
                        {(b.empirical_tradability * 100).toFixed(0)}%
                      </span>
                    </td>
                  </tr>
                );
              })}
              {ranked.length === 0 ? (
                <tr>
                  <td
                    colSpan={8}
                    className="px-3 py-8 text-center text-sm text-fg-muted"
                  >
                    No patterns yet. Run{" "}
                    <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">
                      npm run backfill:news
                    </code>{" "}
                    →{" "}
                    <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">
                      npm run reclassify
                    </code>{" "}
                    →{" "}
                    <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">
                      npm run test:impact
                    </code>{" "}
                    to populate.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </CardBody>
      </Card>

      {/* Hardcoded vs empirical */}
      <Card>
        <CardHeader>
          <CardTitle>Calibration Audit</CardTitle>
          <span className="text-xs text-fg-muted">
            our hardcoded scores vs measured reality
          </span>
        </CardHeader>
        <CardBody className="p-0">
          <table className="w-full">
            <thead className="border-b border-line bg-surface-2">
              <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
                <th className="px-3 py-2 text-left">Event type</th>
                <th className="px-3 py-2 text-right">Hardcoded</th>
                <th className="px-3 py-2 text-right">Empirical</th>
                <th className="px-3 py-2 text-right">Δ</th>
                <th className="px-3 py-2 text-left">Verdict</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.hardcoded_vs_empirical.map((c) => (
                <tr
                  key={c.event_type}
                  className="text-xs transition-colors hover:bg-surface-2"
                >
                  <td className="px-3 py-2 font-mono text-fg">{c.event_type}</td>
                  <td className="tabular px-3 py-2 text-right text-fg-muted">
                    {(c.hardcoded * 100).toFixed(0)}%
                  </td>
                  <td className="tabular px-3 py-2 text-right text-fg">
                    {c.empirical != null
                      ? `${(c.empirical * 100).toFixed(0)}%`
                      : "—"}
                  </td>
                  <td
                    className={cn(
                      "tabular px-3 py-2 text-right",
                      c.delta == null
                        ? "text-fg-dim"
                        : c.delta > 0
                          ? "text-positive"
                          : c.delta < 0
                            ? "text-negative"
                            : "text-fg-muted",
                    )}
                  >
                    {c.delta == null
                      ? "—"
                      : `${c.delta >= 0 ? "+" : ""}${(c.delta * 100).toFixed(0)}%`}
                  </td>
                  <td className="px-3 py-2">
                    <Badge
                      tone={
                        c.verdict === "calibrated"
                          ? "positive"
                          : c.verdict === "underrated"
                            ? "info"
                            : c.verdict === "overrated"
                              ? "negative"
                              : "default"
                      }
                    >
                      {c.verdict.replace("_", " ")}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
      </Card>

      {/* Per-asset breakdown */}
      {data.per_asset.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Per-Asset Sensitivity</CardTitle>
            <span className="text-xs text-fg-muted">
              which assets reliably move on which event types
            </span>
          </CardHeader>
          <CardBody className="p-0">
            <table className="w-full">
              <thead className="border-b border-line bg-surface-2">
                <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
                  <th className="px-3 py-2 text-left">Asset</th>
                  <th className="px-3 py-2 text-left">Event type</th>
                  <th className="px-3 py-2 text-right">N</th>
                  <th className="px-3 py-2 text-right">Avg 1d</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.per_asset.map((r, i) => (
                  <tr
                    key={`${r.asset_id}-${r.event_type}-${i}`}
                    className="text-xs transition-colors hover:bg-surface-2"
                  >
                    <td className="px-3 py-2 font-mono text-fg">{r.asset_id}</td>
                    <td className="px-3 py-2 text-fg-muted">{r.event_type}</td>
                    <td className="tabular px-3 py-2 text-right text-fg">
                      {r.n}
                    </td>
                    <td
                      className={cn(
                        "tabular px-3 py-2 text-right font-medium",
                        r.avg > 0
                          ? "text-positive"
                          : r.avg < 0
                            ? "text-negative"
                            : "text-fg-muted",
                      )}
                    >
                      {fmtPct(r.avg)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
