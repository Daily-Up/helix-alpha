"use client";

/**
 * Dashboard (/app). The hero masthead leads; below it, a glance surface where
 * every section wears the same "Put Helix to work" card theme — a dark panel
 * with a faint warm (Helix-orange) gradient top-left, a low-opacity orange
 * hairline border, an orange eyebrow, a light Fraunces title, orange outlined
 * buttons and orange numbered step chips. Data/logic (hit-rate ≥10 rule, 48h
 * signal freshness, trade deep-links, briefing fields, wealth → fund pages)
 * is unchanged from the previous commit — this is a visual theme pass.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { cn } from "@/components/ui/cn";
import { Num } from "@/components/ui/Num";
import { Timestamp } from "@/components/ui/Timestamp";
import { AssetLogo } from "@/components/ui/AssetLogo";
import { WealthSparkline } from "@/components/wealth/WealthSparkline";
import { useSodexAuth } from "@/components/sodex/auth/SodexAuthProvider";
import { getPerpsAccountState } from "@/lib/sodex-onchain/client";
import { fmtAssetSymbol } from "@/lib/format";

const NETWORK = "mainnet" as const;

/* ── Theme tokens ──────────────────────────────────────────────────────── */

// The reference card: dark surface + warm orange gradient top-left + a
// low-opacity orange hairline, ~12px radius, ~20px padding.
const CARD =
  "relative overflow-hidden rounded-xl border border-accent/30 bg-gradient-to-br from-accent/10 via-surface to-surface p-5";
// Outlined Helix-orange button (faint tint fill, orange text) — "Connect SoDEX →".
const BTN =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-accent/50 bg-accent/20 px-4 py-2.5 text-[13px] font-medium text-accent-2 transition-colors hover:bg-accent/30";
// Light large figure, matching the Fraunces title weight.
const FIG = "font-[var(--font-fraunces)] font-light leading-none text-fg tabular-nums";

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

const REGIME_WORD: Record<Regime, { label: string; cls: string }> = {
  risk_on: { label: "Risk-on", cls: "text-positive" },
  risk_off: { label: "Risk-off", cls: "text-negative" },
  mixed: { label: "Mixed", cls: "text-accent-2" },
  neutral: { label: "Neutral", cls: "text-fg-dim" },
};

const CATEGORY_LABEL: Record<string, string> = {
  stable_earn: "Stable Earn",
  curated_etf: "Curated ETF",
  specialty: "Specialty",
};

const OUTCOME_META: Record<
  "target_hit" | "stop_hit" | "flat",
  { label: string; cls: string; mark: string }
> = {
  target_hit: { label: "Target hit", cls: "text-positive", mark: "✓" },
  stop_hit: { label: "Stop hit", cls: "text-negative", mark: "✗" },
  flat: { label: "Flat", cls: "text-fg-dim", mark: "—" },
};

export function HomePage() {
  const [data, setData] = useState<HomeData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/data/home")
      .then((r) => r.json())
      .then((j: HomeData) => setData(j))
      .finally(() => setLoading(false));
  }, []);

  // A briefing older than 36h isn't "today's" — the generator has fallen
  // behind. Tag it amber rather than presenting it as current.
  const briefingStale =
    data?.briefing != null &&
    Date.now() - data.briefing.generated_at > 36 * 60 * 60 * 1000;

  return (
    <div className="flex flex-col gap-5">
      {/* ── Masthead (unchanged) ── */}
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
          <AccountCard />
          <SnapshotCard data={data} />
          <BriefingCard data={data} stale={briefingStale} />
          <section className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <TopSignalsCard data={data} />
            <WealthCard data={data} />
          </section>
          <HowItWorksCard />
          <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-fg-dim">
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
          </footer>
        </>
      ) : null}
    </div>
  );
}

/* ─────────────────────── 1 · Connect / account card ──────────────────── */

function AccountCard() {
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

  const money = (n: number) =>
    `$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const signed = (n: number) => `${n >= 0 ? "+" : "−"}${money(n)}`;

  // Live — "Your SoDEX account".
  if (auth.ready) {
    return (
      <section className={CARD}>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <Eyebrow>
              Live trading · Connected
              {auth.address ? (
                <span className="ml-2 font-normal normal-case tracking-normal text-fg-dim">
                  {auth.address.slice(0, 6)}…{auth.address.slice(-4)}
                </span>
              ) : null}
            </Eyebrow>
            <h2 className="mt-1.5 font-[var(--font-fraunces)] text-[19px] font-light leading-tight text-fg">
              Your SoDEX account
            </h2>
            <div className="mt-3 flex flex-wrap items-end gap-x-9 gap-y-3">
              <AcctStat label="Equity" value={acct ? money(acct.equity) : "…"} />
              <AcctStat
                label="uPnL today"
                value={acct ? signed(acct.upnl) : "…"}
                tone={
                  acct
                    ? acct.upnl > 0
                      ? "pos"
                      : acct.upnl < 0
                        ? "neg"
                        : "def"
                    : "def"
                }
              />
              <AcctStat
                label="Open positions"
                value={acct ? String(acct.positions) : "…"}
              />
            </div>
          </div>
          <Link href="/trade" className={cn(BTN, "shrink-0")}>
            Open terminal →
          </Link>
        </div>
      </section>
    );
  }

  // Demo — "Put Helix to work with real capital".
  return (
    <section className={CARD}>
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="max-w-2xl">
          <Eyebrow>Live trading · SoDEX mainnet</Eyebrow>
          <h2 className="mt-1.5 font-[var(--font-fraunces)] text-[19px] font-light leading-tight text-fg">
            Put Helix to work with real capital
          </h2>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-muted">
            Connect once to trade signals, news and Wealth products as real
            SoDEX orders, one click each.{" "}
            <span className="text-fg-dim">
              Helix never holds your keys; you sign in your own wallet.
            </span>
          </p>
          <ol className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[11px] text-fg-muted">
            <Step n={1} label="Connect wallet" />
            <Arrow />
            <Step n={2} label="Approve once (1 bp builder fee)" />
            <Arrow />
            <Step n={3} label="Trade from your browser" />
          </ol>
        </div>
        <button
          onClick={() => auth.openSetup()}
          className={cn(BTN, "shrink-0")}
        >
          {auth.step === "wallet" ? "Connect SoDEX" : "Finish setup"} →
        </button>
      </div>
    </section>
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
    <div className="flex flex-col gap-1">
      <span className="text-[9.5px] font-medium uppercase tracking-wider text-fg-dim">
        {label}
      </span>
      <span
        className={cn(
          FIG,
          "text-[20px]",
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

/* ─────────────────────────── 2 · Live snapshot ───────────────────────── */

function SnapshotCard({ data }: { data: HomeData }) {
  const c = data.calibration;
  const rateReady = c.graded >= 10 && c.hit_rate != null;
  const wealthHref = data.wealth.usdc_earn
    ? `/wealth/${encodeURIComponent(data.wealth.usdc_earn.fund_id)}`
    : "/wealth-index";
  return (
    <section className={CARD}>
      <Eyebrow>Live snapshot</Eyebrow>
      <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-5 sm:grid-cols-4">
        <Figure
          href="/signals"
          label="Pending signals"
          value={String(data.signal_stats.total_pending)}
          sub={`${data.signal_stats.auto} auto · ${data.signal_stats.review} review`}
        />
        <Figure
          href={wealthHref}
          label={data.wealth.usdc_earn ? `${data.wealth.usdc_earn.name} · APY` : "USDC Earn · APY"}
          value={data.wealth.usdc_earn ? `${data.wealth.usdc_earn.apy.toFixed(2)}%` : "—"}
          sub={`${data.wealth.product_count} Wealth products`}
        />
        <Figure
          href="/signals?tab=graded"
          label="Signal hit rate"
          value={rateReady ? `${Math.round((c.hit_rate ?? 0) * 100)}%` : "—"}
          sub={
            rateReady
              ? `${c.graded} graded`
              : `${c.graded} graded · rate after 10`
          }
        />
        <Figure
          href="/events"
          label="Events processed"
          value={data.counts.total_events.toLocaleString()}
          sub={`${data.counts.total_classified.toLocaleString()} AI-classified`}
        />
      </div>
    </section>
  );
}

function Figure({
  href,
  label,
  value,
  sub,
}: {
  href: string;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <Link
      href={href}
      className="group -mx-1 flex min-w-0 flex-col gap-1.5 rounded-lg px-1 py-1 transition-colors hover:bg-accent/[0.05]"
    >
      <span className="truncate text-[9.5px] font-medium uppercase tracking-wider text-fg-dim">
        {label}
      </span>
      <span className={cn(FIG, "text-[27px] group-hover:text-accent-2")}>
        {value}
      </span>
      <span className="truncate text-[10px] text-fg-dim">{sub}</span>
    </Link>
  );
}

/* ─────────────────────────── 3 · Daily briefing ──────────────────────── */

function BriefingCard({ data, stale }: { data: HomeData; stale: boolean }) {
  const b = data.briefing;
  if (!b) {
    return (
      <section className={CARD}>
        <Eyebrow>Daily briefing</Eyebrow>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="font-[var(--font-fraunces)] text-[18px] font-light text-fg">
              No briefing for today yet.
            </div>
            <div className="mt-0.5 text-[12px] text-fg-muted">
              Claude reads everything and writes a 3-paragraph market read in
              ~25s.
            </div>
          </div>
          <Link href="/briefing" className={cn(BTN, "shrink-0")}>
            Generate briefing →
          </Link>
        </div>
      </section>
    );
  }
  const rw = REGIME_WORD[b.regime];
  const tp = b.top_pick;
  return (
    <section className={cn(CARD, stale && "border-warning/40")}>
      <div className="flex flex-wrap items-center gap-2">
        <Eyebrow>
          Daily briefing · {b.date} ·{" "}
          <span className={rw.cls}>{rw.label.toUpperCase()}</span>
        </Eyebrow>
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

      <h2 className="mt-2.5 font-[var(--font-fraunces)] text-[22px] font-light leading-snug text-fg">
        {b.headline}
      </h2>
      {b.summary ? (
        <p className="mt-2 line-clamp-2 max-w-3xl text-[12.5px] leading-relaxed text-fg-muted">
          {b.summary}
        </p>
      ) : null}

      {tp ? (
        <div className="mt-4 rounded-lg border border-accent/20 bg-accent/[0.04] p-3.5">
          <Eyebrow>Top pick today</Eyebrow>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <AssetLogo symbol={tp.asset_symbol} size={18} />
            <span className="font-mono text-sm font-semibold text-fg">
              {fmtAssetSymbol(tp.asset_symbol)}
            </span>
            <span
              className={cn(
                "text-[11px] font-semibold uppercase tracking-wide",
                tp.direction === "long"
                  ? "text-positive"
                  : tp.direction === "short"
                    ? "text-negative"
                    : "text-accent-2",
              )}
            >
              {tp.direction}
            </span>
            <span className="ml-auto text-[11px] text-fg-muted">
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
          className="mt-3 inline-block text-[11px] text-accent-2 hover:underline"
        >
          Read the full briefing →
        </Link>
      )}
    </section>
  );
}

/* ─────────────────────────── 4a · Top signals ────────────────────────── */

function TopSignalsCard({ data }: { data: HomeData }) {
  const sigs = data.top_signals;
  const graded = data.recent_graded;
  const showGraded = sigs.length === 0 && graded.length > 0;
  return (
    <section className={CARD}>
      <CardHead
        eyebrow={showGraded ? "Recently graded" : "Top signals"}
        href="/signals"
        action="All signals"
      />
      {sigs.length > 0 ? (
        <ul className="divide-y divide-accent/10">
          {sigs.map((s) => (
            <li key={s.id} className="flex items-start gap-3 py-3 first:pt-0">
              <AssetLogo symbol={s.asset_symbol} size={22} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-mono text-[13px] font-semibold text-fg">
                    {fmtAssetSymbol(s.asset_symbol, s.asset_kind)}
                  </span>
                  <span
                    className={cn(
                      "text-[11px] font-semibold uppercase tracking-wide",
                      s.direction === "long"
                        ? "text-positive"
                        : "text-negative",
                    )}
                  >
                    {s.direction}
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-fg-dim">
                    {s.tier}
                  </span>
                  {s.event_type ? (
                    <span className="text-[10px] uppercase tracking-wide text-fg-dim">
                      · {s.event_type}
                    </span>
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
        <ul className="divide-y divide-accent/10">
          <li className="pb-2 text-[11px] text-fg-dim">
            No fresh signals — latest graded calls:
          </li>
          {graded.map((g) => {
            const m = OUTCOME_META[g.outcome];
            return (
              <li key={g.signal_id} className="flex items-center gap-3 py-3">
                <AssetLogo symbol={g.asset_symbol} size={22} />
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-mono text-[13px] font-semibold text-fg">
                    {fmtAssetSymbol(g.asset_symbol, g.asset_kind)}
                  </span>
                  <span
                    className={cn(
                      "text-[11px] font-semibold uppercase tracking-wide",
                      g.direction === "long"
                        ? "text-positive"
                        : "text-negative",
                    )}
                  >
                    {g.direction}
                  </span>
                  <span className={cn("text-[11px] font-semibold", m.cls)}>
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
        <div className="py-8 text-center text-[13px] text-fg-dim">
          No fresh signals right now.
        </div>
      )}
    </section>
  );
}

/* ─────────────────────────── 4b · Wealth ─────────────────────────────── */

function WealthCard({ data }: { data: HomeData }) {
  const hs = data.wealth.highlights;
  return (
    <section className={CARD}>
      <CardHead
        eyebrow="Wealth highlights"
        href="/wealth-index"
        action="Wealth Index"
      />
      {hs.length === 0 ? (
        <div className="py-8 text-center text-[13px] text-fg-dim">
          Couldn&apos;t load SoDEX Wealth right now.
        </div>
      ) : (
        <ul className="divide-y divide-accent/10">
          {hs.map((h) => (
            <li key={h.fund_id}>
              <Link
                href={`/wealth/${encodeURIComponent(h.fund_id)}`}
                className="-mx-1 flex items-center gap-3 rounded-lg px-1 py-3 transition-colors first:pt-0 hover:bg-accent/[0.05]"
              >
                <Monogram symbol={h.symbol} name={h.name} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-fg">
                      {h.name}
                    </span>
                    <span className="shrink-0 rounded border border-accent/20 bg-accent/5 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-accent-2">
                      {CATEGORY_LABEL[h.category] ?? h.category}
                    </span>
                  </div>
                  <div className="mt-1 max-w-[150px]">
                    <WealthSparkline fundId={h.fund_id} color="var(--accent)" />
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
                  <span className="text-[11px] text-accent-2">→</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ─────────────────────────── 5 · How it works ────────────────────────── */

const STEPS = ["Ingest", "Classify", "Signal", "Act", "Calibrate"];

function HowItWorksCard() {
  return (
    <section className={cn(CARD, "py-4")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Eyebrow>How it works</Eyebrow>
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[11px] text-fg-muted">
          {STEPS.map((s, i) => (
            <span key={s} className="inline-flex items-center gap-2">
              <Step n={i + 1} label={s} />
              {i < STEPS.length - 1 ? <Arrow /> : null}
            </span>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ─────────────────────────── shared bits ─────────────────────────────── */

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-[var(--font-jetbrains-mono)] text-[10px] font-medium uppercase tracking-[0.2em] text-accent-2">
      {children}
    </div>
  );
}

function CardHead({
  eyebrow,
  href,
  action = "View all",
}: {
  eyebrow: string;
  href?: string;
  action?: string;
}) {
  return (
    <div className="mb-3.5 flex items-center justify-between gap-3">
      <Eyebrow>{eyebrow}</Eyebrow>
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

function Step({ n, label }: { n: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="flex h-4 w-4 items-center justify-center rounded-full border border-accent/40 bg-accent/15 text-[9px] font-semibold text-accent-2">
        {n}
      </span>
      {label}
    </span>
  );
}

function Arrow() {
  return <span className="text-fg-dim">→</span>;
}

function ConvictionBar({ pct }: { pct: number }) {
  const p = Math.max(0, Math.min(100, pct));
  return (
    <div className="h-[3px] w-full overflow-hidden rounded-full bg-accent/10">
      <div
        className="h-full rounded-full bg-accent transition-all"
        style={{ width: `${p}%` }}
      />
    </div>
  );
}

function Monogram({ symbol, name }: { symbol: string | null; name: string }) {
  const txt =
    (symbol || name).replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() ||
    "?";
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-accent/20 bg-accent/5 font-[var(--font-jetbrains-mono)] text-[10px] font-semibold text-accent-2">
      {txt}
    </span>
  );
}

/** Deep-link into the trade terminal with the signal's market + side preset,
 *  tagged ?src=event. Outlined + tinted-fill shape (like the orange button),
 *  but keeps green/red for the side. Only when the asset maps to a SoDEX
 *  market (sodex_symbol present). */
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
        "inline-flex shrink-0 items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
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
