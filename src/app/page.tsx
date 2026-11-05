/**
 * Helix — public landing page (/).
 *
 * Editorial design: warm-cream type on near-black, Fraunces for headers,
 * Inter for body, JetBrains Mono for technical labels, sparing amber
 * accent. No gradients, no glassmorphism, no animated decoration. The
 * page is meant to read as "serious financial product" not "AI tech demo".
 *
 * The dashboard lives at /app — visit `LaunchDashboardLink` to enter.
 */

import Link from "next/link";
import { LandingNav } from "@/components/landing/LandingNav";
import { HeroSignalCard } from "@/components/landing/HeroSignalCard";
import { EvidenceRow } from "@/components/landing/EvidenceRow";
import { LiveIndicator } from "@/components/landing/LiveIndicator";
import { Footer } from "@/components/landing/Footer";
import { LandingMotion } from "@/components/landing/LandingMotion";

export const metadata = {
  title: "Helix — Event-driven alpha. Audited.",
};

const TEXT = "#ede4d3";
const TEXT_MUTED = "#8a857a";
const TEXT_DIM = "#6a665e";
const ACCENT = "#d97757";
const HOVER_AMBER = "#e89373";
const BG = "#0b0b0e";

const PRIMARY_BTN_BASE =
  "inline-flex items-center gap-2 rounded-[4px] border border-[#d97757] bg-[#d97757] px-5 py-3 font-medium text-[#0b0b0e] transition-all duration-200 hover:bg-[#c0613f] hover:border-[#c0613f] hover:-translate-y-px focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d97757]";

const SECONDARY_BTN_BASE =
  "inline-flex items-center gap-2 px-1 py-3 transition-colors duration-200 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d97757]";

export default function HelixLandingPage() {
  return (
    <div
      className="min-h-screen font-[var(--font-inter)]"
      style={{ background: BG, color: TEXT }}
    >
      <LandingMotion />
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded focus:bg-[#d97757] focus:px-4 focus:py-2 focus:text-[#0b0b0e] focus:outline-none"
      >
        Skip to content
      </a>
      <LandingNav />

      <main id="main">

      {/* ─────────── Section 2: Hero ─────────── */}
      <section className="relative pt-24 md:pt-28 overflow-hidden">
        <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-16 px-6 md:grid-cols-12 md:gap-8 md:px-12 md:pb-32">
          {/* LEFT — copy */}
          <div className="md:col-span-7 md:pr-8">
            <div
              data-hero="eyebrow"
              className="font-[var(--font-jetbrains-mono)] text-[11px] uppercase"
              style={{ color: TEXT_MUTED, letterSpacing: "0.1em" }}
            >
              AI TRADING INTELLIGENCE · LIVE ON SODEX · EVENT-DRIVEN ALPHA
            </div>

            <h1
              className="mt-8 font-[var(--font-fraunces)] leading-[1.0]"
              style={{ letterSpacing: "-0.035em" }}
            >
              <span
                data-hero="line1"
                className="block font-light"
                style={{ fontSize: "clamp(56px, 9vw, 132px)" }}
              >
                Event-driven alpha.
              </span>
              <span
                data-hero="line2"
                className="block font-medium"
                style={{ fontSize: "clamp(60px, 9.7vw, 142px)" }}
              >
                {"Audited".split("").map((ch, i) => (
                  <span key={i} className="hero-char inline-block">
                    {ch}
                  </span>
                ))}
                <span data-hero="period" className="inline-block" style={{ letterSpacing: "0.08em" }}>.</span>
              </span>
            </h1>

            <p
              data-hero="subhead"
              className="mt-12 max-w-[540px] font-[var(--font-inter)]"
              style={{ fontSize: "22px", lineHeight: "1.65", color: TEXT }}
            >
              Every signal carries its full reasoning chain. Every outcome is
              graded against what actually happened. Trade what you can verify —
              on SoDEX, from your own wallet.
            </p>

            <div
              data-hero="ctas"
              className="mt-12 flex flex-wrap items-center gap-6"
            >
              <Link
                href="/app"
                className={`${PRIMARY_BTN_BASE} landing-cta-shimmer text-[16px]`}
              >
                Launch dashboard <span aria-hidden>→</span>
              </Link>
              <a
                href="#how-it-works"
                className={`${SECONDARY_BTN_BASE} text-[16px] landing-link`}
                style={{ color: TEXT }}
              >
                How the audit works
              </a>
            </div>
          </div>

          {/* RIGHT — anchor signal card */}
          <div data-hero="card" className="hidden md:col-span-5 md:block md:pl-4">
            <div className="md:sticky md:top-32">
              <HeroSignalCard />
              <div
                className="mt-3 flex items-center gap-3 font-[var(--font-jetbrains-mono)] text-[11px]"
                style={{ color: TEXT_MUTED, letterSpacing: "0.06em" }}
              >
                <LiveIndicator />
                <span>· click to inspect</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right-edge gradient fade */}
        <div
          className="pointer-events-none absolute right-0 top-0 h-full w-[200px]"
          style={{ background: `linear-gradient(to right, transparent, ${BG})`, opacity: 0.6 }}
          aria-hidden
        />
      </section>

      <Rule />

      {/* ─────────── Section 3: Stats strip ─────────── */}
      <section className="py-24" data-section="stats">
        <div className="mx-auto grid max-w-[1280px] grid-cols-2 px-6 md:grid-cols-4 md:px-12">
          <Stat n="100" suffix="%" label="SIGNALS GRADED AGAINST OUTCOME" first />
          <Stat n="70" suffix="+" label="SODEX MARKETS · CRYPTO · EQUITIES · ETFS" />
          <Stat n="11" suffix="" label="ON-CHAIN WEALTH PRODUCTS" />
          <Stat n="24" suffix="/7" label="CATALYST MONITORING" />
        </div>
      </section>

      <Rule />

      {/* ─────────── Section 4: Why audit ─────────── */}
      <section
        id="why-audit"
        className="py-40"
        data-reveal-section
        data-reveal-stagger="0.12"
      >
        <div className="mx-auto max-w-[1280px] px-6 md:px-12">
          <h2
            data-reveal="header"
            className="font-[var(--font-fraunces)] font-light opacity-0"
            style={{
              fontSize: "clamp(36px, 5vw, 56px)",
              letterSpacing: "-0.025em",
              lineHeight: "1.1",
              textWrap: "balance",
              maxWidth: "720px",
            }}
          >
            <span style={{ fontFeatureSettings: '"smcp"' }}>Most</span> AI signals are unverifiable.
            <br />
            Helix isn&apos;t.
          </h2>

          <div className="mt-16 grid grid-cols-1 gap-10 md:grid-cols-3 md:gap-12">
            <AuditCard
              title="Per-signal audit trails"
              body="Click any signal to see its sources, classifier prompt version, conviction formula breakdown, asset relevance score, corroboration status, and gate-rule outcomes. The reasoning is exposed, not hidden behind a confidence number."
            />
            <AuditCard
              title="Outcome-tracked calibration"
              body="When a signal's horizon expires, we record what actually happened — target hit, stop hit, or expired flat. The calibration dashboard shows hit rate by tier, by catalyst type, and conviction calibration curves. We measure the way real funds do."
            />
            <AuditCard
              title="Live on SoDEX, not on paper"
              body="Execute any signal in the trade terminal, and buy or sell curated Wealth ETFs in-app — real orders on SoDEX, routed with Helix's builder code. Helix never holds your keys; you sign in your own wallet."
            />
          </div>
        </div>
      </section>

      <Rule />

      {/* ─────────── Section 5: How it works ─────────── */}
      <section
        id="how-it-works"
        className="py-40"
        data-reveal-section
        data-reveal-stagger="0.08"
      >
        <div className="mx-auto max-w-[1280px] px-6 md:px-12">
          <h2
            data-reveal="header"
            className="font-[var(--font-fraunces)] font-light opacity-0"
            style={{
              fontSize: "clamp(36px, 5vw, 56px)",
              letterSpacing: "-0.025em",
              lineHeight: "1.1",
              textWrap: "balance",
              maxWidth: "820px",
            }}
          >
            Eight stages from news to signal.
          </h2>

          <div className="relative mt-16 ml-6 md:ml-12">
            <span
              aria-hidden
              className="absolute left-0 top-2 bottom-2 w-px"
              style={{ background: `${ACCENT}40` }}
            />
            <span
              aria-hidden
              data-timeline-fill
              className="absolute left-0 top-2 bottom-2 w-px origin-top"
              style={{ background: ACCENT }}
            />
            <ol className="relative">
            {STAGES.map((stage, i) => (
              <Stage
                key={stage.title}
                index={i + 1}
                title={stage.title}
                body={stage.body}
                techLabel={stage.techLabel}
              />
            ))}
            </ol>
          </div>
        </div>
      </section>

      <Rule />

      {/* ─────────── Section 6: Built for transparency ─────────── */}
      <section id="frameworks" className="py-40" data-reveal-section>
        <div className="mx-auto max-w-[1440px] px-6 md:px-12">
          <h2
            data-reveal="header"
            className="font-[var(--font-fraunces)] font-light opacity-0"
            style={{
              fontSize: "clamp(36px, 5vw, 56px)",
              letterSpacing: "-0.025em",
              lineHeight: "1.1",
              textWrap: "balance",
              maxWidth: "820px",
            }}
          >
            <span style={{ fontFeatureSettings: '"smcp"' }}>Built</span> to be inspected.
          </h2>

          <div className="mt-[120px] flex flex-col gap-[120px]">
            <EvidenceRow
              side="left"
              eyebrow="Evidence 01"
              title="Open the box."
              body="Click any signal to see its full reasoning, the triggering news event, classifier output, gate-rule outcomes, and corroboration status. No black boxes."
              linkLabel="View live audit →"
              href="/signals"
              src="/landing/audit.png"
              alt="The audit page for a single signal — reasoning, sources, classifier output, gate-rule outcomes, corroboration status."
            />
            <EvidenceRow
              side="right"
              eyebrow="Evidence 02"
              title="Live event ingestion."
              body="Every news headline is fetched, classified by Claude for actionability, sentiment, severity, and asset mapping, then gated by a corpus-similarity filter before it can fire a signal. Thousands of events on file, auto-polling for new ones."
              linkLabel="View live event stream →"
              href="/events"
              src="/landing/events.png"
              alt="The event stream — recent news headlines with classifier verdicts (event type, sentiment, severity) and asset mappings."
            />
            <EvidenceRow
              side="left"
              eyebrow="Evidence 03"
              title="On-chain Wealth, in one place."
              body="Browse SoDEX Wealth live — tokenized ETFs (vQQQ, vVOO, vSMH), Stable Earn yield, and RWA — with real returns, APY, mapped Helix events, and 1-month charts. Buy and sell the curated ETFs in-app on SoDEX, routed with Helix's builder code."
              linkLabel="Explore the Wealth Index →"
              href="/wealth-index"
              src="/landing/wealth.png"
              alt="The Helix Wealth Index — SoDEX Wealth products with live returns, APY, event feeds, and in-app Buy/Sell."
            />
          </div>
        </div>
      </section>

      <Rule />

      {/* ─────────── Section 7: Calibration ─────────── */}
      <section
        id="calibration"
        className="py-40"
        data-reveal-section
      >
        <div className="mx-auto max-w-[1280px] px-6 md:px-12">
          <h2
            data-reveal="header"
            className="font-[var(--font-fraunces)] font-light opacity-0"
            style={{
              fontSize: "clamp(36px, 5vw, 56px)",
              letterSpacing: "-0.025em",
              lineHeight: "1.1",
              textWrap: "balance",
              maxWidth: "820px",
            }}
          >
            <span style={{ fontFeatureSettings: '"smcp"' }}>Every</span> call, graded against outcome.
          </h2>

          <div
            className="mt-16 grid grid-cols-1 gap-10 md:grid-cols-3 md:gap-12"
            data-reveal="content"
          >
            <AuditCard
              title="Every signal gets a clock"
              body="At fire time we fix the holding window — T+1d, 3d or 7d by catalyst type — with a target and a stop. No open-ended calls."
            />
            <AuditCard
              title="Measured against price"
              body="When the window expires, the resolution job walks real SoDEX price history and records the outcome: target hit, stop hit, or flat. Nothing is graded by hand."
            />
            <AuditCard
              title="Fed back, in the open"
              body="Graded outcomes roll up into a live hit rate — by tier, catalyst and asset class — on the calibration dashboard. The scoreboard is public."
            />
          </div>

          <p
            className="mt-12 max-w-[820px] text-[16px]"
            style={{ color: TEXT_MUTED, lineHeight: 1.65 }}
            data-reveal="content"
          >
            Signals are scored the way a desk scores a trade — against what the
            market actually did, not against a vibe.
          </p>
        </div>
      </section>

      <Rule />

      {/* ─────────── Section 8: Closing ─────────── */}
      <section className="py-40 md:py-56" data-section="closing">
        <div className="mx-auto max-w-[1280px] px-6 text-center md:px-12">
          <p
            data-closing="line1"
            className="font-[var(--font-fraunces)] font-light opacity-0"
            style={{
              fontSize: "clamp(40px, 6vw, 80px)",
              letterSpacing: "-0.025em",
              lineHeight: "1.1",
              color: TEXT,
            }}
          >
            <span style={{ fontFeatureSettings: '"smcp"' }}>Built</span> to be measured.
          </p>
          <p
            data-closing="line2"
            className="mt-4 font-[var(--font-fraunces)] font-light opacity-0"
            style={{
              fontSize: "clamp(28px, 4vw, 48px)",
              letterSpacing: "-0.02em",
              lineHeight: "1.2",
              color: TEXT_MUTED,
            }}
          >
            Not just to look impressive.
          </p>

          <div className="mt-16" data-closing="cta">
            <Link
              href="/app"
              className={`${PRIMARY_BTN_BASE} landing-cta-shimmer text-[18px]`}
              style={{ paddingBlock: "16px", paddingInline: "28px" }}
            >
              Launch the dashboard <span aria-hidden>→</span>
            </Link>
          </div>
        </div>
      </section>

      </main>

      <Footer />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Section 5 stages
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
// Subcomponents
// ─────────────────────────────────────────────────────────────────────────

function Rule() {
  return (
    <div className="mx-auto max-w-[1280px] px-6 md:px-12">
      <div
        className="h-px w-full"
        style={{ background: TEXT_MUTED, opacity: 0.08 }}
      />
    </div>
  );
}

function Stat({
  n,
  suffix,
  label,
  first,
}: {
  n: string;
  suffix: string;
  label: string;
  first?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-start py-8 md:py-4 md:items-start md:px-8 ${
        first ? "" : "md:border-l"
      }`}
      style={{ borderColor: `${TEXT_MUTED}33` }}
    >
      <div
        data-counter={n}
        data-suffix={suffix}
        className="font-[var(--font-jetbrains-mono)] tabular-nums"
        style={{
          fontSize: "clamp(40px, 5vw, 64px)",
          color: TEXT,
          lineHeight: 1,
        }}
      >
        {n}{suffix}
      </div>
      <div
        data-stat-label
        className="mt-3 font-[var(--font-inter)] text-[11px] uppercase opacity-0"
        style={{
          color: TEXT_MUTED,
          letterSpacing: "0.1em",
          fontWeight: 500,
        }}
      >
        {label}
      </div>
    </div>
  );
}

function AuditCard({ title, body }: { title: string; body: string }) {
  return (
    <article className="landing-audit-card flex flex-col" data-reveal="content">
      <span
        className="landing-audit-card-bar block h-px w-8 transition-all duration-300"
        style={{ background: `linear-gradient(to right, ${ACCENT}, ${ACCENT}80)` }}
        aria-hidden
      />
      <h3
        className="landing-audit-card-title mt-6 font-[var(--font-fraunces)] font-medium transition-colors duration-300"
        style={{ fontSize: "24px", color: TEXT, lineHeight: 1.2 }}
      >
        {title}
      </h3>
      <p
        className="mt-4 font-[var(--font-inter)]"
        style={{
          fontSize: "16px",
          color: TEXT_MUTED,
          lineHeight: 1.65,
          maxWidth: "32em",
        }}
      >
        {body}
      </p>
    </article>
  );
}

function Stage({
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
    <li className="relative pb-14 pl-10 last:pb-0" data-reveal="content">
      {/* node */}
      <span
        aria-hidden
        data-stage-dot
        className="absolute -left-[5px] top-[6px] h-[10px] w-[10px] rounded-full scale-0"
        style={{ background: ACCENT }}
      />
      <div
        className="font-[var(--font-jetbrains-mono)] text-[14px]"
        style={{ color: TEXT_MUTED, letterSpacing: "0.1em" }}
      >
        STAGE {String(index).padStart(2, "0")}
      </div>
      <h3
        className="mt-2 font-[var(--font-fraunces)] font-medium"
        style={{ fontSize: "28px", color: TEXT, lineHeight: 1.15, letterSpacing: "-0.025em" }}
      >
        {title}
      </h3>
      <p
        className="mt-3 font-[var(--font-inter)]"
        style={{
          fontSize: "16px",
          color: TEXT_MUTED,
          lineHeight: 1.65,
          maxWidth: "640px",
        }}
      >
        {body}
      </p>
      <div
        className="mt-4 font-[var(--font-jetbrains-mono)] text-[11px] landing-stage-tech"
        style={{ color: TEXT_DIM, letterSpacing: "0.04em" }}
      >
        {techLabel}
      </div>
    </li>
  );
}

