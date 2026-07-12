"use client";

import { useEffect, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Stat } from "@/components/ui/Stat";
import { Badge } from "@/components/ui/Badge";
import { DataTable, type Column } from "@/components/ui/DataTable";

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

  // Leaderboard: 8 flat columns → role-based. Tradability (the sort key) now
  // ENCODES as a magnitude bar instead of a threshold-colored pill, so rank
  // reads as length. Median (near-duplicate of Avg) and Stdev folded away.
  const leaderboardColumns: Column<PatternsByType>[] = [
    { key: "event", header: "Event type", role: "identifier", render: (p) => p.event_type },
    {
      key: "sentiment",
      header: "Sentiment",
      role: "context",
      render: (p) => (
        <Badge
          tone={
            p.best.sentiment === "positive"
              ? "positive"
              : p.best.sentiment === "negative"
                ? "negative"
                : "default"
          }
        >
          {p.best.sentiment}
        </Badge>
      ),
    },
    { key: "n", header: "N", role: "context", num: (p) => p.best.n },
    { key: "avg", header: "Avg 1d", role: "context", num: (p) => p.best.avg_pct, unit: "%", sign: true, dp: 1, tone: "auto" },
    { key: "hit", header: "Hit rate", role: "context", num: (p) => p.best.hit_rate * 100, unit: "%", dp: 0 },
    { key: "trad", header: "Tradability", role: "magnitude", num: (p) => p.best.empirical_tradability * 100, unit: "%", dp: 0 },
  ];

  // Calibration audit: Δ (the divergence from calibration) becomes the
  // magnitude bar; hardcoded + empirical stay as quiet context inputs.
  const calibrationColumns: Column<Comparison>[] = [
    { key: "event", header: "Event type", role: "identifier", render: (c) => c.event_type },
    { key: "hardcoded", header: "Hardcoded", role: "context", num: (c) => c.hardcoded * 100, unit: "%", dp: 0 },
    { key: "empirical", header: "Empirical", role: "context", num: (c) => (c.empirical != null ? c.empirical * 100 : null), unit: "%", dp: 0 },
    { key: "delta", header: "Δ", role: "magnitude", num: (c) => (c.delta != null ? c.delta * 100 : null), unit: "%", sign: true, dp: 0, tone: "auto" },
    {
      key: "verdict",
      header: "Verdict",
      role: "context",
      render: (c) => (
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
      ),
    },
  ];

  // Per-asset: Avg 1d is the one homogeneous signed magnitude → the bar.
  const perAssetColumns: Column<PerAsset>[] = [
    { key: "asset", header: "Asset", role: "identifier", render: (r) => r.asset_id },
    { key: "event", header: "Event type", role: "context", render: (r) => r.event_type },
    { key: "n", header: "N", role: "context", num: (r) => r.n },
    { key: "avg", header: "Avg 1d", role: "magnitude", num: (r) => r.avg, unit: "%", sign: true, dp: 1, tone: "auto" },
  ];

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
          {ranked.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-fg-muted">
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
            </div>
          ) : (
            <DataTable<PatternsByType>
              columns={leaderboardColumns}
              rows={ranked}
              getKey={(p) => p.event_type}
              minWidth={640}
            />
          )}
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
          <DataTable<Comparison>
            columns={calibrationColumns}
            rows={data.hardcoded_vs_empirical}
            getKey={(c) => c.event_type}
            minWidth={520}
          />
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
            <DataTable<PerAsset>
              columns={perAssetColumns}
              rows={data.per_asset}
              getKey={(r, i) => `${r.asset_id}-${r.event_type}-${i}`}
              minWidth={420}
            />
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
