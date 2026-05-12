# Helix

**Event-driven alpha. Audited.**

Helix turns the financial news firehose into auditable, conviction-scored trade signals. Every news headline is fetched from SoSoValue, classified by an AI agent for actionability / sentiment / severity / asset mapping, gated by a corpus-similarity filter, then weighted into a single conviction score whose every input is visible on a per-signal audit page. No black boxes.

> **Live demo:** https://helix-alpha-kappa.vercel.app
> **Wave 1 video:** https://www.youtube.com/watch?v=Pyy0KAbHTv4
> **Repo:** https://github.com/Daily-Up/helix-alpha

---

## Who it's for

Active crypto / cross-asset traders who want:

- A **structured read of news flow** (not a Twitter scroll) — every event classified and routed to affected assets.
- **Conviction-scored signals** with stop / target / horizon already attached — not just sentiment scores.
- **An audit trail** — for every signal, see the triggering news, classifier output, gate-rule decisions, and corroboration status. Trust through transparency.
- A paper-traded **AI-managed index** (AlphaIndex) that uses the same signals to allocate across BTC / ETH / L1s / RWA baskets — a "one-person BlackRock."

---

## What it does — the full flow

```
SoSoValue OpenAPI  →  News ingestion  →  AI classification
                                          (Claude in Wave 1;
                                           tool-using AI agents
                                           in Wave 2 / 3)
                                              ↓
                              Corpus-similarity gate (drop noise)
                                              ↓
                          Conviction scoring (7 weighted axes)
                                              ↓
                          Tier resolution (AUTO / REVIEW / INFO)
                                              ↓
       ┌───────────────────────────┬─────────────────────────┐
       ▼                           ▼                         ▼
  Live Signals               AlphaIndex                Audit trail
  (executable on             (paper-traded             (every input
   SoDEX, wave 2)             AI index)                 visible)
```

---

## Wave 1 — what's shipped

- **News ingestion pipeline** — auto-polls SoSoValue's news feed; thousands of events ingested in the demo deployment, the majority already classified.
- **AI classification** — every event is tagged with event type, sentiment, severity, actionability, recency, and affected assets. Classification reasoning is stored alongside.
- **Corpus-similarity gate** — pre-classification filter that compares incoming headlines against a hand-curated corpus of high-signal historical events. Includes a signal-verb boost that rescues exploits / regulatory / M&A headlines on unfamiliar entities.
- **Signal generation** — 7-axis conviction score (classifier confidence × tradability × severity × source × clarity × event-type weight × novelty), tier resolution, asset routing, direction lock, history adjustment, base-rate cap, reliability cap.
- **Per-signal audit page** — every signal links to a page showing the triggering news, classifier output, gate decisions, corroborating sources, and (where resolved) the measured outcome.
- **AlphaIndex** — paper-traded AI-managed crypto index that allocates across BTC / ETH / L1s / RWA / sector baskets using accumulated news signals, sector momentum, and ETF flows. Rebalance reasoning written by an AI agent.
- **Event stream UI** — live feed with classifier verdicts inline; auto-poll keeps it fresh.
- **Public deploy on Vercel** with snapshot-hydrated SQLite and a SoSoValue-backed cron ingest.

## Wave 2 / Wave 3 — roadmap (honestly deferred)

| Feature | Status | Wave |
|---|---|---|
| **Tool-using agents** (today: LLM-powered constrained tasks; next: agents that fetch corroborating sources, query on-chain data, place trades) | Architecture in place; tools wave 2 | Wave 2 / 3 |
| Calibration page (hit rate, conviction calibration curves, v1 vs v2.1 attribution) | Architecture complete; sample size still warming up | Wave 2 |
| Learnings page (per-subtype hit rates on resolved signals) | Same — needs more resolved signals on file | Wave 2 / 3 |
| Pattern Library (empirical per-event-type impact stats) | Needs minimum samples per cell | Wave 2 |
| v2.1 framework (drawdown-controlled long-only allocation) | Code shipped; preview panel visible; not yet promoted to live rebalances | Wave 2 |
| SoDEX execution (real on-chain trades from signals) | URLs configured, API keys pending | Wave 2 / 3 |
| Stress test results | Disabled pending v2.1 graduation | Wave 2 |

The pages exist in code and run locally — they're publicly gated until the data behind them is calibrated. Click any sidebar item marked **SOON** to see a roadmap card.

---

## Tech stack

- **Next.js 16** (App Router, Turbopack)
- **Anthropic Claude** (`claude-sonnet-4-5`) — the model powering today's classification and rebalance-reasoning agents
- **SoSoValue OpenAPI** — news, ETF flow, sector data
- **SoDEX** — perp + spot market URLs wired in; execution wave 2
- **better-sqlite3** with snapshot hydration on Vercel — Wave 1 demo shortcut. Wave 2 migrates to a hosted database (Turso or Postgres) for persistent writes, live cron, and real execution state.
- **TailwindCSS 4** + custom design system
- **Vitest** for unit tests
- **Playwright** for landing-page screenshot capture

---

## APIs integrated

| API | Use | Wave |
|---|---|---|
| **SoSoValue OpenAPI** | News ingest, sector data, ETF flows | Wave 1 ✓ |
| **Anthropic Claude** | News classification, rebalance reasoning, briefings | Wave 1 ✓ |
| **SoDEX (mainnet)** | URLs configured; live execution wave 2 | Wave 2 |

---

## Local setup

```bash
git clone https://github.com/Daily-Up/helix-alpha
cd helix-alpha
npm install
cp .env.local.example .env.local   # fill in your keys
npm run dev
```

Open http://localhost:3000.

### Required environment variables

```bash
SOSOVALUE_API_KEY=...
SOSOVALUE_BASE_URL=https://openapi.sosovalue.com/openapi/v1
SOSOVALUE_RATE_LIMIT_PER_MIN=20

ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=claude-sonnet-4-5

DATABASE_PATH=./data/sosoalpha.db
CLASSIFICATION_PAUSED=0
```

A working SQLite snapshot ships at `data/sosoalpha.db` so the dashboard renders against real data immediately on first run.

### Useful scripts

```bash
npm run dev               # local dev server
npm run typecheck         # tsc --noEmit
npm test                  # vitest unit tests
npm run capture:landing   # re-capture landing-page screenshots via Playwright
npm run ingest:news       # one-off news ingest cycle
```

---

## Project structure

```
src/
├── app/                  # Next.js App Router
│   ├── api/data/         # read-only data endpoints (one per dashboard page)
│   ├── api/cron/         # ingestion + briefing cron handlers
│   ├── api/trading/      # signal execute / dismiss / reset
│   └── (pages)/          # one folder per dashboard route
├── components/           # React components grouped by domain
├── lib/
│   ├── ai/               # Claude prompts + classifier
│   ├── calibration/      # corpus filter, significance scoring
│   ├── pipeline/         # base rates, lifecycle, entity history
│   ├── trading/          # signal generator (the heart of the system)
│   ├── db/               # SQLite client + repos
│   └── format/           # shared rendering helpers
└── tests/                # vitest specs
```

Key files to read first:

- `src/lib/trading/signal-generator.ts` — the 7-axis conviction engine
- `src/lib/calibration/corpus-filter.ts` — pre-classification gate
- `src/lib/calibration/significance.ts` — significance scoring (Phase C)
- `PIPELINE_INVARIANTS.md` — invariants the system maintains (I-41 through I-47)
- `FRAMEWORK_NOTES.md` — v1 vs v2.1 framework design rationale

---

## Where we are on the agentic spectrum (honesty section)

Today, Helix is **LLM-powered with constrained tasks**: a classifier prompt for every incoming headline, a reasoning prompt for every AlphaIndex rebalance. There is no tool use, no multi-step planning loop, no autonomous trade execution. That's wave 1.

The architecture is built for the next step. In wave 2 and wave 3:

- **Classifier → research agent** — fetches corroborating sources, queries on-chain data (token transfers, governance votes, oracle prices) before scoring an event.
- **Rebalance writer → portfolio agent** — places trades on SoDEX directly inside a risk envelope, instead of writing rebalance plans for a human to confirm.
- **Cross-asset awareness** — agents that know about each other's open positions and the global risk budget.

We are calling things "agents" today because each call has a constrained task, a defined input schema, and a structured output — but we are not pretending the loop is autonomous yet. Wave 2 is where the tools land.

---

## Judging-criteria mapping

| Criterion | Where to look |
|---|---|
| **User Value & Practical Impact** | Live signals page (`/signals`), audit trail (`/signal/[id]`), AlphaIndex (`/index-fund`) |
| **Functionality & Working Demo** | All of https://helix-alpha-kappa.vercel.app — real classified events, real signals, real paper-traded portfolio |
| **Logic, Workflow & Product Design** | `PIPELINE_INVARIANTS.md`, `FRAMEWORK_NOTES.md`, the audit page proves every step |
| **Data / API Integration** | SoSoValue news + sector + ETF endpoints, Anthropic for classification + reasoning, SoDEX URLs configured |
| **UX & Clarity** | Editorial layout, monospace + Fraunces typography, per-signal audit trail, "Built to be inspected" landing section |

---

## Team

**Daily-Up** — solo build, buildathon Wave 1 submission.

---

## Acknowledgments

- **SoSoValue** for the OpenAPI access making structured news flow possible
- **Anthropic** for Claude Sonnet 4.5 driving classification and rebalance rationale
- **SoDEX** for the on-chain execution venue (wave 2 integration)
