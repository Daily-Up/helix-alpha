/**
 * Helix — warm design direction (alternate landing page).
 *
 * Same 8 sections, same copy, same data as page.tsx.
 * Explores a warmer visual identity: brown-black base, copper accent,
 * CSS grain texture, one piece of generative art (topographic contour
 * field) as the hero anchor, richer scroll-driven motion with blur +
 * scale entrance effects.
 *
 * View at /warm to compare against the primary direction at /.
 */

import Link from "next/link";
import { WarmNav } from "@/components/landing/warm/WarmNav";
import { WarmHeroSignalCard } from "@/components/landing/warm/WarmHeroSignalCard";
import { WarmEvidenceRow } from "@/components/landing/warm/WarmEvidenceRow";
import { WarmReveal } from "@/components/landing/warm/WarmReveal";
import { TopoField } from "@/components/landing/warm/TopoField";

export const metadata = {
  title: "Helix — Event-driven alpha. Audited.",
};

const TEXT = "#f0e8db";
const TEXT_MUTED = "#9a8e7d";
const TEXT_DIM = "#6d6358";
const ACCENT = "#c87a4a";
const ACCENT_GLOW = "#d4a574";
const BG = "#12100e";

const PRIMARY_BTN_BASE =
  "inline-flex items-center gap-2 rounded-[4px] border border-[#c87a4a] bg-[#c87a4a] px-5 py-3 font-medium text-[#12100e] transition-all duration-300 hover:bg-[#b06838] hover:border-[#b06838] hover:shadow-[0_4px_24px_rgba(200,122,74,0.25)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c87a4a]";

const SECONDARY_BTN_BASE =
  "inline-flex items-center gap-2 px-1 py-3 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c87a4a]";

export default function HelixWarmLanding() {
  return (
    <div
      className="relative min-h-screen font-[var(--font-inter)]"
      style={{ background: BG, color: TEXT }}
    >
      {/* Grain texture overlay */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-[1] opacity-[0.035]"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
          backgroundRepeat: "repeat",
          backgroundSize: "256px 256px",
        }}
      />

      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded focus:bg-[#c87a4a] focus:px-4 focus:py-2 focus:text-[#12100e] focus:outline-none"
      >
        Skip to content
      </a>
      <WarmNav />

      <main id="main" className="relative z-[2]">

      {/* ─────────── Section 2: Hero ─────────── */}
      <section className="relative pt-32 md:pt-40">
        {/* Generative art anchor — topographic contour field */}
        <div className="absolute inset-0 overflow-hidden" aria-hidden>
          <div className="absolute -right-[10%] top-[5%] h-[90%] w-[60%] opacity-[0.06]">
            <TopoField />
          </div>
        </div>

        <WarmReveal immediate>
        <div className="relative mx-auto grid max-w-[1280px] grid-cols-1 gap-16 px-6 md:grid-cols-12 md:gap-8 md:px-12 md:pb-32">
          {/* LEFT — copy */}
          <div className="md:col-span-7 md:pr-8">
            <div
              className="font-[var(--font-jetbrains-mono)] text-[11px] uppercase"
              style={{ color: TEXT_MUTED, letterSpacing: "0.16em" }}
            >
              AI TRADING INTELLIGENCE · PAPER-TRADED · OPEN AUDIT
            </div>

            <h1
              className="mt-8 font-[var(--font-fraunces)] font-light leading-[1.0]"
              style={{
                fontSize: "clamp(56px, 9vw, 132px)",
                letterSpacing: "-0.02em",
                textWrap: "balance",
              }}
            >
              <span className="block">Event-driven alpha.</span>
              <span className="block font-medium" style={{ color: ACCENT_GLOW }}>
                Audited.
              </span>
            </h1>

            <p
              className="mt-12 max-w-[540px] font-[var(--font-inter)]"
              style={{ fontSize: "22px", lineHeight: "1.45", color: TEXT }}
            >
              Every signal carries its full reasoning chain. Every outcome is
              tracked. Every framework is stress-tested. Trade what you can
              verify.
            </p>

            <div className="mt-10 flex flex-wrap items-center gap-6">
              <Link
                href="/app"
                className={`${PRIMARY_BTN_BASE} text-[16px]`}
              >
                Launch dashboard <span aria-hidden>→</span>
              </Link>
              <a
                href="#how-it-works"
                className={`${SECONDARY_BTN_BASE} text-[16px]`}
                style={{ color: TEXT }}
              >
                How the audit works
              </a>
            </div>
          </div>

          {/* RIGHT — anchor signal card */}
          <div className="hidden md:col-span-5 md:block md:pl-4">
            <div className="md:sticky md:top-32">
              <WarmHeroSignalCard />
              <div
                className="mt-3 font-[var(--font-jetbrains-mono)] text-[11px]"
                style={{ color: TEXT_MUTED, letterSpacing: "0.06em" }}
              >
                Live signal · click to inspect
              </div>
            </div>
          </div>
        </div>
        </WarmReveal>
      </section>

      <WarmRule />

      {/* ─────────── Section 3: Stats strip ─────────── */}
      <section className="py-24">
        <div className="mx-auto grid max-w-[1280px] grid-cols-2 px-6 md:grid-cols-4 md:px-12">
          <WarmStat n="40+" label="INVARIANTS ENFORCED" first />
          <WarmStat n="361" label="TESTS PASSING" />
          <WarmStat n="2" label="FRAMEWORKS GRADUATED" />
          <WarmStat n="8" label="STRESS WINDOWS · INCL −35% BEAR" />
        </div>
      </section>

      <WarmRule />

      {/* ─────────── Section 4: Why audit ─────────── */}
      <section id="why-audit" className="py-32 md:py-40">
        <div className="mx-auto max-w-[1280px] px-6 md:px-12">
          <WarmReveal>
          <h2
            className="font-[var(--font-fraunces)] font-light"
            style={{
              fontSize: "clamp(36px, 5vw, 56px)",
              letterSpacing: "-0.015em",
              lineHeight: "1.1",
              textWrap: "balance",
              maxWidth: "720px",
            }}
          >
            Most AI signals are unverifiable.
            <br />
            Helix isn&apos;t.
          </h2>
          </WarmReveal>

          <WarmReveal stagger={80}>
          <div className="mt-20 grid grid-cols-1 gap-10 md:grid-cols-3 md:gap-12">
            <WarmAuditCard
              title="Per-signal audit trails"
              body="Click any signal to see its sources, classifier prompt version, conviction formula breakdown, asset relevance score, corroboration status, and gate-rule outcomes. The reasoning is exposed, not hidden behind a confidence number."
            />
            <WarmAuditCard
              title="Outcome-tracked calibration"
              body="When a signal's horizon expires, we record what actually happened — target hit, stop hit, or expired flat. The calibration dashboard shows hit rate by tier, by catalyst type, and conviction calibration curves. We measure the way real funds do."
            />
            <WarmAuditCard
              title="Stress-tested frameworks"
              body="Two portfolio frameworks running paper-traded in parallel. v2.1 was stress-tested against a real -35% BTC bear market and contained the loss to -19%. Acceptance criteria are documented; failures are visible. Trade-offs are stated."
            />
          </div>
          </WarmReveal>
        </div>
      </section>

      <WarmRule />

      {/* ─────────── Section 5: How it works ─────────── */}
      <section id="how-it-works" className="py-32 md:py-40">
        <div className="mx-auto max-w-[1280px] px-6 md:px-12">
          <WarmReveal>
          <h2
            className="font-[var(--font-fraunces)] font-light"
            style={{
              fontSize: "clamp(36px, 5vw, 56px)",
              letterSpacing: "-0.015em",
              lineHeight: "1.1",
              textWrap: "balance",
              maxWidth: "820px",
            }}
          >
            Eight stages from news to signal.
          </h2>
          </WarmReveal>

          <WarmReveal stagger={80}>
          <div className="relative mt-20 ml-6 md:ml-12">
            <span
              aria-hidden
              className="absolute left-0 top-2 bottom-2 w-px"
              style={{
                background: `linear-gradient(to bottom, transparent, ${ACCENT}80, ${ACCENT}80, transparent)`,
              }}
            />
            <ol className="relative">
            {STAGES.map((stage, i) => (
              <WarmStage
                key={stage.title}
                index={i + 1}
                title={stage.title}
                body={stage.body}
                techLabel={stage.techLabel}
              />
            ))}
            </ol>
          </div>
          </WarmReveal>
        </div>
      </section>

      <WarmRule />

      {/* ─────────── Section 6: Built for transparency ─────────── */}
      <section id="frameworks" className="py-32 md:py-40">
        <div className="mx-auto max-w-[1440px] px-6 md:px-12">
          <WarmReveal>
          <h2
            className="font-[var(--font-fraunces)] font-light"
            style={{
              fontSize: "clamp(36px, 5vw, 56px)",
              letterSpacing: "-0.015em",
              lineHeight: "1.1",
              textWrap: "balance",
              maxWidth: "820px",
            }}
          >
            Built to be inspected.
          </h2>
          </WarmReveal>

          <WarmReveal stagger={80}>
          <div className="mt-[120px] flex flex-col gap-[120px]">
            <WarmEvidenceRow
              side="left"
              eyebrow="Evidence 01"
              title="Open the box."
              body="Click any signal to see its full reasoning, the triggering news event, classifier output, gate-rule outcomes, and corroboration status. No black boxes."
              linkLabel="View live audit →"
              href="/signals"
              src="/landing/audit.png"
              alt="The audit page for a single signal — reasoning, sources, classifier output, gate-rule outcomes, corroboration status."
            />
            <WarmEvidenceRow
              side="right"
              eyebrow="Evidence 02"
              title="Live event ingestion."
              body="Every news headline is fetched, classified by Claude for actionability, sentiment, severity, and asset mapping, then gated by a corpus-similarity filter before it can fire a signal. Thousands of events on file, auto-polling for new ones."
              linkLabel="View live event stream →"
              href="/events"
              src="/landing/events.png"
              alt="The event stream — recent news headlines with classifier verdicts (event type, sentiment, severity) and asset mappings."
            />
            <WarmEvidenceRow
              side="left"
              eyebrow="Evidence 03"
              title="An AI-managed index, paper-traded live."
              body="AlphaIndex allocates across BTC, ETH, L1s, RWA, sector indexes, and perps based on accumulated news signals, sector momentum, and ETF flows. Real SoDEX prices, simulated fills. Rebalance rationale written by Claude — visible for every rebalance."
              linkLabel="View live AlphaIndex →"
              href="/index-fund"
              src="/landing/stress.png"
              alt="The AlphaIndex live portfolio dashboard — NAV, holdings, rebalance history, and Claude-written rebalance reasoning."
            />
          </div>
          </WarmReveal>
        </div>
      </section>

      <WarmRule />

      {/* ─────────── Section 7: Frameworks comparison ─────────── */}
      <section id="calibration" className="py-32 md:py-40">
        <div className="mx-auto max-w-[1280px] px-6 md:px-12">
          <WarmReveal>
          <h2
            className="font-[var(--font-fraunces)] font-light"
            style={{
              fontSize: "clamp(36px, 5vw, 56px)",
              letterSpacing: "-0.015em",
              lineHeight: "1.1",
              textWrap: "balance",
              maxWidth: "820px",
            }}
          >
            Two frameworks. Documented trade-offs.
            <br />
            You choose.
          </h2>
          </WarmReveal>

          {/* Desktop: editorial table */}
          <div className="mt-16 hidden md:block">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <WarmTh />
                  <WarmTh>v1</WarmTh>
                  <WarmTh>v2.1</WarmTh>
                </tr>
              </thead>
              <tbody>
                {COMPARE_ROWS.map((r) => (
                  <tr
                    key={r.k}
                    className="transition-colors duration-200 hover:bg-[#1a1714]"
                    style={{ borderTop: `1px solid ${TEXT}12` }}
                  >
                    <td className="py-5 pr-8 align-top" style={{ color: TEXT_MUTED }}>
                      {r.k}
                    </td>
                    <td className="py-5 pr-8 align-top">{r.v1}</td>
                    <td className="py-5 align-top">{r.v2}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: stacked */}
          <div className="mt-12 flex flex-col gap-8 md:hidden">
            {(["v1", "v2.1"] as const).map((fw) => (
              <div
                key={fw}
                className="border-t pt-6"
                style={{ borderColor: `${TEXT}12` }}
              >
                <div
                  className="font-[var(--font-jetbrains-mono)] text-[12px] uppercase"
                  style={{ color: TEXT_MUTED, letterSpacing: "0.08em" }}
                >
                  {fw}
                </div>
                <dl className="mt-4 flex flex-col gap-4">
                  {COMPARE_ROWS.map((r) => (
                    <div key={r.k}>
                      <dt
                        className="text-[12px] uppercase"
                        style={{ color: TEXT_MUTED, letterSpacing: "0.06em" }}
                      >
                        {r.k}
                      </dt>
                      <dd className="mt-1 text-[16px]">
                        {fw === "v1" ? r.v1 : r.v2}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>

          <p
            className="mt-12 max-w-[820px] text-[16px]"
            style={{ color: TEXT_MUTED, lineHeight: 1.6 }}
          >
            Both frameworks run paper-traded in parallel. The calibration
            dashboard shows actual outcomes side by side.
          </p>
        </div>
      </section>

      <WarmRule />

      {/* ─────────── Section 8: Closing ─────────── */}
      <section className="relative py-40 md:py-56">
        {/* Subtle radial glow behind the CTA */}
        <div
          aria-hidden
          className="absolute inset-0 flex items-center justify-center"
        >
          <div
            className="h-[400px] w-[600px] rounded-full opacity-[0.04]"
            style={{
              background: `radial-gradient(ellipse, ${ACCENT}, transparent 70%)`,
            }}
          />
        </div>

        <div className="relative mx-auto max-w-[1280px] px-6 text-center md:px-12">
          <p
            className="font-[var(--font-fraunces)] font-light"
            style={{
              fontSize: "clamp(40px, 6vw, 80px)",
              letterSpacing: "-0.015em",
              lineHeight: "1.1",
              color: TEXT,
            }}
          >
            Built to be measured. Not just to look impressive.
          </p>

          <div className="mt-16">
            <Link
              href="/app"
              className={`${PRIMARY_BTN_BASE} text-[18px]`}
              style={{ paddingBlock: "16px", paddingInline: "28px" }}
            >
              Launch the dashboard <span aria-hidden>→</span>
            </Link>
          </div>

          <div
            className="mt-12 font-[var(--font-jetbrains-mono)] text-[11px]"
            style={{ color: TEXT_MUTED, letterSpacing: "0.08em" }}
          >
            helix · paper-traded · for the SoSoValue × AKINDO buildathon
          </div>
        </div>
      </section>

      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Section 5 stages (same data)
// ─────────────────────────────────────────────────────────────────────────

const STAGES: Array<{ title: string; body: string; techLabel: string }> = [
  {
    title: "Ingestion",
    body: "Sanitize and validate raw news. Strip HTML, normalize timestamps, attach source tier classification.",
    techLabel: "ingestion-validation.ts · I-01, I-02",
  },
  {
    title: "Classification",
    body: "LLM categorizes the event. Detect promotional language, dedupe near-identical articles, classify catalyst subtype.",
    techLabel: "classifier.ts · digest.ts · promotional.ts · I-03, I-04",
  },
  {
    title: "Asset routing",
    body: "Score each candidate asset's relevance to the event: subject (1.0), directly affected (0.8), basket member (0.5).",
    techLabel: "asset-router.ts · I-05, I-06, I-07",
  },
  {
    title: "Conviction",
    body: "Multi-component scoring. Adjust by entity history: contradictory recent signals lower conviction.",
    techLabel: "entity-history.ts · I-15, I-16",
  },
  {
    title: "Risk derivation",
    body: "Stop, target, and horizon drawn from base rates per (catalyst subtype, asset class). No flat templates.",
    techLabel: "catalyst-subtype.ts · I-10 through I-20",
  },
  {
    title: "Conflict detection",
    body: "Flag signals that contradict each other on the same asset. Relevance-weighted to suppress incidental-mention noise.",
    techLabel: "conflict.ts · I-09",
  },
  {
    title: "Tier assignment",
    body: "Auto / Review / Info gating. Single-source claims cannot reach Auto regardless of conviction.",
    techLabel: "tier-resolution.ts · I-21, I-22, I-23",
  },
  {
    title: "Persistence",
    body: "Pre-save invariant gate enforces every rule above. Lifecycle sweeper expires stale signals.",
    techLabel: "invariants.ts · lifecycle.ts · I-13, I-14, I-30",
  },
];

// ─────────────────────────────────────────────────────────────────────────
// Section 7 comparison rows (same data)
// ─────────────────────────────────────────────────────────────────────────

const COMPARE_ROWS: Array<{ k: string; v1: string; v2: string }> = [
  { k: "Design philosophy", v1: "Unconstrained", v2: "Risk-controlled" },
  { k: "BTC anchor", v1: "Adaptive", v2: "40 – 70% band" },
  {
    k: "Concentration cap",
    v1: "None",
    v2: "8% per position, 15% per cluster",
  },
  {
    k: "Drawdown protection",
    v1: "None",
    v2: "Circuit breaker at −8% / −12%",
  },
  {
    k: "Worst stress test",
    v1: "−53% (2× BTC)",
    v2: "−19% (0.55× BTC)",
  },
  { k: "Capture in trends", v1: "Full", v2: "~80% of BTC" },
  { k: "Best for", v1: "Maximum upside", v2: "Bounded downside" },
];

// ─────────────────────────────────────────────────────────────────────────
// Subcomponents
// ─────────────────────────────────────────────────────────────────────────

function WarmRule() {
  return (
    <div className="mx-auto max-w-[1280px] px-6 md:px-12">
      <div
        className="h-px w-full"
        style={{
          background: `linear-gradient(to right, transparent, ${TEXT_MUTED}40, ${TEXT_MUTED}40, transparent)`,
        }}
      />
    </div>
  );
}

function WarmStat({
  n,
  label,
  first,
}: {
  n: string;
  label: string;
  first?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-start py-8 md:py-4 md:items-start md:px-8 ${
        first ? "" : "md:border-l"
      }`}
      style={{ borderColor: `${TEXT_MUTED}20` }}
    >
      <div
        className="font-[var(--font-jetbrains-mono)] tabular-nums"
        style={{
          fontSize: "clamp(40px, 5vw, 64px)",
          color: ACCENT_GLOW,
          lineHeight: 1,
        }}
      >
        {n}
      </div>
      <div
        className="mt-3 font-[var(--font-inter)] text-[11px] uppercase"
        style={{
          color: TEXT_MUTED,
          letterSpacing: "0.08em",
          fontWeight: 500,
        }}
      >
        {label}
      </div>
    </div>
  );
}

function WarmAuditCard({ title, body }: { title: string; body: string }) {
  return (
    <article
      className="flex flex-col rounded-sm p-6 transition-colors duration-300 hover:bg-[#1a1714]"
      style={{ border: `1px solid ${TEXT}08` }}
    >
      <span
        className="block h-1 w-10 rounded-full"
        style={{ background: `linear-gradient(to right, ${ACCENT}, ${ACCENT_GLOW})` }}
        aria-hidden
      />
      <h3
        className="mt-6 font-[var(--font-fraunces)] font-medium"
        style={{ fontSize: "24px", color: TEXT, lineHeight: 1.2 }}
      >
        {title}
      </h3>
      <p
        className="mt-4 font-[var(--font-inter)]"
        style={{
          fontSize: "16px",
          color: TEXT_MUTED,
          lineHeight: 1.6,
          maxWidth: "32em",
        }}
      >
        {body}
      </p>
    </article>
  );
}

function WarmStage({
  index,
  title,
  body,
  techLabel,
}: {
  index: number;
  title: string;
  body: string;
  techLabel: string;
}) {
  return (
    <li className="relative pb-14 pl-10 last:pb-0">
      {/* node with glow */}
      <span
        aria-hidden
        className="absolute -left-[5px] top-[6px] h-[10px] w-[10px] rounded-full"
        style={{
          background: ACCENT,
          boxShadow: `0 0 8px ${ACCENT}60`,
        }}
      />
      <div
        className="font-[var(--font-jetbrains-mono)] text-[14px]"
        style={{ color: TEXT_MUTED, letterSpacing: "0.06em" }}
      >
        STAGE {String(index).padStart(2, "0")}
      </div>
      <h3
        className="mt-2 font-[var(--font-fraunces)] font-medium"
        style={{ fontSize: "28px", color: TEXT, lineHeight: 1.15 }}
      >
        {title}
      </h3>
      <p
        className="mt-3 font-[var(--font-inter)]"
        style={{
          fontSize: "16px",
          color: TEXT_MUTED,
          lineHeight: 1.6,
          maxWidth: "640px",
        }}
      >
        {body}
      </p>
      <div
        className="mt-4 font-[var(--font-jetbrains-mono)] text-[11px]"
        style={{ color: TEXT_DIM, letterSpacing: "0.04em" }}
      >
        {techLabel}
      </div>
    </li>
  );
}

function WarmTh({ children }: { children?: React.ReactNode }) {
  return (
    <th
      className="pb-5 text-left font-[var(--font-jetbrains-mono)] text-[12px] uppercase"
      style={{
        color: TEXT_MUTED,
        letterSpacing: "0.08em",
        fontWeight: 400,
      }}
    >
      {children}
    </th>
  );
}
