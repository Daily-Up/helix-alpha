# Helix

**Event-driven alpha. Audited. Executed.**

Helix turns the financial news firehose into auditable, conviction-scored trade signals — and now **executes them live on-chain**. Every headline is fetched from SoSoValue, classified by an AI agent for actionability / sentiment / severity / asset mapping, gated by a corpus-similarity filter, then weighted into a single conviction score whose every input is visible on a per-signal audit page. Signals you act on route straight to **SoDEX mainnet (spot + perps)** in one click — no black boxes, no wallet popup on every trade.

> **Live demo:** https://helix-alpha-kappa.vercel.app
> **Wave 1 video:** https://www.youtube.com/watch?v=Pyy0KAbHTv4
> **Repo:** https://github.com/Daily-Up/helix-alpha

---

## Who it's for

Active crypto / cross-asset traders who want:

- A **structured read of news flow** (not a Twitter scroll) — every event classified and routed to affected assets.
- **Conviction-scored signals** with stop / target / horizon already attached — not just sentiment scores.
- **One-click live execution** — take a signal to a real fill on SoDEX mainnet (spot **and** perpetuals) with editable size and stop-loss / take-profit, authorizing once instead of signing every trade.
- **An audit trail** — for every signal, see the triggering news, classifier output, gate-rule decisions, and corroboration status. Trust through transparency.
- An AI-managed **index** (AlphaIndex) that uses the same signals to allocate across BTC / ETH / L1s / RWA baskets — a "one-person BlackRock" — with a one-click on-chain deploy.

---

## What it does — the full flow

```
SoSoValue OpenAPI  →  News ingestion  →  AI classification
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
  one-click execution        AI index +                (every input
  on SoDEX mainnet           one-click                 visible)
  (spot + perps)             SoDEX deploy
       │                           │
       ▼                           ▼
            SoDEX mainnet — real fills, session-key signing
            (Helix never custodies keys)
```

---

## What's shipped

### Signal intelligence (Wave 1)

- **News ingestion pipeline** — auto-polls SoSoValue's news feed; thousands of events ingested, the majority classified.
- **AI classification** — every event is tagged with event type, sentiment, severity, actionability, recency, and affected assets, with classification reasoning stored alongside.
- **Corpus-similarity gate** — pre-classification filter comparing incoming headlines against a hand-curated corpus of high-signal historical events, with a signal-verb boost that rescues exploit / regulatory / M&A headlines on unfamiliar entities.
- **Signal generation** — 7-axis conviction score (classifier confidence × tradability × severity × source × clarity × event-type weight × novelty), tier resolution, asset routing, direction lock, history adjustment, base-rate cap, reliability cap.
- **Per-signal audit page** — every signal links to the triggering news, classifier output, gate decisions, corroborating sources, and (where resolved) the measured outcome.
- **Event stream UI** — live feed with classifier verdicts inline; auto-poll keeps it fresh.

### Live on-chain execution — SoDEX mainnet (Wave 2–3) ✓

- **One-click, no-popup trading** — connect the wallet once and sign SoDEX's `addAPIKey` a single time; every subsequent trade is one click in the Helix UI. The session/API key lives only in the browser — Helix's server is never in the signing path and never custodies keys.
- **Spot _and_ perpetuals** — Helix auto-detects each asset's venue and routes to the right gateway and EIP-712 signing domain. Perps support was reverse-engineered end-to-end (order schema and exact field order, `modifier` / `positionSide`, per-symbol quantity precision, dual spot + perps API-key registration), unlocking perp-only markets like DASH and the short side.
- **Editable order controls** — size ($), stop-loss %, and take-profit % on the execute panel (pre-filled from the signal). SL/TP place as reduce-only bracket orders on perps, best-effort — a failed protective leg never unwinds a filled entry.
- **Portfolio (real, per-account)** — the connected account's live activity: open **positions** (size, entry, mark, unrealized PnL) with a **one-click Close** (reduce-only market order), the live order log, and correct spot + futures-margin balances. No paper simulation.

### AlphaIndex (Wave 1 → v2.1, Wave 3)

- **AI-managed crypto index** allocating across BTC / ETH / L1s / RWA / sector baskets using accumulated news signals, sector momentum, and ETF flows, with rebalance reasoning written by an AI agent.
- **v2.1 drawdown-controlled framework** released as the active engine, with a circuit breaker that reads the live NAV ledger so the drawdown rail actually fires.
- **Autonomous daily rebalancing** — cadence-guarded, tick-driven via a GitHub Actions cron.
- **One-click "Deploy to SoDEX"** — splits available USDC across the live index weights as a single signed batch.

### Token unlocks — a tradable catalyst (Wave 3) ✓

- **Unlock calendar** (`/unlocks`) — a forward schedule of token supply unlocks, sourced **keyless** from DefiLlama's emissions datasets (no new paid API). Per unlock we compute USD value (tokens × live price), **% of circulating float** (the sell-pressure proxy), recipient tranche (team / investor / community), and the countdown.
- **Short trade plans, timed to the anticipation.** Empirically the negative impact is front-loaded (price bleeds into a known unlock, the date is often the anticlimax, pressure eases within 1–3 weeks). So instead of an always-on signal, each **eligible** unlock — a **team/investor cliff ≥1% of float on a SoDEX perp** — gets a plan: **arm a short T−7/10/14d** (by size) and **cover ~T+3d**, with conviction from recipient × materiality. A candidate in its entry window is a **one-click short on the perp, executed right on `/unlocks`** — deliberately *separate* from the Live Signals feed. Community/airdrop unlocks and anything <1% of float are calendar-only.
- Runs daily via GitHub Actions; the plan is computed at read time, so retuning the timing needs no re-ingest.

### Interface & data (Wave 3)

- Full design pass across all 21 screens onto a shared primitive set (magnitude-bar tables, one number-precision policy, click-to-copy addresses), real **asset logos** (crypto + crypto-stocks + ETFs), and a viewport-fit, product-first dashboard. A ratchet guard (`tests/ui-primitives-guard.test.ts`) blocks regressions.

---

## Roadmap — next waves

| Feature | Status | Wave |
|---|---|---|
| **Unlock signals — measure + refine** — grade unlock-short outcomes in the calibration engine (does front-running unlocks work?), size by float + volume, widen token coverage beyond the current perp universe | Next | Wave 4 |
| Two-sided delta rebalance for AlphaIndex live deploy (sells to trim, not just cash-deploy) | Planned | Wave 4 / 5 |
| Opt-in automated execution for AUTO-tier + high-conviction signals | Planned | Wave 5 |
| Calibration / Learnings / Pattern Library pages (hit rate, conviction curves, per-subtype stats) | Architecture complete; sample size warming up | Wave 4 |
| Research agent (fetch corroborating sources, query on-chain data before scoring) | Architecture in place | Wave 4 / 5 |

Pages marked **SOON** in the sidebar run in code and are gated until the data behind them calibrates — click one to see its roadmap card.

---

## Tech stack

- **Next.js 16** (App Router, Turbopack) + **React 19**
- **Anthropic Claude** (`claude-sonnet-4-5` by default; model is env-configurable) — powers classification, rebalance reasoning, and briefings
- **SoSoValue OpenAPI** — news, ETF flow, sector data
- **SoDEX mainnet** — **live** spot + perps execution via EIP-712 session keys; **wagmi** / **viem** / **RainbowKit** for wallet connect
- **Turso (libSQL)** in production for persistent writes, live cron, and execution state; **better-sqlite3** with snapshot hydration for local dev
- **TailwindCSS 4** + custom design system, **Recharts**, **GSAP**
- **Vitest** unit tests, **Playwright** landing-page capture
- **GitHub Actions** cron — autonomous rebalance tick, daily briefing, data refresh

---

## APIs integrated

| API | Use | Status |
|---|---|---|
| **SoSoValue OpenAPI** | News ingest, sector data, ETF flows | Wave 1 ✓ |
| **Anthropic Claude** | Classification, rebalance reasoning, briefings | Wave 1 ✓ |
| **SoDEX (mainnet)** | **Live** spot + perps execution, one-click session-key signing | Wave 2–3 ✓ |

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
# Signal intelligence
SOSOVALUE_API_KEY=...
SOSOVALUE_BASE_URL=https://openapi.sosovalue.com/openapi/v1
SOSOVALUE_RATE_LIMIT_PER_MIN=20

ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=claude-sonnet-4-5

# Database — Turso (libSQL) in prod; falls back to a local SQLite file for dev
TURSO_DATABASE_URL=...            # e.g. libsql://<db>.turso.io  (prod)
TURSO_AUTH_TOKEN=...              # prod
DATABASE_PATH=./data/sosoalpha.db # local dev snapshot

# SoDEX mainnet (public market data needs no auth; trading is signed
# client-side per user — no server-held SoDEX secret)
SODEX_SPOT_REST_URL=https://mainnet-gw.sodex.dev/api/v1/spot
SODEX_PERPS_REST_URL=https://mainnet-gw.sodex.dev/api/v1/perps

CLASSIFICATION_PAUSED=0
```

A working SQLite snapshot ships at `data/sosoalpha.db` so the dashboard renders against real data immediately on first run. Live trading requires a browser wallet (connected via RainbowKit) — keys are never sent to the server.

### Useful scripts

```bash
npm run dev               # local dev server
npm run typecheck         # tsc --noEmit
npm test                  # vitest unit tests
npm run ingest:news       # one-off news ingest cycle
npm run capture:landing   # re-capture landing-page screenshots via Playwright
```

---

## Project structure

```
src/
├── app/                  # Next.js App Router
│   ├── api/data/         # read-only data endpoints (one per dashboard page)
│   ├── api/cron/         # ingestion + briefing + rebalance-tick handlers
│   ├── api/sodex/        # execution-support endpoints (my-trades, etc.)
│   ├── api/trading/      # signal execute / dismiss / reset
│   ├── portfolio/        # live per-account portfolio
│   └── (pages)/          # one folder per dashboard route
├── components/
│   ├── ui/               # shared primitives (Num, DataTable, Addr, AssetLogo…)
│   ├── sodex/            # execute / positions / orders / balances panels
│   ├── portfolio/        # portfolio dashboard
│   └── …                 # domain components (signals, index-fund, home…)
├── lib/
│   ├── ai/               # Claude prompts + classifier
│   ├── calibration/      # corpus filter, significance scoring
│   ├── pipeline/         # base rates, lifecycle, entity history
│   ├── trading/          # signal generator (the heart of the system)
│   ├── alphaindex/       # index engine (v1 live / v2.1) + NAV ledger
│   ├── sodex-onchain/    # SoDEX client, EIP-712 signing, session keys
│   ├── db/               # libSQL/SQLite client + repos
│   └── format/           # shared rendering helpers
└── tests/                # vitest specs (incl. ui-primitives ratchet guard)
```

Key files to read first:

- `src/lib/trading/signal-generator.ts` — the 7-axis conviction engine
- `src/lib/sodex-onchain/client.ts` — SoDEX spot + perps execution + signing
- `src/lib/calibration/corpus-filter.ts` — pre-classification gate
- `PIPELINE_INVARIANTS.md` — invariants the system maintains
- `FRAMEWORK_NOTES.md` — v1 vs v2.1 framework design rationale

---

## Where we are on the agentic spectrum (honesty section)

Wave 1 was **LLM-powered with constrained tasks**: a classifier prompt per headline, a reasoning prompt per rebalance — no tool use, no autonomous execution.

Waves 2–3 added the **action layer**: signals and AlphaIndex allocations now become **real on-chain orders on SoDEX**, signed client-side, with live position and order state read back into the app. The execution loop is real; what remains gated is *autonomy* — trades are still user-initiated (one click), not fired by an unattended agent. That's deliberate.

Next (Wave 4–5): a research agent that fetches corroborating sources and on-chain data before scoring, and opt-in automated execution inside a risk envelope. We call each call an "agent" because it has a constrained task, a defined input schema, and a structured output — and now, for the first time, a real-world effect.

---

## Judging-criteria mapping

| Criterion | Where to look |
|---|---|
| **User Value & Practical Impact** | Live signals (`/signals`) → one-click SoDEX execution, audit trail (`/signal/[id]`), AlphaIndex (`/index-fund`), Portfolio (`/portfolio`) |
| **Functionality & Working Demo** | All of https://helix-alpha-kappa.vercel.app — real classified events, real signals, **real on-chain fills** on SoDEX mainnet |
| **Logic, Workflow & Product Design** | `PIPELINE_INVARIANTS.md`, `FRAMEWORK_NOTES.md`, the audit page proves every step |
| **Data / API Integration** | SoSoValue news + sector + ETF endpoints, Anthropic for classification + reasoning, **SoDEX live spot + perps execution** |
| **UX & Clarity** | Editorial layout, monospace + Fraunces typography, per-signal audit trail, viewport-fit dashboard, asset-logo tables |

---

## Team

**Daily-Up** — solo build, buildathon Wave 3.

---

## Acknowledgments

- **SoSoValue** for the OpenAPI access making structured news flow possible
- **Anthropic** for Claude driving classification and rebalance rationale
- **SoDEX** for the on-chain execution venue — spot + perps, live
