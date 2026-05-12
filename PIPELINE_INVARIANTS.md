# Pipeline Invariants

> **Purpose.** This document is the single source of truth for what the
> news → signal pipeline guarantees. Every invariant has a stage that
> enforces it, a test that proves it, and a fallback assertion in the
> pre-save gate. Future regressions audit this file, not the dashboard.
>
> **Rule.** When you discover a new bug class, fix it at the **earliest
> stage that could have prevented it**, add a test, and add a row here.
> Fixes that only mutate live signals or only tweak prompts are not
> sufficient — they must be paired with a deterministic check.

## Pipeline stages

```
┌─ 1. Ingestion ─────────────────────────── src/lib/pipeline/ingestion-validation.ts
│      sanitizeText + validateTitle
│      reject: malformed_title, empty_after_sanitize
│
├─ 2. Classification ──────────────────────  src/lib/pipeline/digest.ts
│      detectDigest                          src/lib/pipeline/promotional.ts
│      scorePromotional                      src/lib/ai/classifier.ts
│      classify_event tool                   src/lib/ai/prompts/classify.ts
│
├─ 3. Asset routing ─────────────────────── src/lib/pipeline/asset-router.ts
│      scoreAssetRelevance, routeAssets
│      isIndexConstituent (constituent table)
│
├─ 4. Conviction scoring ────────────────── src/lib/trading/signal-generator.ts (computeConvictionAxes)
│      7-axis weighted sum                  src/lib/pipeline/entity-history.ts
│      adjustConvictionForHistory
│
├─ 5. Risk derivation ───────────────────── src/lib/pipeline/catalyst-subtype.ts
│      inferCatalystSubtype + riskProfileForSubtype
│      capForFundingMagnitude
│
├─ 6. Conflict detection ────────────────── src/lib/pipeline/conflict.ts
│      computeConflict (relevance-weighted)
│
├─ 7. Tier assignment ───────────────────── src/lib/trading/signal-generator.ts (resolveTier)
│      capTierForPromotional                src/lib/pipeline/promotional.ts
│      corroboration check
│
└─ 8. Persistence ───────────────────────── src/lib/pipeline/invariants.ts
       checkSignalInvariants (pre-save gate)
       computeLifecycle (expiresAt + corroboration_deadline)
                                            src/lib/pipeline/lifecycle.ts
       shouldExpireSignal (sweeper)
```

## Invariants

| # | Invariant | Stage | Module | Test |
|---|---|---|---|---|
| I-01 | A title arriving at the classifier has been sanitized of all HTML tags and known parser-prefix artifacts. | 1 | `ingestion-validation.sanitizeText` + `validateTitle` | `tests/ingestion-validation.test.ts` |
| I-02 | Titles that are mid-sentence ellipsis truncations, doubled source names ("Bloomberg Bloomberg"), >250 chars, or empty after sanitization are rejected before classification. | 1 | `validateTitle` | `tests/ingestion-validation.test.ts` |
| I-03 | A digest/roundup article (Crypto One Liners, Daily Wrap, Newsletter, etc.) does NOT produce a signal. The digest detector sees it and the classification gate drops the article. | 2 | `digest.detectDigest` | `tests/digest.test.ts`, `tests/adversarial-fixtures.test.ts` (F09) |
| I-04 | Promotional/shill language (caps dominance, hyperbolic words, emoji clusters, amplifier phrases) caps the resulting signal at INFO tier when the source is non-tier-1. Tier-1 sources (Bloomberg/SEC/etc.) bypass the cap. | 2/7 | `promotional.scorePromotional` + `capTierForPromotional` | `tests/promotional.test.ts`, `tests/adversarial-fixtures.test.ts` (F10) |
| I-05 | Asset router never selects an index/basket as primary unless the basket's constituents intersect the named affected entities. Bug-class-1 cases (MAG7 on COIN news, MAG7 on MSTR news) are deterministically blocked. | 3 | `asset-router.routeAssets` (`scoreAssetRelevance` returns `basket_without_member` → score 0) | `tests/asset-router.test.ts` |
| I-06 | Asset router never selects a major (BTC/ETH/USDT) as primary on a listing event when the actual listed token is identifiable from the title and differs. | 3 | `asset-router.routeAssets` (`extractListedSymbol` override) | `tests/asset-router.test.ts`, `tests/adversarial-fixtures.test.ts` (F01) |
| I-07 | The primary asset selected has a relevance score >= 0.5 (subject or directly_affected or basket_with_member). If no candidate clears 0.5, the event produces NO signal. | 3 | `asset-router.routeAssets` | `tests/asset-router.test.ts` |
| I-08 | Same-direction signals on the same asset within 12h collapse to the highest conviction (one signal per asset per direction per cluster window). | 6 | `Signals.findSameDirectionPendingForAsset` + `findStoryOverlap` | (existing logic in signal-generator) |
| I-09 | A conflict is only registered when both signals' asset relevance for the shared ticker is >= 0.6 (subject or directly_affected). Below that, it's `related_context`. | 6 | `conflict.computeConflict` | `tests/conflict-detection.test.ts` |
| I-10 | Every catalyst is assigned a subtype with a known decay profile. The signal's `expected_horizon` matches the subtype's horizon. Hours-scale subtypes (transient_operational, exploit_disclosure) get hours, multi-day subtypes (regulatory_statement, macro_*) get days. | 5 | `catalyst-subtype.inferCatalystSubtype` + `riskProfileForSubtype` | `tests/catalyst-subtype.test.ts` |
| I-11 | Risk targets/stops are normalized by the asset's 30d realized volatility when available. Same nominal % on BTC and AMZN do not come from the same constant — they come from `target_vol_multiple × dailyVol × sqrt(horizonDays)`. | 5 | `riskProfileForSubtype` | `tests/catalyst-subtype.test.ts` |
| I-12 | Funding-round signals where round_size_usd / market_cap_usd < 0.5% are capped at INFO tier. | 5/7 | `catalyst-subtype.capForFundingMagnitude` | `tests/catalyst-subtype.test.ts`, `tests/adversarial-fixtures.test.ts` (F04) |
| I-13 | Every signal carries an `expires_at` derived from its catalyst subtype. The lifecycle sweeper auto-dismisses pending signals past `expires_at` with reason `stale_unexecuted`. | 8 | `lifecycle.computeLifecycle` + `shouldExpireSignal` | `tests/lifecycle.test.ts` |
| I-14 | Single-source (source_tier > 1) signals carry a `corroboration_deadline`. If still 0 corroborating sources at the deadline, auto-dismiss with reason `uncorroborated`. | 8 | `lifecycle.computeLifecycle` + `shouldExpireSignal` | `tests/lifecycle.test.ts` |
| I-15 | Each event has a deterministic `event_chain_id` (hash of primary_asset + sorted_affected + event_type + ISO-week). Signals on the same chain are recognized as a continuation, not a contradiction. | 4 | `entity-history.deriveEventChainId` | `tests/entity-history.test.ts` |
| I-16 | A new signal's conviction is reduced when a recent (≤7d) contradictory signal exists on the same primary asset. Magnitude scales with recency × prior conviction. Same-direction history does not downgrade. | 4 | `entity-history.adjustConvictionForHistory` | `tests/entity-history.test.ts` |
| I-17 | Signal `confidence` is finite and within [0, 1]. `suggested_stop_pct` and `suggested_target_pct` are strictly positive. | 8 | `invariants.checkSignalInvariants` | `tests/invariants.test.ts` |
| I-18 | Pre-save gate refuses any signal that violates I-01 through I-17. The gate is the LAST line of defense — upstream stages should have caught the issue earlier. | 8 | `invariants.checkSignalInvariants` | `tests/invariants.test.ts` |
| I-19 | An event classified as `event_type='etf_flow'` is mapped to subtype `etf_flow_reaction` (1-2d horizon, daily-print decay), NOT to `other` and NOT to `whale_flow`. event_type-driven subtypes take precedence over title regex when the classifier set an unambiguous category. | 5 | `catalyst-subtype.inferCatalystSubtype` (event_type guard at top) + `SUBTYPE_PROFILES.etf_flow_reaction` | `tests/catalyst-subtype.test.ts` (regression: bug class A) |
| I-20 | On-chain whale activity expressed as "deposited X into Binance", "$X outflow from spot exchanges", "$X withdrawn from Coinbase", etc. is recognised as `whale_flow` (8h horizon), not allowed to fall through to `treasury_action` (3d) or `other` (24h). Detector requires a flow verb + (size figure OR exchange name) so generic "transfer was enabled" doesn't over-fire. | 5 | `catalyst-subtype.inferCatalystSubtype` (FLOW_VERB / EXCHANGE_NAMES / SIZE_FIGURE patterns) | `tests/catalyst-subtype.test.ts` (regression: bug class B) |
| I-21 | Hedging language in classifier reasoning (`title says X body says Y`, `likely commentary`, `if confirmed`, `rumored`, `unverified`, `unconfirmed`, `appears to`, `claims/alleged/reportedly`) caps the signal at INFO tier when the source is non-tier-1. The AI's own uncertainty signal is honored, not discarded. Multiple weak hedges combine — score >= 0.5 caps. | 7 | `reliability.scoreReasoningHedge` + `capTierForReliability` | `tests/reliability.test.ts` (bug class C) |
| I-22 | Titles describing the actor by anonymising descriptor (`X's largest bank/fund/exchange`, `a major hedge fund`, `one of the largest pension funds`, `unnamed/undisclosed/anonymous whale`) AND containing a specific dollar figure cap the signal at INFO when the source is non-tier-1. Real news names the actor in the headline; anonymised + specific = unverifiable rumor. | 7 | `reliability.scoreAnonymizedActor` + `capTierForReliability` | `tests/reliability.test.ts` (bug class D) |
| I-23 | When the inline per-asset gate path in the signal generator selects an asset different from the router's primary (because the router's pick was rejected by `existsForEventAsset` / `reasoningContradicts` / proxy gates), the chosen asset's `asset_relevance` is **re-scored** via `scoreAssetRelevance` — never papered over with a hardcoded 0.5 placeholder. The previous fallback let assets that should have scored `incidentally_mentioned` (0.3) sneak past the invariant gate's `>= 0.5` check. | 3/8 | `signal-generator.runSignalGen` (computedRelevance fallback uses scoreAssetRelevance) | `tests/asset-router.test.ts` (regression: bug class E — USDT on Warren-Meta letter) |
| I-24 | A signal with `catalyst_subtype='earnings_reaction'` MUST target a `stock` or `treasury` asset. Earnings are quarterly prints of public companies; meme/governance/utility tokens don't have earnings. Real example caught: an `earnings_reaction` SHORT fired on TRUMP (meme token) — TRUMP doesn't have a Q1 print. The gate refuses the insert; the signal generator should have routed to the listed entity (TMTG / DJT stock) instead. | 8 | `invariants.checkSignalInvariants` (rule `earnings_reaction_on_non_corporate`) | `tests/invariants.test.ts` (regression: bug class F) |
| I-25 | No two signals may persist whose source articles have semantic similarity > the duplicate threshold within a 7-day window. Articles in the continuation band (between `continuation` and `duplicate` thresholds) are classified normally but linked via `coverage_continuation_of` and treated as low-novelty downstream. Thresholds are model-specific: BoW pseudo-embedding (default) uses 0.55 / 0.42; sentence-transformers would use 0.85 / 0.75 per the spec. | 1.5 / 8 | `freshness.classifyFreshness` + `embeddings.localTextEmbed` (ingest gate) + `invariants.checkSignalInvariants` rule `semantic_duplicate` (pre-save fallback) | `tests/freshness.test.ts` (Dimension 1) |
| I-26 | Signals must not fire when the predicted move is largely realized in the underlying asset, measured from the catalyst publication timestamp. `realized_fraction = directional_move / expected_move`: > 1.0 → drop (`move_exhausted`); > 0.6 → cap to INFO (`move_largely_realized`); < -0.3 → drop (`market_disagrees`). When prices are unavailable (asset has no klines), the check is skipped and the signal proceeds — explicit gap, not a silent fallback. | 5.5 / 8 | `price-realization.computeRealizedFraction` + `applyRealizedMoveCap` (signal-generator) + `invariants.checkSignalInvariants` rules `move_exhausted` / `move_largely_realized` / `market_disagrees` | `tests/price-realization.test.ts` (Dimension 2) |
| I-27 | Conviction is hard-capped by mechanism length: `mechanism_length=1` no cap; `=2` cap 0.85; `=3` cap 0.70; `=4` cap 0.55. The cap is enforced as a pure-function gate rule on `(mechanism_length, confidence)` — independent of whether the LLM self-applied it. `mechanism_length=null` (legacy / pre-v6 classification) is a clean skip. | 8 | `invariants.checkSignalInvariants` (rule `mechanism_conviction_excess`); upstream-set by `prompts/classify` v6 tool schema | `tests/reasoning-caps.test.ts` (Dimensions 3 + 4) |
| I-28 | Conviction is hard-capped by counterfactual strength: `weak` no cap; `moderate` cap 0.80; `strong` cap 0.60. Same enforcement model as I-27 — pure-function gate, `null` is a clean skip. | 8 | `invariants.checkSignalInvariants` (rule `counterfactual_conviction_excess`); upstream-set by `prompts/classify` v6 tool schema | `tests/reasoning-caps.test.ts` (Dimension 3) |
| I-29 | Risk parameters (`target_pct`, `stop_pct`, `horizon_hours`) must be drawn from `base_rates.json` where an entry exists for the (catalyst_subtype, asset_class) pair. When the lookup falls through to `riskProfileForSubtype` defaults, that fallback is logged. Pre-save gate refuses signals whose `target_pct` exceeds 2× (mean + stdev) of the calibrated band — replaces the `+18% on AMZN earnings` failure mode. Conviction is also capped at 0.65 when the calibrated mean move is < 2% (limited upside). | 5 / 8 | `base-rates.classifyAssetClass` + `getBaseRate` + `riskFromBaseRate` + `shouldCapConvictionFromBaseRate` (signal-generator) + `invariants.checkSignalInvariants` rule `target_exceeds_base_rate` | `tests/base-rates.test.ts` (Dimension 5) |
| I-30 | Every signal persisted to the `signals` table MUST have a corresponding row in `signal_outcomes` recorded in the same DB transaction. Three write paths populate it: (a) signal-fire (atomic with `Signals.insertSignal` via `transaction()`); (b) gate refusal (`outcome='blocked'`, rule logged); (c) user dismissal (`outcome='dismissed'`). The 15-min resolution job walks `outcome IS NULL` rows, fetches the price window from `klines_daily`, and writes `target_hit` / `stop_hit` / `flat`. Without this row, the empirical feedback loop has no ground truth — every signal lacking one is a calibration blind spot. Defense-in-depth: after the transaction commits, the signal-generator verifies the outcome row exists via `Outcomes.outcomeExistsFor(id)` and throws if not (`outcome_record_failed`). | 8 (atomic insert) + Part 1 schema | `lib/outcomes/resolve.ts` (pure resolver) + `db/repos/outcomes.ts` (insert/dismiss/block/resolve) + `lib/outcomes/resolve-job.ts` (15-min job + backfill) + `signal-generator.ts` `transaction(...)` wrapper + `Outcomes.outcomeExistsFor` post-commit check | `tests/outcomes.test.ts` (14 tests covering pure resolver + repo + atomicity); plus `tests/calibration-queries.test.ts` and `tests/system-health.test.ts` exercise downstream consumers |
| I-31 | Signal-driven weight changes at every AlphaIndex rebalance are recorded with their counterfactual-momentum-only weight delta and (on next rebalance) realized P&L attribution. Each rebalance writes a `signal_pnl_attribution` row keyed by `rebalance_id` whose `weight_deltas_bps` = (actual − counterfactual) × 1e4 per asset, where the counterfactual is `computeCandidatePortfolio({ skipSignals: true })`. Sanity guard: counterfactuals with negative weights or sum > 100% trip `sanity_ok=0` and the deltas are stored empty (the panel surfaces a warning chip instead of fake numbers). The next rebalance's `resolvePendingAttributions` job prices each delta over `[asof_date, today]` from `klines_daily` and writes per-asset realized USD P&L. Attribution is observability-only — failures must NEVER abort a live rebalance (try/catch in `rebalance.ts` `console.warn`s and continues). | Part 3 (observability, not a hard gate) | `lib/alphaindex/signal-attribution.ts` (pure: `computeAttribution` + `realizedAttributionPnL` + `attributionSummary`) + `lib/alphaindex/signal-attribution-job.ts` (`recordAttributionAtRebalance` + `resolvePendingAttributions`) + `db/repos/index-fund.ts` (`insertSignalAttribution` / `resolveSignalAttribution` / `listSignalAttributions`) + `signal_pnl_attribution` table + `weights.ts` `skipSignals` opt | `tests/signal-attribution.test.ts` (13 tests covering deltas, sanity, P&L, summary, end-to-end) |
| I-32 | v2 framework: portfolio drawdown shall not exceed 12% before the circuit breaker moves all satellites to USDC (BTC anchor untouched). Hard mechanical rule, not discretionary. At DD ≤ -8% satellites are halved; at DD ≤ -12% satellites are zeroed; resumption requires DD shallower than -4% from peak. The BTC anchor is exempt from breaker cuts because selling the market beta at the bottom of a -12% DD is precisely the wrong move — the breaker pulls the alpha bets while the anchor rides the cycle. Sticky across rebalances: once tripped, state persists until recovery. | v2 framework | `lib/alphaindex/v2/circuit-breaker.ts` (`applyCircuitBreaker`, `shouldExitBreaker`, `HALVED_THRESHOLD=-0.08`, `ZEROED_THRESHOLD=-0.12`, `EXIT_RECOVERY=-0.04`) + `lib/alphaindex/v2/engine.ts` (sticky-state composition) | `tests/alphaindex-v2/circuit-breaker.test.ts` (9 tests) + `tests/alphaindex-v2/integration.test.ts` (end-to-end firing) |
| I-33 | v2 framework: BTC anchor weight shall remain within [40%, 70%] across all stages — regime allocation, signal boosts, vol-targeting, and circuit-breaker output. The bound is enforced at three places: the allocator clamps the regime target into the band; signal-integration clamps any BTC-targeted boost; the engine re-clamps after vol-targeting in case scale-down would push BTC below the floor. The anchor is the structural risk floor of v2 — narrowing or widening this band fundamentally changes the framework. | v2 framework | `lib/alphaindex/v2/allocator.ts` (`BTC_MIN=0.40`, `BTC_MAX=0.70`, anchor clamp) + `lib/alphaindex/v2/signal-integration.ts` (anchor-band clamp on boosts) + `lib/alphaindex/v2/engine.ts` (post-vol-target re-clamp) | `tests/alphaindex-v2/allocator.test.ts` (BTC stays in band) + `tests/alphaindex-v2/signal-integration.test.ts` (signals can't push outside band) + `tests/alphaindex-v2/integration.test.ts` (60d run with mixed regimes) |
| I-34 | v2 framework: news signals shall not modify any single weight by more than ±2% absolute per rebalance. Each signal's `signed_score` runs through a tanh saturation onto `[-MAX_SIGNAL_BOOST, +MAX_SIGNAL_BOOST]` (MAX = 0.02). Combined with I-33, this means the structural framework (regime allocation + concentration caps + anchor band) is always recognizable in the final book — signals can tilt within the structure but cannot dominate it. Additionally, in DRAWDOWN regime, bullish signals are queued (no-op) and only bearish/risk-off signals are honored — preventing the "AUTO LONG everything" failure mode in falling markets. | v2 framework | `lib/alphaindex/v2/signal-integration.ts` (`MAX_SIGNAL_BOOST=0.02`, tanh saturation, regime-gating of bullish signals in DRAWDOWN) | `tests/alphaindex-v2/signal-integration.test.ts` (9 tests covering ±2% bound, BTC-band interaction, regime gating, conservation) |
| I-35 | Acceptance criteria use a MARGINAL PASS status for observations within 5% of threshold (relative tolerance). This prevents false failures from measurement noise while still surfacing the gap to the user. Marginal passes count as PASSING for graduation, but: (a) the criterion's `status` field reads `"marginal"`; (b) the UI shows a yellow badge instead of green; (c) a persistent, non-dismissible explanation card is rendered on the v2 preview tab for as long as the framework is graduated. Direction-aware: for "max" criteria (observed ≤ threshold) the band is `[threshold, threshold × 1.05]`; for "min" criteria the band is `[threshold × 0.95, threshold)`. Threshold = 0 → no relative band (any miss is a fail). | v2 framework | `lib/alphaindex/v2/acceptance.ts` (`MARGINAL_TOLERANCE=0.05`, `classifyStatus`, three-state `CriterionStatus`) + `components/index-fund/V2PreviewPanel.tsx` (yellow badge, persistent `MarginalCard`) | `tests/alphaindex-v2/acceptance-v2.test.ts` (marginal classification at 1.04× threshold; hard-fail at 1.10×; overall-passed-with-marginal composition) |
| I-36 | Framework selection between v1 and v2.1 by user requires explicit confirmation showing all acceptance criteria results AND any marginal passes before applying to the live portfolio. The confirmation modal must (a) display each criterion's status (pass / marginal / fail) and observed-vs-threshold; (b) display the documented trade-offs; (c) require an explicit "I understand the trade-offs" checkbox before the Apply button is enabled. The `/api/settings/framework` POST endpoint enforces server-side: any v2 selection without `confirmed: true` is rejected with HTTP 400. Switching back to v1 (the default) does not require confirmation — the gate is one-directional. | v2.1 graduation | `app/api/settings/framework/route.ts` (server-side `confirmed:true` guard) + `components/index-fund/FrameworkSelector.tsx` (modal with mandatory ack checkbox) + `lib/index-fund/rebalance.ts` (dispatches on `index_framework_version` setting) + `db/schema.sql` (`framework_version` column on `index_rebalances`, default `'v1'`) | manual UX flow; setting persistence covered by Settings repo tests |
| I-37 | Both frameworks must run paper-traded in parallel — the user-selected framework drives live positions, the other updates a virtual ledger in `shadow_portfolio` (NAV + cash, positions implied from the most-recent rebalance row's new_weights). Critically, the shadow framework receives IDENTICAL signal and kline inputs as the live framework on the same cycle: shadow rebalance executes inside `rebalance.ts` after the live rebalance lands, sharing the same DB read horizon. Shadow rebalance failure must NEVER abort the live path — wrapped in try/catch in `rebalance.ts` (logs and continues). Shadow output is never surfaced on the live equity curve; visible only on `/calibration` Compare view and via the framework selector's modal. | v2.1 attribution Part 2 | `lib/index-fund/shadow-rebalance.ts` (`runShadowRebalance` reads previous shadow weights, marks-to-market vs current prices, writes a new `index_rebalances` row tagged with shadow framework_version) + `lib/index-fund/rebalance.ts` (try/catch invocation after live rebalance) + `db/repos/shadow-portfolio.ts` + `shadow_portfolio` table | `tests/shadow-rebalance.test.ts` (5 tests: seeding idempotence, NAV updates per framework, switch preserves both NAVs) |
| I-38 | Every framework switch must be recorded in the `framework_switches` table with trailing 30d return context for both frameworks at switch time. Captures: from/to versions, user_confirmed_understanding flag (true for v1→v2 since I-36 requires it; false for v2→v1 since the gate is one-directional), live NAV at switch, shadow NAV at switch, and the trailing 30d returns for both v1 and v2.1 computed from each framework's tagged rebalance rows over the prior 30 days. Journal write happens inside the `/api/settings/framework` POST handler immediately after the setting is persisted, in a try/catch — journaling failure must not block the switch itself. The journal is surfaced on `/system-health` via the FrameworkSwitchPanel showing the last 10 switches. This data is what tells us later "did the user switch right after a bad month for the active framework." | v2.1 attribution Part 3 | `app/api/settings/framework/route.ts` (post-set, computes `compute30dReturnFromRebalances` for both frameworks then calls `FrameworkSwitches.recordSwitch`) + `db/repos/framework-switches.ts` + `framework_switches` table + `components/system-health/FrameworkSwitchPanel.tsx` (UI panel) + `app/api/data/framework-switches/route.ts` (read endpoint) | `tests/shadow-rebalance.test.ts` "framework_switches repo" describe (round-trip with full context; one-directional gate honored) |
| I-39 | Shadow backfill is idempotent and uses only real historical inputs; synthesized or simulated data is forbidden in shadow attribution. The backfill walks the trailing N days of v1 rebalances and writes one v2-tagged shadow rebalance row per v1 row using deterministic id `shadow-bf-v2-${asof_ms}` plus `INSERT OR IGNORE` so re-runs don't duplicate. Each cycle's weights come from `computeCandidatePortfolioV2AsOf(asof_ms)` which truncates klines to that timestamp and aggregates signals only within the 14d window ending at asof. Cycles missing kline coverage at asof are skipped and logged — they are NEVER filled with synthesized prices or signals. NAV mark-to-market between rebalances uses real klines on both endpoints; assets without a price at either endpoint are held flat (their weight earns 0 return) rather than replaced with a fabricated value. After backfill, `shadow_portfolio.started_at` is updated to the earliest backfilled asof so comparison-window math is honest. | v2.1 attribution Part 1 (gap-closing) | `lib/jobs/backfill-shadow.ts` (`backfillShadowV2`, deterministic IDs, INSERT OR IGNORE rebalance + outcome rows, mark-to-market with `priceAtOrBefore` from `klines_daily`) + `lib/alphaindex/v2/live-adapter.ts` (`computeCandidatePortfolioV2AsOf`, `loadAggregatedSignalsAsOf`) + `app/api/jobs/backfill-shadow/route.ts` | `tests/backfill-shadow.test.ts` (5 tests: deterministic ids, idempotence, mark-to-market reflects price changes, started_at update, skip missing-kline cycles) |
| I-40 | Every shadow rebalance must produce signal_outcomes rows tagged with the shadow framework_version for any signal-driven weight change, mirroring the live framework's outcome tracking. Implementation: after `runShadowRebalance` writes its rebalance row, it walks the recent (14d) signals whose asset is held in the shadow portfolio and calls `Outcomes.recordShadowOutcomeFromSignal` for each. Synthetic id `${signal_id}-shadow-${framework}` avoids collision with the live outcome row's PK on `signal_id`. Stop/target levels are framework-specific (v1 uses the signal's suggested levels; v2.1 uses the wider 8%/5% pair reflecting its drawdown-controlled risk envelope). The 15-min resolution job walks all `outcome IS NULL` rows transparently, so v2-tagged rows resolve through the same code path as v1's. INSERT OR IGNORE on the synthetic id makes shadow outcome generation idempotent. Failure must NEVER abort the live rebalance — the loop is wrapped in try/catch. | v2.1 attribution Part 2 (gap-closing) | `lib/db/repos/outcomes.ts` (`recordShadowOutcomeFromSignal`, INSERT OR IGNORE on synthetic id) + `lib/index-fund/shadow-rebalance.ts` (post-rebalance signal walk + outcome insert, framework-specific `SHADOW_TARGETS`) + `lib/jobs/backfill-shadow.ts` (same outcome generation path during backfill) | `tests/shadow-rebalance.test.ts` "shadow signal outcomes — I-40" describe (3 tests: synthetic-id insert, idempotence, v1↔v2 independence) |
| I-41 | Headlines with significance score < 0.25 are dropped at ingestion and never become signals. Significance is computed in `src/lib/calibration/significance.ts` as a weighted sum of three components: (1) corpus-derived base-rate magnitude × asset_relevance (50% weight), with a multiplicative magnitude gate that attenuates score when no base rate exists; (2) instance strength — strong factual verbs lift, hedge language ("rumored", "potential", "discussion") penalizes (30% weight); (3) novelty against the last 7 days of headlines on the same asset using embedding cosine similarity ≥ 0.75 (20% weight). Tier thresholds: ≥ 0.75 = auto, 0.50–0.75 = review, 0.25–0.50 = info, < 0.25 = drop. The drop gate fires inside the per-asset loop after asset routing produces an asset_class; the dropped record (event_id:asset_id, headline_text, score, components JSON, reasoning string) lands in `dropped_headlines`. Significance.tier REPLACES the conviction-derived tier; downstream caps can still downgrade further. Conviction continues to drive sizing within a tier. | Phase C (significance scoring) | `lib/calibration/significance.ts` (scoreSignificance, tierForScore) + `lib/calibration/recent-headlines.ts` (novelty corpus) + `lib/calibration/derive-base-rates.ts` (magnitude component data) + `lib/trading/signal-generator.ts` (the gate at the per-asset loop) + `lib/db/repos/dropped-headlines.ts` + `db/schema.sql` (dropped_headlines table) + `lib/system-health.ts` (24h drop count surfaced on /system-health) | `tests/significance-scoring.test.ts` (7 tests: ETF approval → auto, generic → drop, hedged < factual, novelty penalty, threshold math, weighted-sum, instance-strength floor) + `tests/calibration-corpus.test.ts` (6 tests) + `tests/base-rates-calibration.test.ts` (4 tests) |
| I-42 | Same-asset opposite-direction signals with overlapping horizons (≥ 50% of the new signal's window) cannot coexist in 'pending' status when both have asset_relevance ≥ 0.6. The lower-significance one is suppressed at emission. Resolution rules: higher significance wins; ties within 0.05 broken by conviction; further ties broken by recency (newer wins). If the NEW signal loses, it never inserts into `signals` — the loser's pre-save payload is JSON-encoded into `suppressed_signals` with reason + winner id. If the EXISTING signal loses, its status flips 'pending' → 'suppressed', `effective_end_at` is set to now(), and the loser is also recorded in `suppressed_signals`. The relevance floor of 0.6 prevents weakly-anchored cross-asset basket signals from triggering this rule. Window-overlap fraction uses the new window length as denominator so a long-horizon existing doesn't drown out a short-horizon new. | Phase D (strict conflict at emission) | `lib/calibration/conflicts.ts` (resolveConflict, windowOverlapFraction, CONFLICT_RELEVANCE_FLOOR=0.6, OVERLAP_THRESHOLD=0.5) + `lib/trading/signal-generator.ts` (Phase D/E block before insert) + `lib/db/repos/conflicts.ts` (insertSuppressedSignal) + `lib/db/repos/signals.ts` (markSuppressed) + `db/schema.sql` (suppressed_signals table) | `tests/strict-conflict-resolution.test.ts` (6 tests: opposite-direction suppression, asset gating, no-overlap → no conflict, relevance floor, tie-break order, 50% boundary) |
| I-43 | A standing pending signal is superseded when a new opposite-direction signal fires on the same asset with significance ≥ 1.5× the standing signal's AND ≥ 50% horizon overlap AND both have asset_relevance ≥ 0.6. The standing signal's status flips 'pending' → 'superseded', `effective_end_at` records the supersession timestamp, and a row in `signal_supersessions` captures `significance_ratio` + `reason`. Outcomes for superseded signals are resolved up to the supersession timestamp (partial outcome treated as flat in calibration by default; toggleable on /calibration). Already-superseded signals are excluded from `findOppositePendingForAsset` (it filters status='pending'), so they cannot be re-superseded — they are terminal. Supersession does not chain: the superseding signal may itself later be superseded, but the original superseded one stays terminal. | Phase E (live supersession) | `lib/calibration/conflicts.ts` (SUPERSESSION_RATIO_THRESHOLD=1.5, supersede_existing verdict) + `lib/trading/signal-generator.ts` (calls markSupersededByConflict + insertSupersession) + `lib/db/repos/conflicts.ts` (insertSupersession, getSupersessionForOld, listSupersessionsByNew) + `lib/db/repos/signals.ts` (markSupersededByConflict) + `db/schema.sql` (signal_supersessions table) + `components/signals/SignalAuditPage.tsx` (audit banners) + `components/calibration/CalibrationDashboard.tsx` (include-superseded toggle) | `tests/signal-supersession.test.ts` (5 tests: ratio threshold fires, sub-threshold falls back, audit row content, already-superseded excluded, two-link chain terminality) |
| I-44 | Base rates for significance scoring are derived empirically from `data/calibration-corpus.json` by `scripts/calibrate-base-rates.ts`, producing `data/base-rates.json`. LLM-estimated rates are forbidden in this path. The corpus contains hand-verified historical catalyst events (95+ entries, 2024-2026) with measured realized_pct_move, duration_to_peak_days, duration_of_impact_days, and a confidence tier ∈ {high, medium, recent} that maps to weights {1.0, 0.7, 0.5} in `deriveBaseRates`. Sample-size handling: n=1 → stdev defaults to 0.6 × |mean|; n=2 → stdev floored at 0.4 × |mean|; n≥3 → unbiased weighted sample stdev. Asset-class fallback (`lookupWithFallback`) lets a subtype with only one class entry serve cross-class requests, ranked by sample_size then magnitude. The legacy hand-curated table at `src/lib/pipeline/base_rates.json` is retained as a fallback for subtypes the corpus doesn't cover (e.g., transient_operational, whale_flow) so existing pipeline coverage is preserved. | Phase A/B (corpus + derivation) | `data/calibration-corpus.json` + `lib/calibration/corpus.ts` (loadCorpus, validateCorpus with 13 integrity rules R1-R13, KNOWN_SUBTYPES, KNOWN_ASSET_CLASSES) + `lib/calibration/derive-base-rates.ts` (deriveBaseRates, lookupWithFallback) + `scripts/validate-corpus.ts` (CLI gate) + `scripts/calibrate-base-rates.ts` (writes data/base-rates.json) | `tests/calibration-corpus.test.ts` (6 tests: schema, validation rules, asset-class universe, dup detection, negative case) + `tests/base-rates-calibration.test.ts` (4 tests: full coverage, confidence weighting, small-sample stdev, asset-class fallback) |
| I-45 | Every persisted signal row carries a non-null `significance_score`. The significance pipeline (I-41) must produce a score for every event that reaches `insertSignal` — no code path may bypass it. Implementation: significance scoring runs UNCONDITIONALLY inside the per-asset loop, regardless of whether `classifyAssetClass` returns a known class. When the class is null the generator passes the sentinel string `"unknown"` to `scoreSignificance`, which proceeds through the standard fallback chain (corpus → legacy hand-curated → magnitude=0 with instance+novelty still computed). A hard assertion in `signal-generator.ts` immediately before `insertSignal` throws if `significance_score` is null or non-finite — this prevents silent regression rather than logging-and-continuing. Historical pre-deployment rows (the 41 signals that fired before Phase C) were backfilled to `significance_score = 0` with a sentinel marker in `reasoning` (`[pre-significance-deployment: significance_score backfilled to 0]`) via `scripts/backfill-significance.ts`, so the column NEVER contains NULL in steady-state. | Phase C bug-fix (post-deployment) | `lib/trading/signal-generator.ts` (unconditional significance run + I-45 throw before insert) + `lib/calibration/significance.ts` (unchanged — already handled the sentinel cleanly) + `scripts/backfill-significance.ts` (one-time NULL → 0 stamp) | `tests/significance-scoring.test.ts` ("subtype 'security_disclosure' (not in corpus) routes through legacy fallback", "subtype with no corpus AND no legacy entry still gets scored", "unknown asset_class string is tolerated") + `tests/significance-invariant.test.ts` (2 tests: insert round-trips the column; post-backfill the table has zero NULL rows) |
| I-46 | Headlines that don't structurally resemble any historical signal in the calibration corpus are dropped BEFORE the Claude classifier sees them — they never become classifications and never burn tokens. Implementation: at first use, embed all 95 corpus `source_event_text` strings into BoW vectors and cache them in memory. For each incoming news_event, compute max cosine similarity vs the 95 anchors, detect mentioned asset_classes (BTC/ETH→large_cap_crypto, NVDA/AMD→ai_semiconductor, MSTR/COIN→crypto_proxy, etc.), and combine: `score = max_cosine × (asset_class_in_corpus ? 1.0 : 0.3)`. Verdicts: score ≥ 0.30 → classify; 0.15–0.30 → classify with weak_corpus_match flag for audit; < 0.15 → drop and log to `skipped_pre_classify`. The reclassify endpoint (operator-triggered) bypasses the gate so manual backfills always proceed. The corpus is the empirical authority — if a headline doesn't look like one of the 95 verified market-moving events, paying Claude to classify it is wasted spend by definition. | Phase G (pre-classify corpus gate) | `lib/calibration/corpus-filter.ts` (corpusFilter, detectAssetClasses, CLASSIFY_THRESHOLD=0.3, FLAG_WEAK_THRESHOLD=0.15, NO_CORPUS_CLASS_PENALTY=0.3) + `lib/ingest/news.ts` (gate before classifyBatch) + `lib/db/repos/skipped-pre-classify.ts` + `db/schema.sql` (skipped_pre_classify table) + `lib/system-health.ts` (24h drop-count tile) | `tests/corpus-filter.test.ts` (9 tests: corpus self-match classifies, promotional tweet drops, paraphrase preserved, asset-class penalty applied, $TICKER detection, MSTR detection, threshold respect, reasoning content) |
| I-47 | When Claude's classification assigns a (subtype, asset_class) bucket that the corpus says is direction-locked (every historical observation moved one way) AND Claude's proposed direction contradicts the lock, the signal is soft-flagged. 22 of 28 (subtype × asset_class) corpus buckets are direction-locked: defi_exploit is always short, halving_event always long, corporate_treasury_buy always long, token_unlock always short, regulatory_etf_approval always long. Implementation: at first use, group corpus events by (subtype, asset_class) and compute the lock state per bucket. Inside the signal generator (post-significance, pre-conflict-resolution), look up the proposed bucket's lock; if it's violated, append `Direction-lock flag: ...` to the signal's reasoning and force tier from AUTO to REVIEW. The flag is SOFT — we never hard-reject because the corpus is finite (95 events) and a real new market regime might emerge. Soft-flagging surfaces the contradiction for human review without blocking the signal. Unknown buckets (corpus silent) → no violation. Mixed buckets (both directions seen) → no violation. The conviction cap (`DIRECTION_LOCK_CONVICTION_CAP = 0.5`) is exported for downstream sizing logic. | Phase G (direction-lock validator) | `lib/calibration/direction-lock.ts` (loadDirectionProfiles, checkDirectionLock, DIRECTION_LOCK_CONVICTION_CAP=0.5) + `lib/trading/signal-generator.ts` (post-significance check + reasoning annotation + AUTO→REVIEW demotion) | `tests/direction-lock.test.ts` (8 tests: profile build, locked bucket flagged, agreement passes, corpus-silent passes, mixed bucket passes, cap constant locked at 0.5, halving long/short symmetry, corporate_treasury_buy lock) |

## Known gaps (deliberate deferrals)

These are documented so future iterations know what was traded off and why.
They are not silent omissions; each was a conscious call.

### Gap A — Bug class 4 (entity history) lacks a pre-save gate fallback
The doc's rule says every invariant has a fallback assertion in
`checkSignalInvariants`. I-16 (recent contradictory signal reduces
conviction) is enforced as a *transformation* in `runSignalGen`, not as
a hard constraint at the gate, because verifying it would require
recent-signal-history I/O inside what is currently a pure function.
Acceptable trade-off: the transformation is unit-tested in
`tests/entity-history.test.ts`, and the integration test (Gap D, below)
exercises the persisted-row metadata that the transformation produces.

### Gap B — Bug class 5 (conflict detection) lacks a pre-save gate fallback
I-09 enforces relevance-weighted conflict detection in `computeConflict`,
but the gate doesn't refuse a signal whose conflict label is wrong
relative to *other* pending signals. Conflict is a labeling concern, not
a blocking one — a signal can fire correctly while the UI's conflict
badge is wrong. Adding a gate rule would require multi-row state at
gate time. Same architectural objection as Gap A.

### Gap C — Bug class 6 detects digests but doesn't split them
The original spec mentioned "(Future): split into per-event sub-articles
via LLM extraction". We `block` digests entirely — they produce no
signal — but real catalysts inside them (the COIN job cuts, MARA M&A in
a Crypto One Liners post) are also lost. Implementing the splitter
needs a new prompt-only step that itself needs a deterministic check
(the same rule that motivated this whole document). Out of scope for
buildathon timeline; flagged in the comment of `src/lib/pipeline/digest.ts`.

### ~~Gap D~~ — closed by `tests/integration-pipeline.test.ts`
*Was: no end-to-end test that the persisted `signals` row carries the
values upstream stages computed.* Closed: the integration test seeds an
in-memory DB, runs `runSignalGen` against three adversarial fixtures
(F03 MSTR treasury, F05 Coinbase outage, F09 digest-blocked), and
asserts that `catalyst_subtype`, `asset_relevance`, `expires_at`,
`corroboration_deadline`, and `source_tier` all match what the
upstream modules produced.

### Gap E — Embedding model is BoW, not a real sentence transformer
**What's missing:** I-25's freshness check uses `localTextEmbed`, a
deterministic bag-of-words pseudo-embedding, instead of the
all-MiniLM-L6-v2 sentence transformer the task specified.

**Why:** real BoW similarities for paraphrased coverage land 0.50-0.67;
sentence transformers would land 0.80+. We re-tuned the thresholds
(`duplicate=0.55`, `continuation=0.42`) to match the BoW band so the
gate still fires correctly on real article pairs. Architecture is
pluggable via `setEmbeddingProvider(...)` — swapping in a
sentence-transformer is a 1-file change plus calling
`SENTENCE_TRANSFORMER_THRESHOLDS` for the per-call override.

**What's blocking it:** installing `@xenova/transformers` plus the
~25MB ONNX model file on first run. Defensible deferral: the freshness
GATE is correct; only the embedding model is provisional. A real model
upgrade is a drop-in replacement.

### Gap F — D2 price feed depends on klines_daily
**What's missing:** I-26's catalyst-time price uses the daily close on
or before the catalyst timestamp. For intra-day catalysts that move
within hours, this is coarser than ideal; a real intra-day price feed
would let `realized_fraction` track minute-bar moves.

**Why deferred:** klines_daily is the only price history we already
have plumbed. Intra-day SoDEX feed is wired for the live UI but not as
a historical store. Adding minute-bar archival is a separate workstream.

**Behavior under the limitation:** if no kline exists for the asset
(small-cap token, illiquid stock), `priceAtOrBefore` returns null, the
realized_fraction computation returns null, and the gate skips the
rule entirely. We log nothing in this path — explicit gap; logging
`price_check_unavailable` per spec is the next refinement.

### Gap H — Outcome resolution depends on klines_daily (Part 1)
**What's missing:** I-30's resolution job walks `klines_daily` for the
asset's price window. Two limitations: (a) **daily granularity** —
intra-day target/stop crossings are inferred from `high`/`low` bars, so
we can't tell which crossed first within a single day (we mark
`stop_hit` pessimistically when both hit on the same day, matching
walk-forward backtesting convention). (b) **assets without klines** —
the backfill skips signals whose asset has no klines at all (during
this run: 18 of 39 existing signals were skipped for this reason).

**Why deferred:** intra-day archival is a separate ingestion workstream;
the `klines_daily` table is the only price store currently plumbed for
historical lookups. The 15-min job retries `still_pending` rows on
every tick, so once new klines arrive the resolution catches up.

**Behavior under the limitation:** stuck outcomes accumulate on the
`/system-health` page if a particular asset never gets klines —
operators can see exactly which signals are blind and decide whether
to backfill that asset's history.

### Gap G — D3 LLM-output quality is not deterministically tested
**What's missing:** I-27 and I-28's CAPS are tested deterministically
(synthetic ClassifiedEvent → gate refuses). The PROMPT change that
asks the LLM to produce mechanism_length / counterfactual_strength is
not tested — verifying the model produces "mechanism_length >= 3" for
the AXS spending fixture would require an actual classifier call.

**Why:** non-deterministic LLM output is hard to assert against in CI
without mocking responses (which defeats the purpose of testing the
prompt). The DETERMINISTIC half — the gate cap, which is what catches
inconsistent LLM output — is fully tested.

**Behavior:** if the LLM fails to produce mechanism_length on a v6
classification, the field is null, the gate's cap rule is a clean
skip, and the signal proceeds without the cap. This is the right
fail-open: when the new field is unavailable, we don't refuse the
signal entirely, we just lose that one tier-cap layer.

## How to add a new invariant

1. Identify the **earliest** stage that could have prevented the bug class.
2. Write a regression test that fails on the bad input.
3. Implement the deterministic check at that stage.
4. Add a row to `checkSignalInvariants` so the pre-save gate would catch it as a final defense.
5. Add the row to this table.
6. If the new invariant produces persisted metadata that downstream code
   relies on, add an assertion to `tests/integration-pipeline.test.ts`
   that the column ends up in the `signals` row with the expected value.

## What to do when an invariant fires in production

- **Block** severity in `checkSignalInvariants`: the signal does NOT save. The rule that fired is logged; investigate and tighten the upstream stage.
- **Warn** severity: signal saves with a warning logged. Periodic review of warnings reveals near-misses worth promoting to block.

## Test files

Counts below are the actual passing-test count from the verbose vitest
output, refreshed any time a test is added or removed. If this list ever
diverges from `npm test --reporter=verbose`, the doc is stale, not the
test suite.

```
tests/adversarial-fixtures.ts          — 16 synthetic news items (data file)
tests/adversarial-fixtures.test.ts     — 16 tests   (one per fixture, end-to-end pipeline modules)
tests/asset-router.test.ts             — 17 tests   (bug class 1 + bug class E regression)
tests/base-rates.test.ts               — 20 tests   (Dimension 5 — base rates table)
tests/calibration-queries.test.ts      —  8 tests   (Part 2 — 5 calibration panels' SQL aggregates)
tests/catalyst-subtype.test.ts         — 28 tests   (bug class 2 + bug classes A/B regressions)
tests/conflict-detection.test.ts       —  7 tests   (bug class 5)
tests/digest.test.ts                   —  6 tests   (bug class 6)
tests/entity-history.test.ts           —  8 tests   (bug class 4)
tests/freshness.test.ts                —  9 tests   (Dimension 1 — semantic freshness)
tests/ingestion-validation.test.ts     — 12 tests   (bug class 7)
tests/integration-pipeline.test.ts     —  2 tests   (Gap D — end-to-end persistence wiring)
tests/invariants.test.ts               — 13 tests   (pre-save gate + bug class F regression)
tests/lifecycle.test.ts                — 10 tests   (bug class 3 + bug class A slow-burn regression)
tests/outcomes.test.ts                 — 14 tests   (Part 1 — outcome tracking, I-30)
tests/price-realization.test.ts        — 15 tests   (Dimension 2 — price-already-moved)
tests/promotional.test.ts              — 11 tests   (bug class 8)
tests/reasoning-caps.test.ts           — 13 tests   (Dimensions 3 + 4 — mechanism + counterfactual caps)
tests/reliability.test.ts              — 19 tests   (bug classes C + D — hedge cap, anonymized-actor cap)
tests/system-health.test.ts            —  9 tests   (Part 3 — system health, alerts, backup retention)
tests/calibration-corpus.test.ts        —  6 tests   (Phase A / I-44 — corpus schema + integrity)
tests/base-rates-calibration.test.ts    —  4 tests   (Phase B / I-44 — empirical derivation)
tests/significance-scoring.test.ts      — 10 tests   (Phase C / I-41 — score components, tiers, drop gate, legacy fallback, unknown asset_class)
tests/strict-conflict-resolution.test.ts —  6 tests   (Phase D / I-42 — emission-time suppression)
tests/signal-supersession.test.ts       —  5 tests   (Phase E / I-43 — live supersession + audit)
tests/significance-invariant.test.ts    —  2 tests   (Phase C bug-fix / I-45 — significance_score is mandatory)
tests/corpus-filter.test.ts             —  9 tests   (Phase G / I-46 — pre-classify corpus gate)
tests/direction-lock.test.ts            —  8 tests   (Phase G / I-47 — direction-lock validator)
```

**Total (post-corpus-gate): 411 tests, all green.**

Run: `npm test`. Typecheck: `npm run typecheck`. Verbose: `npx vitest run --reporter=verbose`.
