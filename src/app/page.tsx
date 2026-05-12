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
      <section className="relative pt-32 md:pt-40 overflow-hidden">
        <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-16 px-6 md:grid-cols-12 md:gap-8 md:px-12 md:pb-40">
          {/* LEFT — copy */}
          <div className="md:col-span-7 md:pr-8">
            <div
              data-hero="eyebrow"
              className="font-[var(--font-jetbrains-mono)] text-[11px] uppercase opacity-0"
              style={{ color: TEXT_MUTED, letterSpacing: "0.1em" }}
            >
              AI TRADING INTELLIGENCE · PAPER-TRADED · OPEN AUDIT
            </div>

            <h1
              className="mt-8 font-[var(--font-fraunces)] leading-[1.0]"
              style={{ letterSpacing: "-0.035em" }}
            >
              <span
                data-hero="line1"
                className="block font-light opacity-0"
                style={{ fontSize: "clamp(56px, 9vw, 132px)" }}
              >
                Event-driven alpha.
              </span>
              <span
                data-hero="line2"
                className="block font-medium opacity-0"
                style={{ fontSize: "clamp(60px, 9.7vw, 142px)" }}
              >
                {"Audited".split("").map((ch, i) => (
                  <span key={i} className="hero-char inline-block opacity-0">
                    {ch}
                  </span>
                ))}
                <span data-hero="period" className="inline-block opacity-0" style={{ letterSpacing: "0.08em" }}>.</span>
              </span>
            </h1>

            <p
              data-hero="subhead"
              className="mt-12 max-w-[540px] font-[var(--font-inter)] opacity-0"
              style={{ fontSize: "22px", lineHeight: "1.65", color: TEXT }}
            >
              Every signal carries its full reasoning chain. Every outcome is
              tracked. Every framework is stress-tested. Trade what you can
              verify.
            </p>

            <div
              data-hero="ctas"
              className="mt-12 flex flex-wrap items-center gap-6 opacity-0"
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
          <div data-hero="card" className="hidden opacity-0 md:col-span-5 md:block md:pl-4">
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
          <Stat n="45" suffix="+" label="INVARIANTS ENFORCED" first />
          <Stat n="394" suffix="" label="TESTS PASSING" />
          <Stat n="2" suffix="" label="FRAMEWORKS GRADUATED" />
          <Stat n="8" suffix="" label="STRESS WINDOWS · INCL −35% BEAR" />
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
              title="Stress-tested frameworks"
              body="Two portfolio frameworks running paper-traded in parallel. v2.1 was stress-tested against a real -35% BTC bear market and contained the loss to -19%. Acceptance criteria are documented; failures are visible. Trade-offs are stated."
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
            <span style={{ fontFeatureSettings: '"smcp"' }}>Built</span> to be inspected.
          </h2>

          <div className="mt-[120px] flex flex-col gap-[120px]">
            <EvidenceRow
              side="left"
              eyebrow="Evidence 01"
              title="Open the box."
              body="Click any signal to see its conviction breakdown formula, sources, classifier reasoning, gate-rule outcomes, and corroboration status. No black boxes."
              linkLabel="View live audit →"
              href="/signals"
              src="/landing/audit.png"
              alt="The audit page for a single signal — conviction breakdown formula, sources, gate-rule outcomes, corroboration status."
            />
            <EvidenceRow
              side="right"
              eyebrow="Evidence 02"
              title="Track what actually happened."
              body="Hit rate by tier and catalyst subtype. Conviction calibration curves. v1 vs v2.1 attribution side by side. Outcomes resolve as horizons expire."
              linkLabel="View live calibration →"
              href="/calibration"
              src="/landing/calibration.png"
              alt="The calibration dashboard with framework toggle showing hit rates and PnL per framework."
            />
            <EvidenceRow
              side="left"
              eyebrow="Evidence 03"
              title="Test the framework, not just the signal."
              body="Eight historical stress windows including a real −35% BTC bear. v2.1 contained the loss to −19%. Documented, repeatable, visible."
              linkLabel="View live stress tests →"
              href="/index-fund"
              src="/landing/stress.png"
              alt="v2.1 stress test results table showing eight historical 60-day windows including a -35% BTC bear, with DD ratio column visible."
            />
          </div>
        </div>
      </section>

      <Rule />

      {/* ─────────── Section 7: Frameworks comparison ─────────── */}
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
            <span style={{ fontFeatureSettings: '"smcp"' }}>Two</span> frameworks. Documented trade-offs.
            <br />
            You choose.
          </h2>

          {/* Desktop: editorial table */}
          <div className="mt-16 hidden md:block" data-reveal="content">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th />
                  <Th>v1</Th>
                  <Th accent>v2.1</Th>
                </tr>
              </thead>
              <tbody>
                {COMPARE_ROWS.map((r) => (
                  <tr
                    key={r.k}
                    data-table-row
                    className="landing-table-row opacity-0 transition-colors duration-150"
                    style={{ borderTop: `1px solid ${TEXT}26` }}
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
          <div className="mt-12 flex flex-col gap-8 md:hidden" data-reveal="content">
            {(["v1", "v2.1"] as const).map((fw) => (
              <div
                key={fw}
                className="border-t pt-6"
                style={{ borderColor: `${TEXT}26` }}
              >
                <div
                  className="font-[var(--font-jetbrains-mono)] text-[12px] uppercase"
                  style={{ color: TEXT_MUTED, letterSpacing: "0.1em" }}
                >
                  {fw}
                </div>
                <dl className="mt-4 flex flex-col gap-4">
                  {COMPARE_ROWS.map((r) => (
                    <div key={r.k}>
                      <dt
                        className="text-[12px] uppercase"
                        style={{ color: TEXT_MUTED, letterSpacing: "0.1em" }}
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
            style={{ color: TEXT_MUTED, lineHeight: 1.65 }}
            data-reveal="content"
          >
            Both frameworks run paper-traded in parallel. The calibration
            dashboard shows actual outcomes side by side.
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
// Section 7 comparison rows
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

function Th({ children, accent }: { children?: React.ReactNode; accent?: boolean }) {
  return (
    <th
      className="pb-5 text-left font-[var(--font-jetbrains-mono)] text-[12px] uppercase"
      style={{
        color: accent ? ACCENT : TEXT_MUTED,
        letterSpacing: "0.1em",
        fontWeight: 400,
      }}
      {...(accent ? { "data-v21-header": "" } : {})}
    >
      {children}
    </th>
  );
}
