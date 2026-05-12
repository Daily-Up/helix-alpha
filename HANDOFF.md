# SosoAlpha — Codex Handoff Document

> **Read this entire file before writing any code.** It's the complete context for the project.
> Originally built by Claude Code; continuing in Codex / GPT.

---

## What This Project Is

**SosoAlpha** — an AI-powered "event-driven alpha" platform built for the **SoSoValue × Akindo Build-a-thon** ($10K USDT prize pool, 3-wave format).

**Core thesis:** Every news event has a measurable price impact. By classifying events with Claude AI and correlating them with historical price data, we surface patterns ("when this type of event fires, BTC moves X% in Y hours") and turn them into live trading signals.

**Differentiator from competitors (e.g. ETFSignal AI on Vercel):**
- They use demo data; we use **real** SoSoValue API data with real keys
- They cover only BTC + ETH ETFs; we cover **89 instruments** (29 tokens, 4 RWA, 10 ETF aggregates, 10 ETF funds, 11 stocks, 4 BTC treasuries, 13 SSI sector indexes, 8 macro indicators)
- They have one "Generate Signal" button; we have an autonomous classification + impact engine

---

## Current State (Working)

| Component | Status |
|---|---|
| Next.js 16 + TypeScript + Tailwind v4 scaffold | ✅ |
| SoSoValue API client (12 endpoints, all verified) | ✅ |
| Asset universe (89 instruments, resolved against live API) | ✅ |
| SQLite database (16 tables, asset-agnostic schema) | ✅ |
| Claude classifier (event_type/sentiment/severity/affected_assets via tool use) | ✅ |
| News ingest pipeline (pull → store → classify → link) | ✅ |
| `/api/cron/ingest-news` HTTP endpoint (auth-gated, idempotent) | ✅ |
| Dashboard UI (Event Stream page, Cron Audit, Asset Universe) | ✅ |
| Stub pages for Sectors / ETFs / Macro / Patterns / Signals / Portfolio | ✅ |
| **Real data**: 250 events ingested, 100 classified, 215 event↔asset links | ✅ |

**Verified-working CLI scripts:**
```
npm run smoke:sosovalue   # tests all 12 SoSoValue endpoints
npm run test:universe     # resolves 89 assets against /currencies
npm run test:db           # bootstraps DB + seeds assets
npm run test:classifier   # pulls 5 news + classifies via Claude
npm run ingest:news       # full ingest pipeline
npm run db:stats          # DB row counts + recent events
```

**Dev server:**
```
npm run dev               # localhost:3000
```
Visit `/`, `/jobs`, `/universe` — all functional.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router) + TypeScript |
| Styling | Tailwind v4 (with CSS custom properties for design tokens) |
| Database (local) | better-sqlite3 (synchronous, fast) |
| Database (production) | **NOT YET WIRED** — plan: Turso (libSQL, SQLite-compatible) |
| AI | `@anthropic-ai/sdk` — Claude Sonnet 4.5 currently, swap to Haiku 4.5 in prod for 5-10× cost savings |
| Validation | Zod |
| Charts | Recharts (installed but unused yet) |
| Icons | lucide-react |
| Hosting (planned) | Vercel + GitHub Actions cron |

---

## Project Structure

```
src/
├── app/
│   ├── layout.tsx                # root layout + dark theme
│   ├── globals.css               # design tokens (--bg, --fg, --accent...)
│   ├── page.tsx                  # /  Event Stream (functional)
│   ├── jobs/page.tsx             # /jobs  Cron audit (functional)
│   ├── universe/page.tsx         # /universe  Asset universe (functional)
│   ├── sectors/page.tsx          # stubs — wired to sidebar
│   ├── etfs/page.tsx
│   ├── macro/page.tsx
│   ├── patterns/page.tsx
│   ├── signals/page.tsx
│   ├── portfolio/page.tsx
│   └── api/
│       ├── cron/
│       │   └── ingest-news/route.ts   # Auth-gated cron endpoint
│       └── data/
│           ├── events/route.ts        # GET events with classifications
│           └── stats/route.ts         # GET dashboard stats
├── components/
│   ├── ui/                       # Card, Badge, Stat, ComingSoon, cn
│   ├── layout/                   # Sidebar, Topbar, Shell
│   └── events/                   # EventCard, EventFeed, EventFilters,
│                                 # RunIngestButton, StatsBar
└── lib/
    ├── env.ts                    # Zod-validated env loader
    ├── format.ts                 # fmtUsd, fmtPct, fmtRelative...
    ├── cron-auth.ts              # CRON_SECRET bearer-token check
    ├── sosovalue/                # API client (one file per endpoint group)
    │   ├── client.ts             # core fetch wrapper
    │   ├── types.ts              # response types (verified vs live API)
    │   ├── limits.ts             # API constraints + ETF symbol enum
    │   ├── news.ts               # /news + search + helpers
    │   ├── currencies.ts         # /currencies + klines
    │   ├── etfs.ts               # /etfs + summary-history + per-fund
    │   ├── indices.ts            # /indices (SSI sectors)
    │   ├── crypto-stocks.ts      # MSTR, COIN, miners, etc.
    │   ├── treasuries.ts         # BTC treasury companies
    │   ├── macro.ts              # /macro/events + history
    │   ├── sector.ts             # /currencies/sector-spotlight
    │   └── index.ts              # public re-exports
    ├── universe/
    │   ├── types.ts              # Asset, AssetKind, SosoValueRouting
    │   ├── default-watchlist.ts  # 89 assets, hand-curated
    │   ├── resolver.ts           # symbol → currency_id mapping
    │   └── index.ts
    ├── ai/
    │   ├── client.ts             # Anthropic SDK singleton
    │   ├── prompts/classify.ts   # tool schema + system prompt + user msg
    │   ├── classifier.ts         # classifyEvent + classifyBatch
    │   └── index.ts
    ├── ingest/
    │   ├── news.ts               # runNewsIngest pipeline
    │   └── index.ts
    └── db/
        ├── schema.sql            # full DB schema (16 tables)
        ├── client.ts             # connection + auto-bootstrap
        ├── repos/                # one file per logical table-group
        │   ├── assets.ts
        │   ├── events.ts
        │   ├── classifications.ts
        │   ├── klines.ts
        │   ├── etf-flows.ts
        │   ├── sectors.ts
        │   ├── macro.ts
        │   ├── impact.ts
        │   └── cron.ts
        └── index.ts
scripts/
├── smoke-test-sosovalue.ts
├── inspect-sosovalue.ts          # raw shape dumper (use if API changes)
├── inspect-etf-endpoints.ts
├── inspect-etf-final.ts
├── test-universe.ts
├── test-db.ts
├── test-classifier.ts
├── test-ingest-news.ts
└── db-stats.ts
data/
└── sosoalpha.db                  # SQLite, gitignored
```

---

## CRITICAL: SoSoValue API Quirks (Read Before Coding)

These bit me HARD. Don't trust the docs alone — verify against live responses.

### Authentication
- Header: `x-soso-api-key: <key>`
- Base URL: `https://openapi.sosovalue.com/openapi/v1`
- Get key at: `https://sosovalue.com/developer/dashboard`

### Response Envelope
ALL responses are wrapped: `{ code: 0, message: "success", data: <T> }`. The `sosoGet` client unwraps `.data` automatically.

### Field Name Realities (vs docs)
| Endpoint | Doc says | Actually returns |
|---|---|---|
| `/currencies` | `id, name, full_name` | **`currency_id, symbol, name`** |
| `/news` matched_currencies | `id, name` | **`currency_id, symbol, name`** |
| `/news` `release_time` | number | **string** (use `toMs()` to coerce) |
| `/news` `is_blue_verified` | `0\|1` | **boolean** |
| `/news` `tags`, `matched_currencies`, `media_info` | array | **may be `null`** (always default to `[]`) |
| `/currencies/{id}/klines` `timestamp` | number | **string** |
| `/currencies/sector-spotlight` | `sectors[]` (plural) | **`sector[]`** (singular) — fields `change_pct_24h`, `marketcap_dom` |
| `/indices` | array of objects | **array of TICKER STRINGS** (lowercase, e.g. "ssimag7") |
| `/indices/{t}/market-snapshot` | various | keys with **leading digits** like `"24h_change_pct"`, `"7day_roi"`, `"1month_roi"` — must use bracket notation |

### Required Params (gotchas)
| Endpoint | Required |
|---|---|
| `/etfs` | `symbol` + `country_code` (US, HK) |
| `/etfs/summary-history` | `symbol` + `country_code` |
| `/etfs/summary-history` history | `start_date`, `end_date` (YYYY-MM-DD strings, NOT ms timestamps) |
| `/etfs/{ticker}/history` | optional `start_date`, `end_date` (same format) |
| `/news` | `start_time`, `end_time` ARE ms timestamps (different from ETF!) |

### Data History Limits
| Endpoint | History | Format |
|---|---|---|
| `/news` (feed) | last 7 days only | ms timestamp params |
| `/news/search` | unlimited (use for backfill) | — |
| `/currencies/{id}/klines` | last 3 months, 1d interval only | ms timestamps, max 500 records |
| `/etfs/summary-history` | last 1 month only | YYYY-MM-DD, max 300 records |
| `/etfs/{ticker}/history` | last 1 month only | YYYY-MM-DD, max 300 records |
| `/macro/events/{name}/history` | not specified | YYYY-MM-DD, max 100 records |

### ETF Symbols + Country Codes (enum)
```ts
ETF_SUPPORTED_SYMBOLS = ["BTC","ETH","SOL","LTC","HBAR","XRP","DOGE","LINK","AVAX","DOT"]
ETF_COUNTRY_CODES = ["US","HK"]
```

### Volume Field Quirk
`/etfs/IBIT/market-snapshot` returns `volume` as a **string**, not a number. Coerce with `Number(v)`.

### Error Messages In Chinese
The 400 error response will sometimes have its `msg` field in Chinese. Example: `"缺少必须的[String]类型的参数[symbol]"` = "Missing required String parameter [symbol]". Don't be alarmed.

---

## Database Schema (16 Tables)

See `src/lib/db/schema.sql` for the source of truth. Summary:

| Table | Purpose |
|---|---|
| `assets` | 89 tracked instruments (token / rwa / etf_fund / etf_aggregate / stock / treasury / index / macro) |
| `news_events` | Raw SoSoValue news, deduplicated on news id |
| `event_assets` | M2M between events and assets (source: 'matched' from API or 'inferred' from Claude) |
| `classifications` | Claude AI taxonomy per event (event_type, sentiment, severity, confidence, reasoning) |
| `klines_daily` | OHLCV per asset per date (NOT YET POPULATED) |
| `etf_flows_daily` | Per-fund daily flows (NOT YET POPULATED) |
| `etf_aggregate_daily` | Aggregate flows per (symbol, country) (NOT YET POPULATED) |
| `sector_snapshots` | Point-in-time sector spotlight data (NOT YET POPULATED) |
| `macro_calendar` | Upcoming macro events (NOT YET POPULATED) |
| `macro_history` | Actual/forecast/previous values (NOT YET POPULATED) |
| `impact_metrics` | Per-event price impact at T+0/1h/4h/24h/7d (NOT YET POPULATED) |
| `patterns` | Discovered (event_type → impact stats) (NOT YET POPULATED) |
| `signals` | Live AI-fired trade signals (NOT YET POPULATED) |
| `paper_trades` | Simulated trades (NOT YET POPULATED) |
| `cron_runs` | Audit log for every cron run |
| `schema_version` | Migration tracker |

All FK keys cascade. All timestamps in **milliseconds** except `date` columns which are `YYYY-MM-DD` strings.

---

## Asset Universe (89 instruments)

Defined in `src/lib/universe/default-watchlist.ts`. Breakdown:

```
token:           29  (BTC, ETH, SOL, HYPE, ARB, AAVE, MKR, LDO, ENA, TAO, ...)
rwa:              4  (XAUT, PAXG, ONDO, USDS)
etf_aggregate:   10  (one per ETF_SUPPORTED_SYMBOLS, country=US)
etf_fund:        10  (IBIT, FBTC, GBTC, ARKB, BITB, HODL + ETHA, FETH, ETHE, ETHW)
stock:           11  (COIN, HOOD, PYPL, BLOCK, CRCL, RIOT, MARA, CIFR, IREN, WULF, HUT)
treasury:         4  (MSTR, TSLA, XYZ/Block, GME)
index:           13  (ssimag7, ssicefi, ssidefi, ssipayfi, ssimeme, ssiai,
                       ssirwa, ssinft, ssisocialfi, ssilayer1, ssilayer2,
                       ssidepin, ssigamefi)
macro:            8  (CPI, Core CPI, Nonfarm Payrolls, FOMC, PPI,
                       Existing Home Sales, ISM Manufacturing PMI, ISM Non-Manufacturing PMI)
```

Token currency_ids are **resolved at runtime** by hitting `/currencies` and matching on lowercase symbol. The resolver is cached for 1 hour. See `src/lib/universe/resolver.ts`.

To add a new asset: edit `default-watchlist.ts` and re-run the universe seeding (happens automatically on first ingest call, or run `npm run test:db`).

---

## How To Run Locally

```bash
# 1. Install (already done)
cd C:\Users\User\Desktop\sosoalpha
npm install

# 2. Configure .env.local (already populated with real keys)
# SOSOVALUE_API_KEY=SOSO-...
# ANTHROPIC_API_KEY=sk-ant-...
# ANTHROPIC_MODEL=claude-sonnet-4-5
# DATABASE_PATH=./data/sosoalpha.db
# CRON_SECRET=  (empty in dev)

# 3. Bootstrap DB + seed universe (one time)
npm run test:db

# 4. Pull + classify some news
npm run ingest:news -- --window=21600000 --max=50
# (~30-90s, costs ~$0.30 with Sonnet for 50 events)

# 5. Run dev server
npm run dev
# visit http://localhost:3000

# 6. Trigger ingest from the UI
# Click "▶ Run ingest now" in the top-right of the dashboard
```

---

## Cron Endpoint Pattern (For Building More)

The `/api/cron/ingest-news` route is the template. Every cron endpoint:

1. Imports `assertCronAuth` and gates entry
2. Marks `runtime = "nodejs"`, `dynamic = "force-dynamic"`, `maxDuration = 60`
3. Wraps the work in `Cron.recordRun(jobName, async () => { ... })` for audit logging
4. Returns JSON `{ ok: true, ...summary }` or `{ ok: false, error }`
5. Supports both `GET` and `POST` (curl-friendly)

To add new cron endpoints:
- `/api/cron/ingest-klines` — pull daily klines for every token in the universe
- `/api/cron/ingest-etf` — pull aggregate + per-fund ETF flows for BTC, ETH (start there)
- `/api/cron/snapshot-sectors` — call sector-spotlight, write a row per sector
- `/api/cron/ingest-macro` — refresh calendar + history for major events
- `/api/cron/compute-impact` — backfill impact_metrics for events that have klines available
- `/api/cron/compute-patterns` — aggregate impacts → patterns table

---

## What's Left To Build (Prioritized)

### Wave 1 Polish (high impact, low risk)
1. **`/api/cron/ingest-klines`** + cron — pull daily prices for all 33 tokens, store in klines_daily
2. **`/api/cron/ingest-etf`** + cron — pull ETF aggregate (BTC-US, ETH-US) and per-fund history (10 funds)
3. **`/api/cron/snapshot-sectors`** + cron — capture sector dominance every 5 min for narrative cycle history
4. **`/etfs` page** — render real BTC/ETH ETF flows with charts (data is ready)
5. **`/sectors` page** — sector dominance bar chart + 24h change leaderboard
6. **`/macro` page** — calendar + recent CPI/FOMC values

### Wave 2 — The Killer Feature
7. **Event Impact Engine** — for each classified event, look up klines around `release_time` and compute `impact_pct_1h/4h/24h/7d`. Store in `impact_metrics`. Limitation: with daily klines we can only approximate intra-day moves.
8. **Pattern Discovery** — group impact_metrics by event_type, compute avg/median/stddev, store in `patterns`. Surface in `/patterns` page.
9. **Live Signal Engine** — when a fresh event matches a known pattern with confidence >70%, emit a signal row.

### Wave 3 — Demo Showpiece
10. **SoDEX WebSocket** — browser-side connection for live prices (NO server cron needed for this — see "Real-time Architecture" below).
11. **Paper Trade Executor** — when a signal fires, open a paper trade at current SoDEX price; close at expected horizon; track P&L.
12. **Production Deploy** — Vercel + Turso + GitHub Actions cron (see plan below).

---

## Real-Time Architecture (Don't Get This Wrong)

**Three update tiers, NOT one:**

```
TIER 1: Browser → SoDEX WebSocket (live prices, ms latency, NO server)
TIER 2: GitHub Actions → /api/cron/ingest-news (every 5 min, Claude classifies)
TIER 3: GitHub Actions → /api/cron/ingest-etf (every 1h or daily)
```

**Critical insight:** SoDEX has no testnet (we have mainnet API only). For paper trading, use **mainnet read-only data** (live prices via WebSocket) and **simulate execution locally**. The codebase has `SODEX_REST_URL` + `SODEX_WS_URL` env vars but the SoDEX client isn't built yet.

---

## Production Deployment Plan

| Layer | Service | Free? | Notes |
|---|---|---|---|
| Hosting | Vercel | ✅ Hobby | Same as competitor; deploy from GitHub |
| Database | **Turso** (libSQL) | ✅ 9GB free tier | Drop-in for SQLite — replace `better-sqlite3` import with `@libsql/client` and use the same SQL |
| Cron | **GitHub Actions** | ✅ free | Vercel Hobby cron is once/day max — too slow. Use Actions cron `*/5 * * * *` to curl `/api/cron/ingest-news` with bearer token |
| AI | Anthropic | $$ pay-per-use | **Switch model to `claude-haiku-4-5`** before launch — 5-10× cheaper for structured classification, same quality |

**Action items for deployment:**
1. Create Turso DB, get connection URL
2. Build `src/lib/db/turso-client.ts` using `@libsql/client`, conditionally use it when `TURSO_URL` is set
3. Push to GitHub
4. Connect to Vercel, add env vars (SOSOVALUE_API_KEY, ANTHROPIC_API_KEY, CRON_SECRET, TURSO_URL, TURSO_AUTH_TOKEN)
5. Add `.github/workflows/ingest-news.yml` calling cron endpoint every 5 min
6. Boom.

---

## Cost Notes (Important)

Current run on Sonnet 4.5 with prompt caching:
- ~80% cache hit rate on input
- ~$0.006 per event classified
- 50 events ≈ $0.30
- Steady state at 5-min cron: ~$15-20/day

**Switching to Haiku 4.5 (`claude-haiku-4-5`)** drops this to **~$2-3/day**. Same JSON-structured output quality for taxonomy classification. Just change `ANTHROPIC_MODEL` env var.

---

## Style / Code Conventions

- **No emojis in code or comments** (kept clean — only used in this handoff for clarity)
- All files have a JSDoc-style header comment explaining purpose
- TypeScript strict mode; no `any` unless absolutely necessary
- Snake_case at API/DB boundary (matching the server), camelCase only at the React component boundary
- All timestamps in milliseconds (except `date` columns which are `YYYY-MM-DD`)
- All API constraints centralized in `src/lib/sosovalue/limits.ts`
- All currency math in cents/USD-decimal — never lose precision
- Repository pattern: `import { Events } from "@/lib/db"; Events.upsertEvent(...)`
- Components in `src/components/{ui|layout|events}/PascalCase.tsx`

---

## What I (Claude) Would Build Next If I Continued

In this exact order, because each unblocks the next:

```
1. /api/cron/ingest-klines              [30 min]
   → enables impact engine
2. Event Impact Engine + UI              [1 hr]
   → core differentiator vs competitors
3. /api/cron/ingest-etf                  [30 min]
4. /etfs functional page with charts     [45 min]
   → biggest visual win for demo
5. Pattern Discovery + /patterns page    [1 hr]
   → makes the "AI" claim concrete
6. SoDEX WebSocket + paper trades        [2 hr]
   → final demo showpiece
7. Switch model to Haiku                 [5 min]
8. Deploy Vercel + Turso + GH Actions    [1 hr]
```

---

## Files To NOT Touch Lightly

- `src/lib/db/schema.sql` — adding columns is safe; renaming requires a migration script
- `src/lib/sosovalue/types.ts` — every field name has been verified against the live API; if you change one, run `npm run inspect:sosovalue` to confirm
- `src/lib/ai/prompts/classify.ts` — bumping the prompt requires bumping `CLASSIFY_PROMPT_VERSION` so old classifications can be re-run

---

## Quick Verification Checklist (Run These Before You Start Coding)

```bash
cd C:\Users\User\Desktop\sosoalpha

# Should print "exit=0"
npx tsc --noEmit; echo exit=$?

# Should show 89 assets, 250+ events, 100+ classifications
npm run db:stats

# Should show all 12 endpoints green
npm run smoke:sosovalue
```

If any of these fail, fix them BEFORE writing new features.

---

## Build-a-thon Context

- **Sponsor:** SoSoValue (40M users, on-chain finance research platform)
- **Co-host:** Akindo (multi-wave hackathon platform)
- **Prize pool:** $10K USDT split across 3 waves
- **Format:** Wave 1 (idea + prototype) → Wave 2 (MVP + iterate) → Wave 3 (final demo)
- **Submission requires:**
  1. Project overview (target users, core logic, APIs used)
  2. Public GitHub repo with README + setup
  3. Public demo link (Vercel)
  4. Short video introduction
  5. Team info
  6. Progress updates per wave
- **Judging criteria:** clear use case, working product, innovation, leverages SoSoValue ecosystem, presentation quality

The UI already looks better than `etfsignal.vercel.app` (a known competitor that uses demo data).

---

## Files I Was About To Build Next

The user asked me which to build first:
- **Option A:** ETF flows page + sectors page + macro page (visual impact, fast)
- **Option B:** Event impact engine (the killer differentiator)
- **Option C:** SoDEX WebSocket + paper trades (demo showpiece)

The user did not pick before switching to Codex. Recommend **Option A → B → C** in order.

---

End of handoff. Good luck.
