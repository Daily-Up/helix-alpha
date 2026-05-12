"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Stat } from "@/components/ui/Stat";
import { HeroStat, SubStat } from "@/components/ui/HeroStat";
import { StatSkeleton, PanelSkeleton } from "@/components/ui/Skeleton";
import { useBulkMountReveal } from "@/hooks/useMountReveal";
import { SignalCard, type SignalCardData } from "./SignalCard";
import { cn } from "@/components/ui/cn";

export function SignalsDashboard() {
  const [signals, setSignals] = useState<SignalCardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoTrade, setAutoTrade] = useState<boolean | null>(null);
  const [generatingNow, setGeneratingNow] = useState(false);
  // Live-mode toggles a 5-min poller of /api/cron/tick. Default OFF so we
  // don't burn Claude tokens during dev. Persisted in localStorage so the
  // user's preference survives reloads.
  const [liveMode, setLiveMode] = useState(false);
  const [lastTickAt, setLastTickAt] = useState<number | null>(null);
  const [lastTickSummary, setLastTickSummary] = useState<string | null>(null);
  // Two orthogonal filters: status (active/executed/dismissed/expired) and
  // tier (all/auto/review/info). Status is the outer tab, tier is a sub-pill.
  const [statusTab, setStatusTab] = useState<
    "active" | "executed" | "dismissed" | "expired" | "all"
  >("active");
  const [tierFilter, setTierFilter] = useState<
    "all" | "auto" | "review" | "info"
  >("all");

  const fetchData = useCallback(async () => {
    try {
      const [sRes, settingsRes] = await Promise.all([
        fetch("/api/data/signals?limit=100"),
        fetch("/api/trading/settings"),
      ]);
      const sData = await sRes.json();
      const sett = await settingsRes.json();
      setSignals(sData.signals ?? []);
      setAutoTrade(!!sett.auto_trade_enabled);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const t = setInterval(fetchData, 30_000);
    return () => clearInterval(t);
  }, [fetchData]);

  // Restore live-mode preference from localStorage on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem("sosoalpha:live-mode");
    if (stored === "true") setLiveMode(true);
  }, []);

  // Run one tick (master pipeline). Returns the summary so we can show it.
  const runTick = useCallback(async () => {
    try {
      const res = await fetch("/api/cron/tick", { method: "POST" });
      const data = await res.json();
      setLastTickAt(Date.now());
      const s = data.summary ?? {};
      const ing = s.ingest ?? {};
      const gen = s.signal_gen ?? {};
      const auto = s.auto_execute ?? {};
      const summary =
        `+${ing.new_events ?? 0} news · ${ing.classified ?? 0} classified · ` +
        `${gen.created ?? 0} new signals (auto ${auto.executed ?? 0}) · ` +
        `${s.expired ?? 0} expired`;
      setLastTickSummary(summary);
      await fetchData();
    } catch (err) {
      setLastTickSummary(`tick failed: ${(err as Error).message}`);
    }
  }, [fetchData]);

  // While liveMode is on, run a tick every 5 minutes.
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        "sosoalpha:live-mode",
        liveMode ? "true" : "false",
      );
    }
    if (!liveMode) return;
    runTick(); // fire one immediately on enable
    const t = setInterval(runTick, 5 * 60 * 1000); // every 5 min
    return () => clearInterval(t);
  }, [liveMode, runTick]);

  const toggleAuto = async () => {
    const next = !(autoTrade ?? false);
    setAutoTrade(next);
    await fetch("/api/trading/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto_trade_enabled: next }),
    });
  };

  const generateNow = async () => {
    setGeneratingNow(true);
    try {
      await fetch("/api/cron/generate-signals", { method: "POST" });
      await fetchData();
    } finally {
      setGeneratingNow(false);
    }
  };

  const purgePending = async () => {
    if (!confirm("Delete ALL pending signals? Open positions are untouched.")) {
      return;
    }
    await fetch("/api/trading/purge-pending", { method: "POST" });
    await fetchData();
  };

  // Filter by status first, then by tier.
  const byStatus = (() => {
    switch (statusTab) {
      case "active":
        return signals.filter((s) => s.status === "pending");
      case "executed":
        return signals.filter((s) => s.status === "executed");
      case "dismissed":
        return signals.filter((s) => s.status === "dismissed");
      case "expired":
        return signals.filter((s) => s.status === "expired");
      case "all":
        return signals;
    }
  })();

  const filtered =
    tierFilter === "all"
      ? byStatus
      : byStatus.filter((s) => s.tier === tierFilter);

  const statusCounts = {
    active: signals.filter((s) => s.status === "pending").length,
    executed: signals.filter((s) => s.status === "executed").length,
    dismissed: signals.filter((s) => s.status === "dismissed").length,
    expired: signals.filter((s) => s.status === "expired").length,
    all: signals.length,
  };

  const counts = {
    all: byStatus.length,
    auto: byStatus.filter((s) => s.tier === "auto").length,
    review: byStatus.filter((s) => s.tier === "review").length,
    info: byStatus.filter((s) => s.tier === "info").length,
  };

  const revealRef = useBulkMountReveal();

  if (loading && signals.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <StatSkeleton key={i} />)}
        </div>
        <PanelSkeleton height="h-48" />
      </div>
    );
  }

  return (
    <div ref={revealRef} className="dash-crossfade-enter flex flex-col gap-4">
      {/* Headline: active signals count. Supporting stats sit as a
          thin row beneath the hero — the landing's stats-strip
          pattern, scaled down. Cleaner than fighting for horizontal
          space on the same row. */}
      <div className="mt-2 flex flex-col gap-6">
        <HeroStat
          label="Active signals"
          value={String(statusCounts.active)}
          change={`${statusCounts.executed} executed`}
          changeTone={statusCounts.executed > 0 ? "positive" : "neutral"}
          sub={`${signals.filter((s) => s.status === "pending" && s.tier === "auto").length} auto · ${signals.filter((s) => s.status === "pending" && s.tier === "review").length} review · ${signals.filter((s) => s.status === "pending" && s.tier === "info").length} info pending`}
        />
        <div className="grid grid-cols-3 gap-x-10 md:max-w-[640px]">
          <SubStat
            label="Auto Trade"
            value={autoTrade == null ? "—" : autoTrade ? "ON" : "OFF"}
            sub={autoTrade ? "Tier-1 signals fire" : "manual review only"}
            tone={autoTrade ? "positive" : "neutral"}
          />
          <SubStat
            label="Total Signals"
            value={String(statusCounts.all)}
            sub={`${statusCounts.expired} expired`}
          />
          <SubStat
            label="Dismissed"
            value={String(statusCounts.dismissed)}
            sub="user / gate"
          />
        </div>
      </div>

      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setLiveMode((v) => !v)}
          className={cn(
            "rounded border px-3 py-1.5 text-xs font-medium transition-colors",
            liveMode
              ? "border-info/40 bg-info/15 text-info hover:bg-info/25"
              : "border-line bg-surface text-fg-muted hover:border-line-2 hover:text-fg",
          )}
          title="When ON, runs the full pipeline every 5 minutes: pull news → classify → generate signals → auto-execute → reconcile."
        >
          {liveMode ? "● Live mode ON" : "○ Live mode OFF"}
        </button>
        <button
          onClick={toggleAuto}
          className={cn(
            "rounded border px-3 py-1.5 text-xs font-medium transition-colors",
            autoTrade
              ? "border-positive/40 bg-positive/15 text-positive hover:bg-positive/25"
              : "border-line bg-surface text-fg-muted hover:border-line-2 hover:text-fg",
          )}
        >
          {autoTrade ? "● Auto-Trade ON" : "○ Enable Auto-Trade"}
        </button>
        <button
          onClick={generateNow}
          disabled={generatingNow}
          className={cn(
            "rounded border px-3 py-1.5 text-xs font-medium transition-colors",
            generatingNow
              ? "cursor-wait border-line bg-surface-2 text-fg-dim"
              : "border-accent/40 bg-accent/15 text-accent-2 hover:bg-accent/25",
          )}
        >
          {generatingNow ? "Generating…" : "▶ Generate Signals Now"}
        </button>
        <button
          onClick={runTick}
          className="rounded border border-line px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-info/40 hover:text-info"
          title="Run the full pipeline once (ingest → classify → generate → auto-execute → reconcile)."
        >
          ⟳ Tick now
        </button>
        <button
          onClick={purgePending}
          className="rounded border border-line px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-negative/40 hover:text-negative"
          title="Delete all pending signals (does NOT close open positions)"
        >
          Purge pending
        </button>
        <span className="ml-auto text-xs text-fg-dim">
          {loading ? "loading…" : `${filtered.length} of ${counts.all}`}
        </span>
      </div>

      {/* Last tick summary */}
      {lastTickSummary ? (
        <div className="rounded border border-line bg-surface-2 px-3 py-1.5 text-[11px] text-fg-muted">
          <span className="text-fg-dim">last tick</span>{" "}
          <span className="tabular text-fg">
            {lastTickAt
              ? new Date(lastTickAt).toISOString().slice(11, 19)
              : "—"}
          </span>{" "}
          · {lastTickSummary}
        </div>
      ) : null}

      {/* Status tabs */}
      <div className="flex flex-wrap gap-1 border-b border-line">
        {(
          [
            ["active", "Active", statusCounts.active],
            ["executed", "Executed", statusCounts.executed],
            ["dismissed", "Dismissed", statusCounts.dismissed],
            ["expired", "Expired", statusCounts.expired],
            ["all", "All", statusCounts.all],
          ] as const
        ).map(([key, label, n]) => (
          <button
            key={key}
            onClick={() => setStatusTab(key)}
            className={cn(
              "dash-tab-trigger rounded-t border-b-2 px-3 py-2 text-xs font-medium transition-colors",
              statusTab === key
                ? "dash-tab-active border-accent text-fg"
                : "border-transparent text-fg-muted hover:text-fg",
            )}
          >
            {label}
            <span className="ml-1.5 text-fg-dim">({n})</span>
          </button>
        ))}
      </div>

      {/* Tier sub-pills */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wider text-fg-dim">
          Tier:
        </span>
        {(
          [
            ["all", "All", counts.all, "default"],
            ["auto", "Auto", counts.auto, "accent"],
            ["review", "Review", counts.review, "info"],
            ["info", "Info", counts.info, "default"],
          ] as const
        ).map(([key, label, n, tone]) => (
          <button
            key={key}
            onClick={() => setTierFilter(key)}
            className={cn(
              "dash-tab-trigger h-6 rounded border px-2 text-[11px] font-medium transition-colors",
              tierFilter === key
                ? tone === "accent"
                  ? "dash-tab-active border-accent/40 bg-accent/15 text-accent-2"
                  : tone === "info"
                    ? "dash-tab-active border-info/40 bg-info/15 text-info"
                    : "dash-tab-active border-line-2 bg-surface-2 text-fg"
                : "border-line bg-surface text-fg-muted hover:border-line-2 hover:text-fg",
            )}
          >
            {label} <span className="text-fg-dim">({n})</span>
          </button>
        ))}
      </div>

      {/* Feed */}
      {filtered.length === 0 && !loading ? (
        <Card>
          <CardBody className="py-10 text-center text-sm text-fg-muted">
            No signals yet. Click <strong>Generate Signals Now</strong> to scan
            recent classified events for tradable opportunities.
          </CardBody>
        </Card>
      ) : (
        <div className="flex flex-col">
          {filtered.map((s) => (
            <SignalCard key={s.id} sig={s} onAction={fetchData} />
          ))}
        </div>
      )}
    </div>
  );
}
