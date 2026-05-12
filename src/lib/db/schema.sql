-- =============================================================================
-- SosoAlpha database schema
--
-- Targets SQLite (better-sqlite3 for local dev) and Turso (libSQL for prod).
-- Both speak the same SQL — keep statements ANSI-ish, avoid SQLite-only
-- niceties unless they're also valid in Turso.
--
-- Conventions
--   • Timestamps in milliseconds (unixepoch() * 1000) so JS Date(ms) works
--     directly. Macro / ETF dates that come from the API as YYYY-MM-DD are
--     stored as TEXT in that exact form.
--   • Cross-table references use TEXT ids, not autoincrement INTs, so we
--     can keep things idempotent across re-runs and migrations.
--   • All ON DELETE CASCADE on FK so wiping an event nukes its derived rows.
-- =============================================================================

-- ── 1. Asset registry ─────────────────────────────────────────────────────
-- Mirror of src/lib/universe/default-watchlist.ts at runtime. The ingest
-- worker upserts every asset on startup so foreign keys can point here.

CREATE TABLE IF NOT EXISTS assets (
  id          TEXT PRIMARY KEY,                -- "tok-btc", "etf-ibit", ...
  symbol      TEXT NOT NULL,                   -- "BTC", "IBIT", ...
  name        TEXT NOT NULL,                   -- "Bitcoin", "iShares Bitcoin Trust"
  kind        TEXT NOT NULL,                   -- token | rwa | etf_fund | etf_aggregate | stock | treasury | index | macro
  tags        TEXT NOT NULL DEFAULT '[]',      -- JSON array of AssetTag
  routing     TEXT NOT NULL,                   -- JSON SosoValueRouting (resolved)
  /** JSON SodexTradable or NULL — only for assets with a SoDEX trading pair. */
  tradable    TEXT,
  rank        INTEGER,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_assets_symbol   ON assets(symbol);
CREATE INDEX IF NOT EXISTS idx_assets_kind     ON assets(kind);
CREATE INDEX IF NOT EXISTS idx_assets_tradable ON assets(tradable) WHERE tradable IS NOT NULL;

-- ── 2. Raw news events ────────────────────────────────────────────────────
-- One row per SoSoValue news id. We persist the full raw payload so we can
-- re-classify with a better Claude prompt later without re-fetching.

CREATE TABLE IF NOT EXISTS news_events (
  id                  TEXT PRIMARY KEY,        -- SoSoValue news id
  release_time        INTEGER NOT NULL,        -- ms
  title               TEXT NOT NULL,
  content             TEXT,                    -- HTML
  author              TEXT,
  source_link         TEXT,
  original_link       TEXT,
  category            INTEGER NOT NULL,        -- 1=news, 2=research, 3=institution, 4=KOL, 7=announce, 13=stock
  tags                TEXT,                    -- JSON array
  matched_currencies  TEXT,                    -- JSON array of {currency_id, symbol, name}
  impression_count    INTEGER,
  like_count          INTEGER,
  retweet_count       INTEGER,
  is_blue_verified    INTEGER NOT NULL DEFAULT 0,
  /** When this event is a duplicate of an earlier story (same news from
   *  a different outlet), this references the canonical event_id. NULL
   *  for canonical events. Duplicates are skipped by the classifier so
   *  we don't burn Claude tokens on the same story 4 times. */
  duplicate_of        TEXT REFERENCES news_events(id),
  raw_json            TEXT NOT NULL,           -- full original SoSoValue payload
  ingested_at         INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_news_release_time ON news_events(release_time DESC);
CREATE INDEX IF NOT EXISTS idx_news_category     ON news_events(category);

-- ── 3. Event ↔ Asset many-to-many ─────────────────────────────────────────
-- Populated from news.matched_currencies + Claude's affected_assets list.
-- Source: 'matched' (from SoSoValue) or 'inferred' (from Claude).

CREATE TABLE IF NOT EXISTS event_assets (
  event_id  TEXT NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
  asset_id  TEXT NOT NULL REFERENCES assets(id)      ON DELETE CASCADE,
  source    TEXT NOT NULL DEFAULT 'matched',         -- matched | inferred
  PRIMARY KEY (event_id, asset_id, source)
);
CREATE INDEX IF NOT EXISTS idx_event_assets_asset ON event_assets(asset_id);

-- ── 4. Claude AI classifications ──────────────────────────────────────────
-- One row per event. Re-classifying overwrites (UPSERT semantics).

CREATE TABLE IF NOT EXISTS classifications (
  event_id          TEXT PRIMARY KEY REFERENCES news_events(id) ON DELETE CASCADE,
  event_type        TEXT NOT NULL,             -- exploit | regulatory | etf_flow | partnership | listing | social_platform | unlock | airdrop | earnings | macro | other
  sentiment         TEXT NOT NULL,             -- positive | negative | neutral
  severity          TEXT NOT NULL,             -- high | medium | low
  confidence        REAL NOT NULL,             -- 0..1
  /** TRUE only if a trader could profitably act on this RIGHT NOW. */
  actionable        INTEGER,                   -- bool: 1 = act now, 0 = stale/commentary
  /** When did the underlying event happen, regardless of article publish time. */
  event_recency     TEXT,                      -- live | today | this_week | older
  affected_asset_ids TEXT NOT NULL DEFAULT '[]', -- JSON array
  reasoning         TEXT NOT NULL,
  model             TEXT NOT NULL,
  prompt_version    TEXT NOT NULL DEFAULT 'v1',
  classified_at     INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  /** Dimension 1 — semantic embedding of (title + primaryActor + affectedEntities).
   *  JSON-serialized number array. Used by the freshness gate to detect
   *  duplicate coverage across outlets. NULL on rows pre-D1. */
  embedding         TEXT,
  /** When the freshness gate flagged this article as semantically similar
   *  (continuation band) to a prior event, we link to that prior id here.
   *  Downstream conviction scoring treats these as low-novelty. */
  coverage_continuation_of TEXT REFERENCES news_events(id),
  /** Dimensions 3/4 — reasoning-enriched classifier output. */
  mechanism_length        INTEGER,             -- 1..4 (null on legacy rows)
  mechanism_reasoning     TEXT,                -- chain of steps from event to price move
  counterfactual_strength TEXT,                -- weak | moderate | strong (null on legacy)
  counterfactual_reasoning TEXT
);
CREATE INDEX IF NOT EXISTS idx_class_event_type ON classifications(event_type);
CREATE INDEX IF NOT EXISTS idx_class_sentiment  ON classifications(sentiment);
CREATE INDEX IF NOT EXISTS idx_class_severity   ON classifications(severity);

-- ── 5. Daily klines (OHLCV) per asset ─────────────────────────────────────
-- Date stored as YYYY-MM-DD to match the API's natural format.
-- Used for impact-metric backfill and chart overlays.

CREATE TABLE IF NOT EXISTS klines_daily (
  asset_id  TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  date      TEXT NOT NULL,                     -- YYYY-MM-DD (UTC)
  open      REAL,
  high      REAL,
  low       REAL,
  close     REAL,
  volume    REAL,
  PRIMARY KEY (asset_id, date)
);
CREATE INDEX IF NOT EXISTS idx_klines_date ON klines_daily(date DESC);

-- ── 6. ETF flows ──────────────────────────────────────────────────────────

-- Per-fund daily flows (from /etfs/{ticker}/history).
CREATE TABLE IF NOT EXISTS etf_flows_daily (
  ticker         TEXT NOT NULL,
  date           TEXT NOT NULL,
  net_inflow     REAL,
  cum_inflow     REAL,
  net_assets     REAL,
  currency_share REAL,
  prem_dsc       REAL,
  value_traded   REAL,
  volume         REAL,
  PRIMARY KEY (ticker, date)
);
CREATE INDEX IF NOT EXISTS idx_etf_flows_date ON etf_flows_daily(date DESC);

-- Aggregate daily flows per (asset, country) (from /etfs/summary-history).
CREATE TABLE IF NOT EXISTS etf_aggregate_daily (
  symbol             TEXT NOT NULL,
  country_code       TEXT NOT NULL,
  date               TEXT NOT NULL,
  total_net_inflow   REAL,
  cum_net_inflow     REAL,
  total_net_assets   REAL,
  total_value_traded REAL,
  PRIMARY KEY (symbol, country_code, date)
);
CREATE INDEX IF NOT EXISTS idx_etf_agg_date ON etf_aggregate_daily(date DESC);

-- ── 7. Sector spotlight history ───────────────────────────────────────────
-- /currencies/sector-spotlight is point-in-time. We snapshot it periodically
-- so we can plot sector dominance over time → narrative cycle clock.

CREATE TABLE IF NOT EXISTS sector_snapshots (
  snapshot_at     INTEGER NOT NULL,            -- ms
  sector_name     TEXT NOT NULL,
  change_pct_24h  REAL,
  marketcap_dom   REAL,
  PRIMARY KEY (snapshot_at, sector_name)
);
CREATE INDEX IF NOT EXISTS idx_sector_name ON sector_snapshots(sector_name);

-- ── 8. Macro calendar + history ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS macro_calendar (
  date    TEXT NOT NULL,                       -- YYYY-MM-DD
  event   TEXT NOT NULL,                       -- e.g. "CPI"
  PRIMARY KEY (date, event)
);

CREATE TABLE IF NOT EXISTS macro_history (
  event           TEXT NOT NULL,
  date            TEXT NOT NULL,                    -- YYYY-MM-DD
  /** Raw reading as returned by the API, including unit. e.g. "0.9%". */
  actual_raw      TEXT,
  forecast_raw    TEXT,
  previous_raw    TEXT,
  /** Numeric form parsed from raw (% stripped, etc.) for surprise math. */
  actual          REAL,
  forecast        REAL,
  previous        REAL,
  /** Unit suffix detected during parse — "%" or NULL. */
  unit            TEXT,
  /** actual - forecast in raw units. NULL when either side missing. */
  surprise        REAL,
  PRIMARY KEY (event, date)
);
CREATE INDEX IF NOT EXISTS idx_macro_history_date ON macro_history(date DESC);
CREATE INDEX IF NOT EXISTS idx_macro_history_event_date ON macro_history(event, date DESC);

-- ── 9. Per-event impact metrics ───────────────────────────────────────────
-- Computed by the backtest engine: for each (event, affected_asset) record
-- the price at T+0/1h/4h/24h/7d and the % move. Daily klines means our
-- intra-day numbers are interpolated — ok for a v1.

-- Daily klines mean we measure impact over day-aligned horizons (T+1d, T+3d,
-- T+7d) rather than intra-day (1h, 4h). The columns below match this.
CREATE TABLE IF NOT EXISTS impact_metrics (
  event_id          TEXT NOT NULL REFERENCES news_events(id) ON DELETE CASCADE,
  asset_id          TEXT NOT NULL REFERENCES assets(id)      ON DELETE CASCADE,
  /** Anchor close: the trading day's close on or before the event timestamp. */
  price_t0          REAL,
  /** Next trading day's close. */
  price_t1d         REAL,
  /** 3 trading days later. */
  price_t3d         REAL,
  /** 7 trading days later. */
  price_t7d         REAL,
  impact_pct_1d     REAL,
  impact_pct_3d     REAL,
  impact_pct_7d     REAL,
  computed_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (event_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_impact_1d ON impact_metrics(impact_pct_1d);
CREATE INDEX IF NOT EXISTS idx_impact_7d ON impact_metrics(impact_pct_7d);

-- ── 10. Discovered patterns ───────────────────────────────────────────────
-- (event_type, asset_id?, horizon) → distribution of historical impacts.
-- asset_id NULL = cross-asset pattern (any token).

CREATE TABLE IF NOT EXISTS patterns (
  id                   TEXT PRIMARY KEY,       -- "exploit:btc:4h" or "exploit:*:24h"
  event_type           TEXT NOT NULL,
  asset_id             TEXT REFERENCES assets(id) ON DELETE CASCADE,
  horizon              TEXT NOT NULL,          -- 1h | 4h | 24h | 7d
  sample_size          INTEGER NOT NULL,
  avg_impact_pct       REAL NOT NULL,
  median_impact_pct    REAL,
  stddev_impact_pct    REAL,
  /** Heuristic 0..1 (sample size + variance). */
  confidence           REAL,
  computed_at          INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_patterns_event_type ON patterns(event_type);

-- ── 11. Live AI-generated signals ─────────────────────────────────────────
-- A signal is the engine's recommendation for a tradable action. Three tiers:
--   auto    — confidence ≥ auto threshold, fires paper trade if auto-trade enabled
--   review  — confidence ≥ review threshold, surfaces in UI for manual approval
--   info    — confidence ≥ info threshold, informational only (no action button)

CREATE TABLE IF NOT EXISTS signals (
  id                       TEXT PRIMARY KEY,
  fired_at                 INTEGER NOT NULL,
  triggered_by_event_id    TEXT REFERENCES news_events(id),
  pattern_id               TEXT REFERENCES patterns(id),
  asset_id                 TEXT NOT NULL REFERENCES assets(id),
  /** SoDEX trading symbol (denormalised for fast lookup). */
  sodex_symbol             TEXT NOT NULL,
  direction                TEXT NOT NULL,            -- long | short
  tier                     TEXT NOT NULL,            -- auto | review | info
  status                   TEXT NOT NULL DEFAULT 'pending', -- pending | executed | dismissed | expired
  confidence               REAL NOT NULL,            -- 0..1
  /** Optional pattern-derived stats. */
  expected_impact_pct      REAL,
  expected_horizon         TEXT,
  /** Engine-suggested trade params (user can override on manual). */
  suggested_size_usd       REAL,
  suggested_stop_pct       REAL,
  suggested_target_pct     REAL,
  /** Human-readable reasoning for the signal. */
  reasoning                TEXT NOT NULL,
  /** Other assets the same event affects, stored as JSON array of asset_ids.
   *  We fire ONE signal per event (on the primary asset); the rest are
   *  recorded here for UI display ("also affected: BTC, MAG7"). NULL on
   *  legacy rows pre-secondary tracking. */
  secondary_asset_ids      TEXT,
  /** Pipeline metadata — populated by src/lib/pipeline/* modules at fire time.
   *  All nullable because legacy rows pre-pipeline-wiring won't have them. */
  catalyst_subtype         TEXT,                       -- see CatalystSubtype taxonomy
  expires_at               INTEGER,                    -- ms epoch — when signal goes stale
  corroboration_deadline   INTEGER,                    -- ms epoch — by when ≥1 corroborating source needed (single-source only)
  event_chain_id           TEXT,                       -- shared across signals on the same evolving story
  asset_relevance          REAL,                       -- 0..1 — primary asset's relevance score from asset-router
  promotional_score        REAL,                       -- 0..1 — shill/hype score from promotional detector
  source_tier              INTEGER,                    -- 1=tier-1 (Bloomberg/SEC), 2=tier-2 outlets, 3=KOL/anon
  executed_at              INTEGER,
  dismissed_at             INTEGER,
  /** When status='dismissed' or 'expired', the typed reason set by the
   *  lifecycle sweeper or invariant gate. See DismissReason in pipeline/types.ts. */
  dismiss_reason           TEXT,
  paper_trade_id           TEXT,
  /** Phase C — composite significance score [0..1] from
   *  src/lib/calibration/significance.ts. NULL on legacy rows pre-Phase-C. */
  significance_score       REAL,
  /** Phase E — when superseded by a stronger opposite-direction signal,
   *  this points at the superseding signal id. NULL when status is not
   *  'superseded'. The signal_supersessions table holds the audit row. */
  superseded_by_signal_id  TEXT,
  /** Phase D/E — when status='suppressed' or 'superseded', the ms epoch
   *  at which the standing window was cut short (vs. original expires_at). */
  effective_end_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_signals_fired_at ON signals(fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_asset    ON signals(asset_id);
CREATE INDEX IF NOT EXISTS idx_signals_status   ON signals(status);
CREATE INDEX IF NOT EXISTS idx_signals_tier     ON signals(tier);

-- ── 11b. Signal outcomes (Part 1: empirical feedback loop) ───────────────
-- One row per signal recording what actually happened to the underlying
-- asset over the signal's horizon. Populated:
--   • at fire time:    outcome=NULL with everything known at generation
--   • at dismissal:    outcome='dismissed' (immediate)
--   • at gate refusal: outcome='blocked' (immediate, signal_id is the
--                                          would-have-been id)
--   • by sweeper:      outcome ∈ {target_hit, stop_hit, flat} once the
--                                  resolution job walks price history
--
-- Timestamps are ms-epoch INTEGER for consistency with the rest of the
-- schema (the spec text used TEXT but our existing tables use INTEGER —
-- documented as a deliberate divergence in PIPELINE_INVARIANTS.md).
--
-- Invariant I-30: every persisted signal MUST have a corresponding row.

CREATE TABLE IF NOT EXISTS signal_outcomes (
  signal_id            TEXT PRIMARY KEY,
  asset_id             TEXT NOT NULL,
  direction            TEXT NOT NULL,        -- 'long' | 'short'
  catalyst_subtype     TEXT NOT NULL,
  asset_class          TEXT NOT NULL,
  tier                 TEXT NOT NULL,        -- 'auto' | 'review' | 'info'
  conviction           REAL NOT NULL,

  generated_at         INTEGER NOT NULL,
  horizon_hours        INTEGER NOT NULL,
  expires_at           INTEGER NOT NULL,

  /** NULL when no kline existed at fire time (asset not priceable). */
  price_at_generation  REAL,
  target_pct           REAL NOT NULL,
  stop_pct             REAL NOT NULL,

  /** NULL = pending; the resolution job retries while NULL + expires_at>now. */
  outcome              TEXT,                 -- 'target_hit'|'stop_hit'|'flat'|'dismissed'|'blocked'
  outcome_at           INTEGER,
  price_at_outcome     REAL,
  realized_pct         REAL,
  realized_pnl_usd     REAL,

  /** Free-form: gate refusal rule, dismissal note, etc. */
  notes                TEXT,
  recorded_at          INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  /** Allocation framework that was active when the signal fired.
   *  Defaults 'v1' for back-compat with rows pre-v2.1 graduation. */
  framework_version    TEXT NOT NULL DEFAULT 'v1'
);

CREATE INDEX IF NOT EXISTS idx_outcomes_framework     ON signal_outcomes(framework_version, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_outcomes_subtype       ON signal_outcomes(catalyst_subtype);
CREATE INDEX IF NOT EXISTS idx_outcomes_tier          ON signal_outcomes(tier);
CREATE INDEX IF NOT EXISTS idx_outcomes_asset_class   ON signal_outcomes(asset_class);
CREATE INDEX IF NOT EXISTS idx_outcomes_outcome       ON signal_outcomes(outcome);
CREATE INDEX IF NOT EXISTS idx_outcomes_generated_at  ON signal_outcomes(generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_outcomes_pending       ON signal_outcomes(outcome) WHERE outcome IS NULL;

-- ── 11c. System alerts (Part 3: live-deployment readiness) ────────────────
CREATE TABLE IF NOT EXISTS system_alerts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  raised_at    INTEGER NOT NULL,
  kind         TEXT NOT NULL,    -- 'job_stale'|'outcomes_stuck'|'classifier_errors'|'gate_spike'|'backup_failed'
  severity     TEXT NOT NULL,    -- 'warn'|'error'
  message      TEXT NOT NULL,
  resolved_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alerts_raised ON system_alerts(raised_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_open ON system_alerts(resolved_at) WHERE resolved_at IS NULL;

-- ── 12. Paper trades (simulated) ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS paper_trades (
  id            TEXT PRIMARY KEY,
  signal_id     TEXT REFERENCES signals(id),
  asset_id      TEXT NOT NULL REFERENCES assets(id),
  /** SoDEX symbol used for live price reconciliation. */
  sodex_symbol  TEXT NOT NULL,
  /** "long" or "short" — kept consistent with signals.direction. */
  direction     TEXT NOT NULL,
  size_usd      REAL NOT NULL,
  entry_price   REAL NOT NULL,
  entry_time    INTEGER NOT NULL,
  /** Stop-loss + take-profit prices (absolute, not percent). */
  stop_price    REAL,
  target_price  REAL,
  exit_price    REAL,
  exit_time     INTEGER,
  exit_reason   TEXT,                          -- target | stop | manual | timeout
  pnl_usd       REAL,
  pnl_pct       REAL,
  status        TEXT NOT NULL DEFAULT 'open'   -- open | closed
);
CREATE INDEX IF NOT EXISTS idx_paper_trades_status ON paper_trades(status);
CREATE INDEX IF NOT EXISTS idx_paper_trades_asset  ON paper_trades(asset_id);

-- ── 13. Cron / job audit log ──────────────────────────────────────────────
-- Lets us see in the UI when each ingest last ran + how it did.

CREATE TABLE IF NOT EXISTS cron_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job         TEXT NOT NULL,                   -- "ingest_news" | "ingest_etf" | ...
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  status      TEXT NOT NULL,                   -- running | ok | error
  /** Free-form summary, e.g. "fetched 87 events, classified 23". */
  summary     TEXT,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job, started_at DESC);

-- ── 13b. AlphaIndex — AI-managed portfolio ───────────────────────────────
-- A managed portfolio that rebalances over time as signals + sector momentum
-- accumulate. Each rebalance produces a row in index_rebalances with the
-- weight deltas + an AI-written reasoning paragraph.

CREATE TABLE IF NOT EXISTS indexes (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  description        TEXT,
  starting_nav       REAL NOT NULL,
  created_at         INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Seed AlphaCore on first boot. starting_nav matches paper_starting_balance.
INSERT OR IGNORE INTO indexes (id, name, description, starting_nav)
VALUES (
  'alphacore',
  'AlphaCore',
  'AI-managed crypto index. Rebalances based on news signals, sector momentum, and ETF flows.',
  10000
);

CREATE TABLE IF NOT EXISTS index_positions (
  index_id            TEXT NOT NULL REFERENCES indexes(id) ON DELETE CASCADE,
  asset_id            TEXT NOT NULL REFERENCES assets(id),
  /** Target weight 0..1. */
  target_weight       REAL NOT NULL,
  /** Current dollar value (mark-to-market). Refreshed by the executor. */
  current_value_usd   REAL NOT NULL DEFAULT 0,
  /** Volume-weighted average entry price (in quote currency). */
  avg_entry_price     REAL,
  /** Quantity held in base units. */
  quantity            REAL NOT NULL DEFAULT 0,
  /** Why this asset is in the portfolio. Human-readable string built from
   *  the weight engine's CandidateScore.drivers (e.g. "anchor base 28% ·
   *  30d +11.4% (×1.21) · 2 signals (×1.18)"). Visible per-row in the
   *  Holdings table so the user understands every pick. */
  rationale           TEXT,
  last_updated        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (index_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_index_positions_idx ON index_positions(index_id);

CREATE TABLE IF NOT EXISTS index_rebalances (
  id                  TEXT PRIMARY KEY,
  index_id            TEXT NOT NULL REFERENCES indexes(id) ON DELETE CASCADE,
  rebalanced_at       INTEGER NOT NULL,
  /** scheduled | manual | signal_cluster. */
  triggered_by        TEXT NOT NULL,
  pre_nav             REAL NOT NULL,
  post_nav            REAL NOT NULL,
  /** JSON snapshot of weights before, {asset_id: weight}. */
  old_weights         TEXT NOT NULL,
  new_weights         TEXT NOT NULL,
  /** JSON array of {asset_id, side, size_usd, fill_price}. */
  trades_made         TEXT NOT NULL DEFAULT '[]',
  reasoning           TEXT NOT NULL,
  reviewer_model      TEXT,
  /** Allocation framework that produced this rebalance. v1 = legacy
   *  anchor+momentum engine; v2 = regime-aware allocator with
   *  vol-targeting and circuit breaker. Default 'v1' for back-compat. */
  framework_version   TEXT NOT NULL DEFAULT 'v1'
);
CREATE INDEX IF NOT EXISTS idx_index_rebalances_at ON index_rebalances(index_id, rebalanced_at DESC);

CREATE TABLE IF NOT EXISTS index_nav_history (
  index_id            TEXT NOT NULL REFERENCES indexes(id) ON DELETE CASCADE,
  date                TEXT NOT NULL,                 -- YYYY-MM-DD
  nav_usd             REAL NOT NULL,
  pnl_usd             REAL NOT NULL DEFAULT 0,
  pnl_pct             REAL NOT NULL DEFAULT 0,
  /** Benchmark prices captured the same day (NULL until backfilled). */
  btc_price           REAL,
  ssimag7_price       REAL,
  PRIMARY KEY (index_id, date)
);

-- ── 14. User settings (KV store) ──────────────────────────────────────────
-- Single-user app for the build-a-thon. Keys/values are strings; the
-- application layer parses them into the right type.

CREATE TABLE IF NOT EXISTS user_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Defaults — set once on first boot, never overwrites later.
-- Conviction = classification.confidence × event_type_tradability × severity.
-- Thresholds calibrated against typical mid-severity crypto catalysts
-- (earnings/medium/85% ≈ 42%, treasury/high/75% ≈ 52%, regulatory/medium/85% ≈ 48%).
INSERT OR IGNORE INTO user_settings (key, value) VALUES
  ('auto_trade_enabled',          'false'),
  ('auto_trade_min_confidence',   '0.75'),
  ('review_min_confidence',       '0.50'),
  ('info_min_confidence',         '0.30'),
  ('default_position_size_usd',   '500'),
  ('max_concurrent_positions',    '5'),
  ('max_daily_trades',            '10'),
  ('default_stop_loss_pct',       '8'),
  ('default_take_profit_pct',     '18'),
  ('paper_starting_balance_usd',  '10000'),
  -- AlphaIndex settings
  ('index_auto_rebalance',         'false'),
  ('index_min_position_pct',       '2'),
  ('index_max_position_pct',       '25'),
  ('index_cash_reserve_pct',       '5'),
  ('index_rebalance_threshold_pct','1'),
  ('index_review_with_claude',     'true'),
  ('index_framework_version',      'v1');

-- ── 14a. BTC Treasuries (corporate balance-sheet ledger) ─────────────────
-- Mirrors SoSoValue's /btc-treasuries + /purchase-history endpoints.
-- Companies holding BTC on balance sheet (MSTR, MARA, Metaplanet, etc.)
-- and their dated acquisition events. Feeds the Daily Briefing as a
-- hard-fact input alongside ETF flows + pending signals.

CREATE TABLE IF NOT EXISTS btc_treasury_companies (
  ticker          TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  /** Country of primary listing — "United States", "Japan", etc. */
  list_location   TEXT,
  last_synced_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS btc_treasury_purchases (
  ticker            TEXT NOT NULL REFERENCES btc_treasury_companies(ticker)
                    ON DELETE CASCADE,
  /** YYYY-MM-DD UTC. */
  date              TEXT NOT NULL,
  /** Total BTC holdings AFTER this transaction. */
  btc_holding       REAL NOT NULL,
  /** BTC acquired (or sold, if negative) THIS transaction. */
  btc_acq           REAL NOT NULL,
  /** Total USD spent on this transaction. NULL when not disclosed. */
  acq_cost_usd      REAL,
  /** Cost per BTC in USD — derived from acq_cost / btc_acq when both
   *  present, NULL otherwise. The API's avg_btc_cost field is unreliable. */
  avg_btc_cost_usd  REAL,
  ingested_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (ticker, date)
);
CREATE INDEX IF NOT EXISTS idx_btc_purchases_date
  ON btc_treasury_purchases(date DESC);
CREATE INDEX IF NOT EXISTS idx_btc_purchases_ticker_date
  ON btc_treasury_purchases(ticker, date DESC);

-- ── 14b. Daily AI Briefings ───────────────────────────────────────────────
-- One Claude-generated market read per day. Synthesizes pending signals,
-- recent classifications, sector rotation, ETF flows, and AlphaIndex
-- positions into a 3-paragraph human-readable market thesis with a single
-- "top pick" trade idea and a watchlist. Demonstrates Claude reasoning
-- across the full data surface, not just one input.

CREATE TABLE IF NOT EXISTS briefings (
  /** YYYY-MM-DD UTC — one briefing per day, idempotent on date. */
  date              TEXT PRIMARY KEY,
  generated_at      INTEGER NOT NULL,
  /** Headline summary, e.g. "Risk-on tape; COIN earnings in focus". */
  headline          TEXT NOT NULL,
  /** Market regime label produced by Claude: risk_on | risk_off | mixed | neutral. */
  regime            TEXT NOT NULL,
  /** 3-paragraph body in markdown. */
  body              TEXT NOT NULL,
  /** Single highest-conviction trade idea — JSON {asset_id, asset_symbol, direction, thesis, conviction}. */
  top_pick          TEXT,
  /** 3-5 secondary names to watch — JSON array of {asset_id, symbol, note}. */
  watchlist         TEXT,
  /** What data went IN to producing the briefing, for transparency on the page. */
  inputs_summary    TEXT NOT NULL,
  /** Claude metadata. */
  model             TEXT NOT NULL,
  prompt_version    TEXT NOT NULL DEFAULT 'v1',
  tokens_input      INTEGER NOT NULL DEFAULT 0,
  tokens_output     INTEGER NOT NULL DEFAULT 0,
  tokens_cached     INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_briefings_generated ON briefings(generated_at DESC);

-- ── 14b. Signal P&L attribution (Part 3) ─────────────────────────────────
-- Per-rebalance record of how news signals tilted weights vs. the
-- momentum-only counterfactual, plus the realized USD P&L of those tilts
-- between rebalances. Lets the UI answer "did signals add value this
-- month?" with hard numbers. Only sane attributions are stored — see
-- signal-attribution.ts for the sanity rules and I-31.
CREATE TABLE IF NOT EXISTS signal_pnl_attribution (
  id                 TEXT PRIMARY KEY,
  index_id           TEXT NOT NULL,
  rebalance_id       TEXT NOT NULL,           -- joins index_rebalances.id
  asof_ms            INTEGER NOT NULL,
  pre_nav_usd        REAL NOT NULL,
  /** JSON: asset_id → weight delta in basis points (actual − cf). */
  weight_deltas_bps  TEXT NOT NULL,
  /** JSON: asset_id → realized USD pnl. NULL until next rebalance resolves. */
  realized_pnl_usd   TEXT,
  total_pnl_usd      REAL,
  /** 0 if counterfactual was malformed and deltas were zeroed. */
  sanity_ok          INTEGER NOT NULL DEFAULT 1,
  sanity_note        TEXT,
  created_at         INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  resolved_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_signal_attrib_rebalance ON signal_pnl_attribution(rebalance_id);
CREATE INDEX IF NOT EXISTS idx_signal_attrib_index ON signal_pnl_attribution(index_id, asof_ms DESC);

-- ── 14d. Shadow portfolio (Part 2 of v2.1 attribution) ──────────────────
-- The non-active framework runs in parallel against this lightweight
-- ledger so we accumulate side-by-side data. NAV is updated per
-- rebalance cycle by mark-to-market'ing the previous shadow weights
-- against current prices, then rebalancing to the new shadow weights.
-- Positions are virtual (recomputed each cycle from new_weights × NAV
-- ÷ price); only NAV + cash are persisted. See I-37.
CREATE TABLE IF NOT EXISTS shadow_portfolio (
  framework_version    TEXT PRIMARY KEY,
  nav_usd              REAL NOT NULL,
  cash_usd             REAL NOT NULL,
  last_rebalance_at    TEXT,
  started_at           TEXT NOT NULL
);
-- Seed both frameworks at $10,000 on first boot. The application layer
-- can re-seed from settings.paper_starting_balance_usd if needed.
INSERT OR IGNORE INTO shadow_portfolio (framework_version, nav_usd, cash_usd, started_at)
VALUES
  ('v1', 10000, 10000, datetime('now')),
  ('v2', 10000, 10000, datetime('now'));

-- ── 14e. Framework switch journal (Part 3 of v2.1 attribution) ───────────
-- Auditable record of every framework selection event. Captures
-- trailing 30d returns at switch time so we can later ask "did the
-- user switch right after a bad month." See I-38.
CREATE TABLE IF NOT EXISTS framework_switches (
  id                          TEXT PRIMARY KEY,
  switched_at                 TEXT NOT NULL,
  from_version                TEXT NOT NULL,
  to_version                  TEXT NOT NULL,
  user_confirmed_understanding INTEGER NOT NULL,
  live_nav_at_switch          REAL NOT NULL,
  shadow_nav_at_switch        REAL NOT NULL,
  v1_30d_return               REAL,
  v2_30d_return               REAL,
  notes                       TEXT
);
CREATE INDEX IF NOT EXISTS idx_framework_switches_at ON framework_switches(switched_at DESC);

-- ── 14c. v2 acceptance gate (Part — v2 framework) ────────────────────────
-- Records whether the v2 allocation framework currently meets its
-- three published acceptance criteria. Latest row per index_id is the
-- truth the UI shows. v2 is preview-only until a row reads passed=1.
CREATE TABLE IF NOT EXISTS v2_acceptance (
  id              TEXT PRIMARY KEY,
  index_id        TEXT NOT NULL,
  evaluated_at    INTEGER NOT NULL,
  passed          INTEGER NOT NULL,           -- 0/1
  /** JSON: per-criterion results array. Each: {key, label, passed, observed, threshold, detail}. */
  criteria_json   TEXT NOT NULL,
  /** Raw stress test summary used to evaluate. */
  stress_summary  TEXT,
  /** Live-period return + benchmark used. */
  live_summary    TEXT
);
CREATE INDEX IF NOT EXISTS idx_v2_acceptance_index ON v2_acceptance(index_id, evaluated_at DESC);

-- ── 16. Significance pipeline (Phase C — invariant I-41) ─────────────────
-- Headlines that pass classification but score below 0.25 on the
-- significance pipeline are dropped at ingestion — they never become
-- signals. We record them here for forensics (drop-rate monitoring on
-- /system-health, calibration audits, false-negative debugging).

CREATE TABLE IF NOT EXISTS dropped_headlines (
  id                          TEXT PRIMARY KEY,
  headline_text               TEXT NOT NULL,
  classified_subtype          TEXT,
  classified_asset            TEXT,
  significance_score          REAL NOT NULL,
  significance_components     TEXT NOT NULL,         -- JSON: {magnitude, instance_strength, novelty}
  significance_reasoning      TEXT,
  dropped_at                  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_dropped_at ON dropped_headlines(dropped_at DESC);

-- ── 17. Strict conflict suppression (Phase D — invariant I-42) ───────────
-- When a same-asset opposite-direction signal arrives that overlaps the
-- pending window of an existing signal AND both meet relevance/threshold
-- criteria, the lower-significance one is suppressed at emission. The
-- losing signal is preserved here in full JSON form for audit.

CREATE TABLE IF NOT EXISTS suppressed_signals (
  id                          TEXT PRIMARY KEY,
  suppressed_signal_data      TEXT NOT NULL,         -- full pre-save JSON
  reason                      TEXT NOT NULL,
  conflicting_signal_id       TEXT NOT NULL,
  significance_loser          REAL NOT NULL,
  significance_winner         REAL NOT NULL,
  suppressed_at               INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_suppressed_at ON suppressed_signals(suppressed_at DESC);
CREATE INDEX IF NOT EXISTS idx_suppressed_conflict ON suppressed_signals(conflicting_signal_id);

-- ── 18. Live supersession (Phase E — invariant I-43) ─────────────────────
-- A standing pending signal can be superseded by a NEW signal on the
-- same asset in the opposite direction if the new significance is
-- ≥ 1.5× the standing one and horizons overlap ≥ 50%. The standing
-- signal's status flips pending → superseded; partial outcome computed
-- to the supersession timestamp.

CREATE TABLE IF NOT EXISTS signal_supersessions (
  id                          TEXT PRIMARY KEY,
  superseded_signal_id        TEXT NOT NULL REFERENCES signals(id),
  superseding_signal_id       TEXT NOT NULL REFERENCES signals(id),
  significance_ratio          REAL NOT NULL,
  reason                      TEXT NOT NULL,
  superseded_at               INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_supersess_old ON signal_supersessions(superseded_signal_id);
CREATE INDEX IF NOT EXISTS idx_supersess_new ON signal_supersessions(superseding_signal_id);

-- ── 19. Pre-classification corpus gate (Phase G — invariant I-46) ────────
-- Headlines that score below the corpus-similarity threshold are dropped
-- BEFORE the Claude classifier ever sees them. They never become
-- classifications, never reach signal generation, and never burn tokens.
-- This table is the forensic ledger — every drop records its score, top
-- corpus match, and detected asset classes so audits can spot-check
-- whether the threshold is calibrated correctly.

CREATE TABLE IF NOT EXISTS skipped_pre_classify (
  id                          TEXT PRIMARY KEY,         -- event_id
  headline_text               TEXT NOT NULL,
  corpus_score                REAL NOT NULL,
  max_cosine                  REAL NOT NULL,
  top_match_event_id          TEXT,                     -- corpus event id
  asset_classes_detected      TEXT NOT NULL,            -- JSON array
  asset_class_in_corpus       INTEGER NOT NULL,         -- 0/1
  reasoning                   TEXT NOT NULL,
  skipped_at                  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_skipped_pre_classify_at
  ON skipped_pre_classify(skipped_at DESC);

-- ── 20. Schema version (manual migrations) ────────────────────────────────

CREATE TABLE IF NOT EXISTS schema_version (
  version  INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
INSERT OR IGNORE INTO schema_version (version) VALUES (1);
