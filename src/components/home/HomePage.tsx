"use client";

/**
 * Dashboard (/app). The hero masthead leads (identity + live status); below it,
 * a redesigned glance surface built from the same raised-panel design system as
 * the Terminal / Portfolio / Event Stream: a connect banner (or account strip
 * when live), four clickable stat tiles, the Daily Briefing, a two-column
 * signals + wealth row, and a slim "how it works" strip for new visitors.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { cn } from "@/components/ui/cn";
import { Badge } from "@/components/ui/Badge";
import { Num } from "@/components/ui/Num";
import { Timestamp } from "@/components/ui/Timestamp";
import { AssetLogo } from "@/components/ui/AssetLogo";
import { WealthSparkline } from "@/components/wealth/WealthSparkline";
import { useSodexAuth } from "@/components/sodex/auth/SodexAuthProvider";
import { getPerpsAccountState } from "@/lib/sodex-onchain/client";
import { fmtAssetSymbol } from "@/lib/format";

const NETWORK = "mainnet" as const;

interface HomeData {
  counts: {
    total_events: number;
    total_classified: number;
    total_signals: number;
    total_briefings: number;
    last_event_at: number | null;
  };
  signal_stats: {
    total_pending: number;
    auto: number;
    review: number;
    info: number;
    avg_conf: number | null;
  };
  top_signals: Array<{
    id: string;
    asset_symbol: string;
    asset_kind: string;
    sodex_symbol: string | null;
    direction: "long" | "short";
    tier: "auto" | "review" | "info";
    confidence: number;
    fired_at: number;
    event_title: string | null;
    event_type: string | null;
  }>;
  recent_graded: Array<{
    signal_id: string;
    asset_symbol: string;
    asset_kind: string;
    sodex_symbol: string | null;
    direction: "long" | "short";
    outcome: "target_hit" | "stop_hit" | "flat";
    realized_pct: number | null;
    outcome_at: number | null;
  }>;
  wealth: {
    product_count: number;
    top_yield: { name: string; apy: number } | null;
    usdc_earn: { name: string; apy: number; fund_id: string } | null;
    highlights: Array<{
      fund_id: string;
      name: string;
      symbol: string | null;
      category: string;
      metric_label: string;
      metric_value: number | null;
      roi_1y: number | null;
      change_pct: number | null;
    }>;
  };
  briefing: {
    date: string;
    headline: string;
    summary: string;
    regime: "risk_on" | "risk_off" | "mixed" | "neutral";
    top_pick: {
      asset_id: string;
      asset_symbol: string;
      direction: "long" | "short" | "watch";
      thesis: string;
      conviction: number;
    } | null;
    top_pick_sodex: string | null;
    generated_at: number;
  } | null;
  calibration: {
    graded: number;
    hit_rate: number | null;
    first_grade_at: number | null;
  };
}

type Regime = "risk_on" | "risk_off" | "mixed" | "neutral";

const REGIME_DOT: Record<Regime, string> = {
  risk_on: "bg-positive",
  risk_off: "bg-negative",
  mixed: "bg-accent",
  neutral: "bg-fg-dim",
};

const REGIME_CHIP: Record<Regime, { label: string; cls: string }> = {
  risk_on: { label: "Risk-on", cls: "bg-positive/15 text-positive" },
  risk_off: { label: "Risk-off", cls: "bg-negative/15 text-negative" },
  mixed: { label: "Mixed", cls: "bg-accent/15 text-accent-2" },
  neutral: { label: "Neutral", cls: "bg-surface-2 text-fg-dim" },
};

const CATEGORY_LABEL: Record<string, string> = {
  stable_earn: "Stable Earn",
  curated_etf: "Curated ETF",
  specialty: "Specialty",
};

const OUTCOME_META: Record<
  "target_hit" | "stop_hit" | "flat",
  { label: string; tone: "positive" | "negative" | "default"; mark: string }
> = {
  target_hit: { label: "Target hit", tone: "positive", mark: "✓" },
  stop_hit: { label: "Stop hit", tone: "negative", mark: "✗" },
  flat: { label: "Flat", tone: "default", mark: "—" },
};

export function HomePage() {
  const auth = useSodexAuth();
  const [data, setData] = useState<HomeData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/data/home")
      .then((r) => r.json())
      .then((j: HomeData) => setData(j))
      .finally(() => setLoading(false));
  }, []);

  // A briefing older than 36h isn't "today's" — the generator (cron / tick)
  // has fallen behind. Tag it amber rather than presenting it as current.
  const briefingStale =
    data?.briefing != null &&
    Date.now() - data.briefing.generated_at > 36 * 60 * 60 * 1000;

  return (
    <div className="flex flex-col gap-6">
      {/* ── Masthead: identity + live status (the product leads, not a pitch) ── */}
      <header className="flex flex-col gap-4 border-b border-line pb-6 md:flex-row md:items-end md:justify-between">
        <div className="max-w-2xl">
          <div className="font-[var(--font-jetbrains-mono)] text-[10px] font-medium uppercase tracking-[0.22em] text-fg-dim">
            SoSoValue · SoDEX · Anthropic Claude
          </div>
          <h1 className="mt-3 font-[var(--font-fraunces)] text-[28px] font-light leading-[1.06] tracking-[-0.02em] text-fg md:text-[34px]">
            Event-driven alpha,{" "}
            <span className="italic text-accent-2">audited in the open.</span>
          </h1>
          <p className="mt-2.5 max-w-xl text-[13px] leading-relaxed text-fg-muted">
            Live news, classified by Claude into tiered signals, mapped to SoDEX
            markets and Wealth products, with every call graded against what
            actually happened.
          </p>
        </div>
        {data ? (
          <div className="flex shrink-0 items-center gap-5 font-[var(--font-jetbrains-mono)] text-[11px] text-fg-dim">
            {data.briefing && !briefingStale ? (
              <span className="inline-flex items-center gap-1.5">
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    REGIME_DOT[data.briefing.regime],
                  )}
                />
                {data.briefing.regime.replace("_", "-").toUpperCase()}
              </span>
            ) : null}
            {briefingStale ? (
              <span className="inline-flex items-center gap-1.5 text-warning">
                <span className="h-1.5 w-1.5 rounded-full bg-warning" />
                BRIEFING DELAYED
              </span>
            ) : null}
            {data.counts.last_event_at ? (
              <span>
                last event{" "}
                <Timestamp ms={data.counts.last_event_at} mode="relative" />
              </span>
            ) : null}
          </div>
        ) : null}
      </header>

      {loading && !data ? (
        <div className="text-sm text-fg-dim">Loading live snapshot…</div>
      ) : null}

      {data ? (
        <>
          {/* 1 · Connect banner (demo) / account strip (live) */}
          <AccountBar />

          {/* 2 · Clickable stat tiles */}
          <StatTiles data={data} />

          {/* 3 · Daily briefing */}
          <BriefingPanel data={data} stale={briefingStale} />

          {/* 4 · Signals + Wealth */}
          <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <TopSignalsPanel data={data} />
            <WealthHighlightsPanel data={data} />
          </section>

          {/* 5 · How it works — slim, and only for visitors not yet live */}
          {!auth.ready ? <HowItWorks /> : null}

          {/* Data sources — quiet footer */}
          <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-line bg-surface px-4 py-3 text-[11px] text-fg-dim">
            <span>
              <span className="text-fg-muted">News · sectors · ETF · macro:</span>{" "}
              SoSoValue
            </span>
            <span>
              <span className="text-fg-muted">Venue:</span> SoDEX (perps + spot)
            </span>
            <span>
              <span className="text-fg-muted">Intelligence:</span> Anthropic Claude
            </span>
            {data.counts.last_event_at ? (
              <span className="ml-auto">
                last event{" "}
                <Timestamp ms={data.counts.last_event_at} mode="relative" />
              </span>
            ) : null}
          </footer>
        </>
      ) : null}
    </div>
  );
}

/* ─────────────────────────── 1 · Account bar ─────────────────────────── */

function AccountBar() {
  const auth = useSodexAuth();
  const [acct, setAcct] = useState<{
    equity: number;
    upnl: number;
    positions: number;
  } | null>(null);

  useEffect(() => {
    if (!auth.ready || !auth.address) {
      setAcct(null);
      return;
    }
    let cancelled = false;
    getPerpsAccountState(NETWORK, auth.address as `0x${string}`)
      .then((s) => {
        if (cancelled) return;
        const equity = Number(s.av) || 0;
        const upnl = (s.P ?? []).reduce(
          (t, p) => t + (p.ur != null ? Number(p.ur) || 0 : 0),
          0,
        );
        const positions = (s.P ?? []).filter((p) => Number(p.sz) !== 0).length;
        setAcct({ equity, upnl, positions });
      })
      .catch(() => !cancelled && setAcct(null));
    return () => {
      cancelled = true;
    };
  }, [auth.ready, auth.address]);

  if (auth.loading) return null;

  // Not live — slim one-row connect banner (no AlphaIndex wording).
  if (!auth.ready) {
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface px-4 py-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-4">
          <span className="text-[13px] text-fg">
            Trade signals, news and Wealth products on SoDEX from Helix.
          </span>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[11px] text-fg-muted">
            <ConnectStep n={1} label="Connect wallet" />
            <span className="text-fg-dim">·</span>
            <ConnectStep n={2} label="Approve 1 bp builder fee" />
            <span className="text-fg-dim">·</span>
            <ConnectStep n={3} label="Trade" />
          </div>
        </div>
        {/* .trade-terminal so --accent-trade (primary blue) resolves, matching
            the header Connect button exactly. */}
        <span className="trade-terminal shrink-0">
          <button
            onClick={() => auth.openSetup()}
            className="w-full rounded-full bg-[color:var(--accent-trade)] px-4 py-1.5 text-[12px] font-semibold text-[#0b0e11] transition-all hover:brightness-110 md:w-auto"
          >
            {auth.step === "wallet" ? "Connect" : "Finish setup"}
          </button>
        </span>
      </div>
    );
  }

  // Live — compact account strip.
  const money = (n: number) =>
    `$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const signed = (n: number) => `${n >= 0 ? "+" : "−"}${money(n)}`;
  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-xl border border-positive/25 bg-positive/[0.04] px-4 py-3">
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-positive">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-positive" />
        Connected
        {auth.address ? (
          <span className="font-[var(--font-jetbrains-mono)] text-fg-dim">
            · {auth.address.slice(0, 6)}…{auth.address.slice(-4)}
          </span>
        ) : null}
      </span>
      <AcctStat label="Equity" value={acct ? money(acct.equity) : "…"} />
      <AcctStat
        label="uPnL today"
        value={acct ? signed(acct.upnl) : "…"}
        tone={
          acct ? (acct.upnl > 0 ? "pos" : acct.upnl < 0 ? "neg" : "def") : "def"
        }
      />
      <AcctStat
        label="Open positions"
        value={acct ? String(acct.positions) : "…"}
      />
      <Link
        href="/trade"
        className="ml-auto shrink-0 rounded-md border border-positive/40 bg-positive/10 px-3 py-1.5 text-[12px] font-medium text-positive transition-colors hover:bg-positive/20"
      >
        Open terminal →
      </Link>
    </div>
  );
}

function ConnectStep({ n, label }: { n: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="flex h-4 w-4 items-center justify-center rounded-full border border-accent/40 bg-accent/15 text-[9px] font-semibold text-accent-2">
        {n}
      </span>
      {label}
    </span>
  );
}

function AcctStat({
  label,
  value,
  tone = "def",
}: {
  label: string;
  value: string;
  tone?: "pos" | "neg" | "def";
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[9px] font-medium uppercase tracking-wider text-fg-dim">
        {label}
      </span>
      <span
        className={cn(
          "font-[var(--font-jetbrains-mono)] text-[15px] font-semibold tabular-nums",
          tone === "pos"
            ? "text-positive"
            : tone === "neg"
              ? "text-negative"
              : "text-fg",
        )}
      >
        {value}
      </span>
    </div>
  );
}

/* ─────────────────────────── 2 · Stat tiles ──────────────────────────── */

function StatTiles({ data }: { data: HomeData }) {
  const c = data.calibration;
  const rateReady = c.graded >= 10 && c.hit_rate != null;
  const wealthHref = data.wealth.usdc_earn
    ? `/wealth/${encodeURIComponent(data.wealth.usdc_earn.fund_id)}`
    : "/wealth-index";
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <TileLink
        href="/signals"
        label="Pending signals"
        value={String(data.signal_stats.total_pending)}
        sub={`${data.signal_stats.auto} auto · ${data.signal_stats.review} review`}
        tone="accent"
      />
      <TileLink
        href={wealthHref}
        label={data.wealth.usdc_earn ? `${data.wealth.usdc_earn.name} · APY` : "USDC Earn APY"}
        value={data.wealth.usdc_earn ? `${data.wealth.usdc_earn.apy.toFixed(2)}%` : "—"}
        sub={`${data.wealth.product_count} Wealth products`}
        tone="accent"
      />
      <TileLink
        href="/signals?tab=graded"
        label="Signal hit rate"
        value={rateReady ? `${Math.round((c.hit_rate ?? 0) * 100)}%` : "—"}
        sub={
          rateReady
            ? `${c.graded} graded`
            : `${c.graded} graded · rate after 10`
        }
        tone={
          rateReady
            ? (c.hit_rate ?? 0) >= 0.55
              ? "positive"
              : (c.hit_rate ?? 0) <= 0.45
                ? "negative"
                : "default"
            : "default"
        }
      />
      <TileLink
        href="/events"
        label="Events processed"
        value={data.counts.total_events.toLocaleString()}
        sub={`${data.counts.total_classified.toLocaleString()} AI-classified`}
      />
    </div>
  );
}

function TileLink({
  href,
  label,
  value,
  sub,
  tone = "default",
}: {
  href: string;
  label: string;
  value: string;
  sub: string;
  tone?: "default" | "positive" | "negative" | "accent";
}) {
  const valCls =
    tone === "positive"
      ? "text-positive"
      : tone === "negative"
        ? "text-negative"
        : tone === "accent"
          ? "text-accent-2"
          : "text-fg";
  return (
    <Link
      href={href}
      className="group flex min-w-0 flex-col gap-1 rounded-xl border border-line bg-surface px-4 py-3 transition-colors hover:border-line-2 hover:bg-surface-2/30"
    >
      <span className="truncate text-[9px] font-medium uppercase tracking-wider text-fg-dim">
        {label}
      </span>
      <span
        className={cn(
          "font-[var(--font-jetbrains-mono)] text-[20px] font-semibold tabular-nums",
          valCls,
        )}
      >
        {value}
      </span>
      <span className="truncate text-[10px] text-fg-dim">{sub}</span>
    </Link>
  );
}

/* ─────────────────────────── 3 · Briefing ────────────────────────────── */

function BriefingPanel({ data, stale }: { data: HomeData; stale: boolean }) {
  const b = data.briefing;
  if (!b) {
    return (
      <Panel>
        <PanelHead title="Daily briefing" href="/briefing" action="Briefing" />
        <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-[13px] text-fg">No briefing for today yet.</div>
            <div className="text-[11px] text-fg-dim">
              Claude reads everything and writes a 3-paragraph market read in
              ~25s.
            </div>
          </div>
          <Link
            href="/briefing"
            className="shrink-0 rounded-md border border-accent/50 bg-accent/15 px-3 py-1.5 text-[12px] font-medium text-accent-2 hover:bg-accent/25"
          >
            Generate briefing →
          </Link>
        </div>
      </Panel>
    );
  }
  const chip = REGIME_CHIP[b.regime];
  const tp = b.top_pick;
  return (
    <Panel className={stale ? "border-warning/40" : undefined}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="font-[var(--font-jetbrains-mono)] text-[10px] font-semibold uppercase tracking-[0.18em] text-fg-dim">
          Daily briefing
        </h2>
        <span className="text-[11px] text-fg-dim">{b.date}</span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
            chip.cls,
          )}
        >
          {chip.label}
        </span>
        {stale ? (
          <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-warning">
            Briefing delayed
          </span>
        ) : null}
        <span
          className={cn(
            "ml-auto text-[11px]",
            stale ? "text-warning" : "text-fg-dim",
          )}
        >
          generated <Timestamp ms={b.generated_at} mode="relative" />
        </span>
      </div>
      <div className="flex flex-col gap-3 px-4 py-4">
        <h3 className="font-[var(--font-fraunces)] text-[20px] font-light leading-snug text-fg md:text-[22px]">
          {b.headline}
        </h3>
        {b.summary ? (
          <p className="line-clamp-2 max-w-3xl text-[12.5px] leading-relaxed text-fg-muted">
            {b.summary}
          </p>
        ) : null}
        {tp ? (
          <div className="rounded-lg border border-line bg-surface-2/40 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[9.5px] font-medium uppercase tracking-wider text-accent-2">
                Top pick today
              </span>
              <AssetLogo symbol={tp.asset_symbol} size={18} />
              <span className="font-mono text-sm font-semibold text-fg">
                {fmtAssetSymbol(tp.asset_symbol)}
              </span>
              <Badge
                tone={
                  tp.direction === "long"
                    ? "positive"
                    : tp.direction === "short"
                      ? "negative"
                      : "warning"
                }
                mono
              >
                {tp.direction.toUpperCase()}
              </Badge>
              <span className="ml-auto font-[var(--font-jetbrains-mono)] text-[11px] tabular-nums text-fg-muted">
                {Math.round(tp.conviction * 100)}% conviction
              </span>
            </div>
            <div className="mt-2">
              <ConvictionBar pct={tp.conviction * 100} />
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-fg-muted">
              {tp.thesis}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              {b.top_pick_sodex &&
              (tp.direction === "long" || tp.direction === "short") ? (
                <TradeLink sodexSymbol={b.top_pick_sodex} side={tp.direction} />
              ) : null}
              <Link
                href="/briefing"
                className="text-[11px] text-accent-2 hover:underline"
              >
                Read the full briefing →
              </Link>
            </div>
          </div>
        ) : (
          <Link
            href="/briefing"
            className="self-start text-[11px] text-accent-2 hover:underline"
          >
            Read the full briefing →
          </Link>
        )}
      </div>
    </Panel>
  );
}

/* ─────────────────────────── 4a · Top signals ────────────────────────── */

function TopSignalsPanel({ data }: { data: HomeData }) {
  const sigs = data.top_signals;
  const graded = data.recent_graded;
  const showGraded = sigs.length === 0 && graded.length > 0;
  return (
    <Panel>
      <PanelHead
        title={showGraded ? "Recently graded" : "Top signals"}
        href="/signals"
        action="All signals"
      />
      {sigs.length > 0 ? (
        <ul className="divide-y divide-line">
          {sigs.map((s) => (
            <li key={s.id} className="flex items-start gap-3 px-4 py-3">
              <AssetLogo symbol={s.asset_symbol} size={22} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[13px] font-semibold text-fg">
                    {fmtAssetSymbol(s.asset_symbol, s.asset_kind)}
                  </span>
                  <Badge
                    tone={s.direction === "long" ? "positive" : "negative"}
                    mono
                  >
                    {s.direction.toUpperCase()}
                  </Badge>
                  <Badge
                    tone={
                      s.tier === "auto"
                        ? "accent"
                        : s.tier === "review"
                          ? "info"
                          : "default"
                    }
                  >
                    {s.tier}
                  </Badge>
                  {s.event_type ? (
                    <Badge tone="default">{s.event_type}</Badge>
                  ) : null}
                  <span className="ml-auto font-[var(--font-jetbrains-mono)] text-[11px] tabular-nums text-fg-muted">
                    {Math.round(s.confidence * 100)}%
                  </span>
                </div>
                {s.event_title ? (
                  <div className="mt-1 line-clamp-1 text-[12px] text-fg-muted">
                    {s.event_title}
                  </div>
                ) : null}
                <div className="mt-1.5">
                  <ConvictionBar pct={s.confidence * 100} />
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <span className="text-[10px] text-fg-dim">
                    fired <Timestamp ms={s.fired_at} mode="relative" />
                  </span>
                  {s.sodex_symbol ? (
                    <TradeLink sodexSymbol={s.sodex_symbol} side={s.direction} />
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : showGraded ? (
        <ul className="divide-y divide-line">
          <li className="px-4 pt-3 text-[11px] text-fg-dim">
            No fresh signals — latest graded calls:
          </li>
          {graded.map((g) => {
            const m = OUTCOME_META[g.outcome];
            return (
              <li
                key={g.signal_id}
                className="flex items-center gap-3 px-4 py-3"
              >
                <AssetLogo symbol={g.asset_symbol} size={22} />
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[13px] font-semibold text-fg">
                    {fmtAssetSymbol(g.asset_symbol, g.asset_kind)}
                  </span>
                  <Badge
                    tone={g.direction === "long" ? "positive" : "negative"}
                    mono
                  >
                    {g.direction.toUpperCase()}
                  </Badge>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 text-[11px] font-semibold",
                      m.tone === "positive"
                        ? "text-positive"
                        : m.tone === "negative"
                          ? "text-negative"
                          : "text-fg-dim",
                    )}
                  >
                    {m.mark} {m.label}
                  </span>
                </div>
                {g.realized_pct != null ? (
                  <span className="ml-auto">
                    <Num
                      value={g.realized_pct}
                      unit="%"
                      sign
                      dp={2}
                      tone="auto"
                      tier="secondary"
                    />
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="px-4 py-10 text-center text-[13px] text-fg-dim">
          No fresh signals right now.
        </div>
      )}
    </Panel>
  );
}

/* ─────────────────────────── 4b · Wealth ─────────────────────────────── */

function WealthHighlightsPanel({ data }: { data: HomeData }) {
  const hs = data.wealth.highlights;
  return (
    <Panel>
      <PanelHead
        title="Wealth highlights"
        href="/wealth-index"
        action="Wealth Index"
      />
      {hs.length === 0 ? (
        <div className="px-4 py-10 text-center text-[13px] text-fg-dim">
          Couldn&apos;t load SoDEX Wealth right now.
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {hs.map((h) => (
            <li key={h.fund_id}>
              <Link
                href={`/wealth/${encodeURIComponent(h.fund_id)}`}
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2/30"
              >
                <Monogram symbol={h.symbol} name={h.name} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-fg">
                      {h.name}
                    </span>
                    <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-fg-dim">
                      {CATEGORY_LABEL[h.category] ?? h.category}
                    </span>
                  </div>
                  <div className="mt-1 w-full max-w-[160px]">
                    <WealthSparkline fundId={h.fund_id} />
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-0.5">
                  <span className="text-[9px] uppercase tracking-wider text-fg-dim">
                    1Y
                  </span>
                  <Num
                    value={h.roi_1y ?? h.metric_value}
                    unit="%"
                    sign
                    dp={1}
                    tone="auto"
                    tier="secondary"
                  />
                  {h.change_pct != null ? (
                    <span className="inline-flex items-center gap-1 text-[10px] text-fg-dim">
                      24h
                      <Num
                        value={h.change_pct}
                        unit="%"
                        sign
                        dp={2}
                        tone="auto"
                        tier="context"
                      />
                    </span>
                  ) : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* ─────────────────────────── 5 · How it works ────────────────────────── */

const STEPS = ["Ingest", "Classify", "Signal", "Act", "Calibrate"];

function HowItWorks() {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2 rounded-xl border border-line bg-surface px-4 py-3">
      <span className="font-[var(--font-jetbrains-mono)] text-[9px] font-semibold uppercase tracking-wider text-fg-dim">
        How it works
      </span>
      {STEPS.map((s, i) => (
        <span
          key={s}
          className="inline-flex items-center gap-2 text-[11px] text-fg-muted"
        >
          <span className="inline-flex items-center gap-1.5">
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-accent/20 text-[9px] font-bold text-accent-2">
              {i + 1}
            </span>
            {s}
          </span>
          {i < STEPS.length - 1 ? <span className="text-fg-dim">→</span> : null}
        </span>
      ))}
    </div>
  );
}

/* ─────────────────────────── shared bits ─────────────────────────────── */

function Panel({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-xl border border-line bg-surface",
        className,
      )}
    >
      {children}
    </section>
  );
}

function PanelHead({
  title,
  href,
  action = "View all",
}: {
  title: string;
  href?: string;
  action?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
      <h2 className="font-[var(--font-jetbrains-mono)] text-[10px] font-semibold uppercase tracking-[0.18em] text-fg-dim">
        {title}
      </h2>
      {href ? (
        <Link
          href={href}
          className="shrink-0 text-[11px] text-accent-2 hover:underline"
        >
          {action} →
        </Link>
      ) : null}
    </div>
  );
}

function ConvictionBar({ pct }: { pct: number }) {
  const p = Math.max(0, Math.min(100, pct));
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-surface-2">
      <div
        className="h-full rounded-full bg-accent transition-all"
        style={{ width: `${p}%` }}
      />
    </div>
  );
}

function Monogram({
  symbol,
  name,
}: {
  symbol: string | null;
  name: string;
}) {
  const txt =
    (symbol || name).replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() ||
    "?";
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-surface-2 font-[var(--font-jetbrains-mono)] text-[10px] font-semibold text-fg-muted">
      {txt}
    </span>
  );
}

/** Deep-link into the trade terminal with the signal's market + side preset,
 *  tagged ?src=event (the same attribution the Event Stream uses). Only
 *  rendered when the signal maps to a SoDEX market (sodex_symbol present). */
function TradeLink({
  sodexSymbol,
  side,
}: {
  sodexSymbol: string;
  side: "long" | "short";
}) {
  return (
    <Link
      href={`/trade?market=${encodeURIComponent(sodexSymbol)}&side=${side}&src=event`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-medium transition-colors",
        side === "long"
          ? "border-positive/40 bg-positive/10 text-positive hover:bg-positive/20"
          : "border-negative/40 bg-negative/10 text-negative hover:bg-negative/20",
      )}
      title={`Open ${sodexSymbol} in the terminal, ${side} preset`}
    >
      ▶ Trade {side.toUpperCase()}
    </Link>
  );
}
