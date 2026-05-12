"use client";

/**
 * /macro — macro calendar + recent print history with "surprise"
 * lens (actual vs forecast). Surfaces the data that feeds the
 * Daily Briefing's macro context.
 */

import { useEffect, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Stat } from "@/components/ui/Stat";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/components/ui/cn";

interface UpcomingRow {
  date: string;
  event: string;
}

interface HistoryRow {
  event: string;
  date: string;
  actual_raw: string | null;
  forecast_raw: string | null;
  previous_raw: string | null;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  unit: string | null;
  surprise: number | null;
}

interface ApiResp {
  upcoming: UpcomingRow[];
  recent: HistoryRow[];
  surprises: HistoryRow[];
}

function fmtSurprise(s: HistoryRow): string {
  if (s.surprise == null) return "—";
  const sign = s.surprise > 0 ? "+" : "";
  const abs = Math.abs(s.surprise);
  // Format scale-aware: huge raw numbers (home sales in 100s of thousands)
  // get K/M scaling; small numbers get 2 decimals.
  let body: string;
  let suffix: string;
  if (abs >= 1_000_000) {
    body = (s.surprise / 1_000_000).toFixed(2) + "M";
    suffix = ""; // units are absolute counts (homes, etc.) — no "pp" suffix
  } else if (abs >= 1_000) {
    body = (s.surprise / 1_000).toFixed(0) + "K";
    suffix = "";
  } else {
    body = s.surprise.toFixed(2);
    // For small numbers we DO know the unit: % for inflation/PMI deltas,
    // pp (percentage points) for everything else.
    suffix = s.unit ?? "pp";
  }
  return `${sign}${body}${suffix}`;
}

/**
 * Pretty-print a raw API value string. Keeps unit suffixes (e.g. "4.5%").
 * For numeric-only values, scales to K/M/B and trims floating-point junk
 * like "4019999.9999999995" → "4.02M".
 */
function fmtMacroRaw(raw: string | null | undefined): string {
  if (raw == null || raw === "") return "—";
  const trimmed = raw.trim();
  // Has a unit suffix (%) → keep as-is, the API already formatted nicely.
  if (/[a-zA-Z%]/.test(trimmed)) return trimmed;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return trimmed;
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  // Small numbers: trim trailing zeros after at most 2 decimals.
  return Number.isInteger(n) ? `${n}` : n.toFixed(2);
}

function surpriseTone(s: HistoryRow):
  | "positive"
  | "negative"
  | "warning"
  | "default" {
  if (s.surprise == null) return "default";
  const abs = Math.abs(s.surprise);
  // Inflation/PPI/CPI: cooler = positive (risk-on); hotter = negative.
  // Activity (PMI, retail): hotter = positive.
  // We don't know the indicator's "polarity" here without a lookup,
  // so just color by absolute deviation magnitude.
  if (abs < 0.05) return "default";
  return s.surprise >= 0 ? "warning" : "warning";
}

export function MacroDashboard() {
  const [data, setData] = useState<ApiResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    setError(null);
    const r = await fetch("/api/data/macro");
    setData(await r.json());
  };

  useEffect(() => {
    fetchData().finally(() => setLoading(false));
  }, []);

  const refresh = async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await fetch("/api/cron/ingest-macro", { method: "POST" });
      const j = await r.json();
      if (!j.ok) setError(j.error ?? "ingest failed");
      else await fetchData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setRunning(false);
    }
  };

  if (loading && !data) {
    return <div className="text-sm text-fg-dim">Loading macro…</div>;
  }
  if (!data) return null;

  const surprises = data.surprises ?? [];
  const recent = data.recent ?? [];

  // Quick stats
  const printsLast30 = recent.filter(
    (r) => r.actual_raw != null && new Date(r.date) >= new Date(Date.now() - 30 * 86400 * 1000),
  ).length;
  const upcomingNext7 = data.upcoming.filter(
    (u) => new Date(u.date) <= new Date(Date.now() + 7 * 86400 * 1000),
  ).length;
  const surprisesLast30 = surprises.filter(
    (s) => new Date(s.date) >= new Date(Date.now() - 30 * 86400 * 1000),
  ).length;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Upcoming (next 7d)"
          value={upcomingNext7}
          sub={`${data.upcoming.length} on calendar total`}
          tone={upcomingNext7 > 0 ? "accent" : "default"}
        />
        <Stat
          label="Prints (last 30d)"
          value={printsLast30}
          sub="historical readings"
        />
        <Stat
          label="Notable surprises (60d)"
          value={surprises.length}
          sub="largest |actual − forecast|"
          tone={surprises.length > 0 ? "accent" : "default"}
        />
        <Stat
          label="Surprises last 30d"
          value={surprisesLast30}
          sub="forecast misses on file"
        />
      </div>

      <div className="flex items-center justify-between">
        <span className="text-[11px] text-fg-dim">
          Source: SoSoValue /macro/events + /history
        </span>
        <button
          onClick={refresh}
          disabled={running}
          className="rounded border border-line px-2.5 py-1 text-xs text-fg-muted transition-colors hover:border-line-2 hover:text-fg disabled:cursor-wait disabled:opacity-50"
        >
          {running ? "Refreshing…" : "↻ Refresh from SoSoValue"}
        </button>
      </div>
      {error ? (
        <div className="rounded border border-negative/40 bg-negative/10 px-3 py-2 text-xs text-negative">
          {error}
        </div>
      ) : null}

      {/* Upcoming calendar */}
      <Card>
        <CardHeader>
          <CardTitle>Upcoming calendar</CardTitle>
          <span className="text-[11px] text-fg-dim">
            {data.upcoming.length} events scheduled
          </span>
        </CardHeader>
        <CardBody className="!p-0">
          {data.upcoming.length === 0 ? (
            <div className="px-4 py-6 text-sm text-fg-dim">
              No upcoming events on the calendar.
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {data.upcoming.map((u) => (
                <li
                  key={`${u.date}-${u.event}`}
                  className="flex items-baseline gap-3 px-4 py-2.5 text-sm"
                >
                  <span className="tabular w-24 text-fg-dim">{u.date}</span>
                  <span className="text-fg">{u.event}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {/* Top surprises */}
      <Card>
        <CardHeader>
          <CardTitle>Notable surprises</CardTitle>
          <span className="text-[11px] text-fg-dim">
            largest |actual − forecast| in last 60 days
          </span>
        </CardHeader>
        <CardBody className="!p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-line bg-surface-2">
                <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Event</th>
                  <th className="px-3 py-2 text-right">Actual</th>
                  <th className="px-3 py-2 text-right">Forecast</th>
                  <th className="px-3 py-2 text-right">Previous</th>
                  <th className="px-3 py-2 text-right">Surprise</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {surprises.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-6 text-center text-sm text-fg-dim"
                    >
                      No notable surprises yet.
                    </td>
                  </tr>
                ) : (
                  surprises.map((s) => (
                    <tr
                      key={`${s.event}-${s.date}`}
                      className="text-xs transition-colors hover:bg-surface-2"
                    >
                      <td className="px-3 py-2 text-fg-muted whitespace-nowrap">
                        {s.date}
                      </td>
                      <td className="px-3 py-2 text-fg">{s.event}</td>
                      <td className="tabular px-3 py-2 text-right text-fg">
                        {fmtMacroRaw(s.actual_raw)}
                      </td>
                      <td className="tabular px-3 py-2 text-right text-fg-muted">
                        {fmtMacroRaw(s.forecast_raw)}
                      </td>
                      <td className="tabular px-3 py-2 text-right text-fg-dim">
                        {fmtMacroRaw(s.previous_raw)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Badge tone={surpriseTone(s)} mono>
                          {fmtSurprise(s)}
                        </Badge>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      {/* Full history */}
      <Card>
        <CardHeader>
          <CardTitle>Recent prints (last 60 days)</CardTitle>
          <span className="text-[11px] text-fg-dim">{recent.length} readings</span>
        </CardHeader>
        <CardBody className="!p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-line bg-surface-2">
                <tr className="text-[10px] uppercase tracking-wider text-fg-dim">
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Event</th>
                  <th className="px-3 py-2 text-right">Actual</th>
                  <th className="px-3 py-2 text-right">Forecast</th>
                  <th className="px-3 py-2 text-right">Previous</th>
                  <th className="px-3 py-2 text-right">Δ vs forecast</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {recent.map((r) => (
                  <tr
                    key={`${r.event}-${r.date}`}
                    className={cn(
                      "text-xs transition-colors hover:bg-surface-2",
                      r.surprise != null &&
                        Math.abs(r.surprise) > 0 &&
                        "bg-surface",
                    )}
                  >
                    <td className="px-3 py-2 text-fg-muted whitespace-nowrap">
                      {r.date}
                    </td>
                    <td className="px-3 py-2 text-fg">{r.event}</td>
                    <td className="tabular px-3 py-2 text-right text-fg">
                      {fmtMacroRaw(r.actual_raw)}
                    </td>
                    <td className="tabular px-3 py-2 text-right text-fg-muted">
                      {fmtMacroRaw(r.forecast_raw)}
                    </td>
                    <td className="tabular px-3 py-2 text-right text-fg-dim">
                      {fmtMacroRaw(r.previous_raw)}
                    </td>
                    <td className="px-3 py-2 text-right text-[11px]">
                      {r.surprise != null ? fmtSurprise(r) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
