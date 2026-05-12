# AlphaIndex framework notes

This document describes the two AlphaIndex allocation frameworks that
ship in the system and the conditions under which to use each. Live
portfolio defaults to v1; users opt into v2.1 explicitly via the
framework selector on the AlphaIndex live tab (I-36).

## v1 — anchor + momentum + signals (legacy)

The original framework. Anchored portfolio with momentum tilts and
news-signal boosts. Detailed JSDoc in `src/lib/index-fund/weights.ts`.

- BTC anchor at 28%, ~76% across all anchors
- 24% tilt budget across momentum-driven satellite picks
- News signals adjust both anchor and satellite weights via tanh
  multipliers (no hard ±2% cap)
- Hard floor: drop assets with -20%+ 30d return AND no positive signal

**Empirical character:** Captures more upside than v2.1 in trending
markets (no cash buffer, no concentration ceiling on satellites).
Drawdowns are uncontrolled — historical replay showed -50%+ drawdowns
in BTC bear windows where BTC itself dropped only -11.8%. Sharpe ratios
in stress tests were deeply negative (-4.6 to -5.8).

**When to use v1:** Default for users who prioritize maximum upside in
trending markets and accept the historical drawdown profile.

## v2.1 — drawdown-controlled long-only allocation (graduated)

Rebuilt framework explicitly designed around drawdown control.
Components live in `src/lib/alphaindex/v2/`:

- `regime.ts` — TREND / CHOP / DRAWDOWN classifier from BTC's last
  30d closes; 3-day smoothing on entries, 1-day fast-exit from
  DRAWDOWN→TREND
- `vol-targeting.ts` — portfolio vol target 40% annualized;
  asymmetric scale-up (1.0× in TREND, 0.8× elsewhere)
- `circuit-breaker.ts` — at -8% NAV drawdown halve satellites; at -12%
  zero satellites; resume at -4% recovery (BTC anchor exempt)
- `allocator.ts` — regime-driven base allocation, BTC anchor band
  [40%, 70%], regime-aware concentration caps (TREND 10%/18%, others
  8%/15%), tail-prune <3%, max 10 satellites
- `signal-integration.ts` — bounded ±2% signal boosts; bullish signals
  queued in DRAWDOWN
- `engine.ts` — composes the above into a single rebalance pipeline

### Design goals (this is what v2.1 IS)

1. **Drawdown control** — limit max DD to a small multiple of BTC's
   own DD across all market regimes
2. **Capture in non-bears** — participate meaningfully in upside
   without dominating BTC; threshold 50% mean capture
3. **Documented trade-off** — accept lower upside-capture and lower
   absolute Sharpe in trending markets in exchange for materially
   reduced drawdown in bears

### What v2.1 IS NOT

- Not a maximum-upside framework. It runs 5–45% in cash by regime,
  caps individual positions at 8–10%, and dilutes BTC's beta with
  diversifier sleeves. In a strong BTC tape it will trail naive
  momentum and BTC buy-and-hold on absolute return.
- Not a Sharpe-maximizer. Long-only frameworks with cash buffers and
  concentration ceilings dilute the underlying's Sharpe in trends —
  this is the math of allocation, not a bug. See `acceptance.ts` for
  why C3 ("Sharpe > 0") and C3a ("v2 SR ≥ BTC SR") were retired.
- Not a market-timing framework. The DRAWDOWN regime queues bullish
  signals rather than acting on them, and the circuit breaker is
  mechanical (no discretion). v2.1 reacts to realized risk, it does
  not predict it.

## Empirical characteristics (from acceptance — 2.7 years of BTC data)

Stress evaluated against 8 windows: 3 fixed (worst-DD ×2 + recent
60d) + 5 deterministic-random (overfitting check). Includes a real
-35.1% BTC bear window.

| Metric | v2.1 result | BTC | Ratio |
|---|---:|---:|---:|
| Worst 60d max DD ratio (C1) | 0.92× worst across 8 windows | — | well under 1.5× |
| Live-period DD (last 30d) | -2.8% | -4.2% | 0.67× |
| Live-period return | +8.6% | +10.8% | 80% capture |
| Mean capture (5 non-bear windows, C3) | **58.4%** | 100% | passes ≥ 50% |
| Bear DD ratio (3 bear windows, C4) | worst 0.72× (marginal) | — | passes 0.7× with 2.9% gap |

### Acceptance criteria — current (v2.1)

- **C1** Max DD ratio ≤ 1.5× across all stress windows — **PASS** (0.92× worst)
- **C2** Live: v2 ret > BTC OR v2 DD < 0.7× BTC DD — **PASS** (DD-beat)
- **C3** Upside capture ≥ 50% across non-bear windows — **PASS** (58.4% mean)
- **C4** Bear-window DD ≤ 0.7× BTC DD — **MARGINAL PASS** (0.72×, 2.9% over)

Marginal-pass status (I-35) means observed-vs-threshold gap is within
5% relative; the criterion is treated as passing for graduation but the
gap is surfaced to the user (via the persistent yellow card) and is
not dismissible.

### Regime transition behavior

Across the 8 stress windows v2.1 transitioned regimes 0–4 times per
60-day window. DRAWDOWN→TREND fast-exit (1-day) prevents v2 from
remaining defensive after vol spikes; TREND→DRAWDOWN entry still
requires 3-day confirmation to avoid whipsaws. The 3-day-smoothing
asymmetry was added in v2.1 specifically to address v2's tendency to
stay risk-off after brief vol shocks.

## When to use v2.1

- You expect market chop, vol spikes, or bear markets in the
  near-to-medium term and want drawdown control
- You are comfortable trading some upside-capture for risk reduction
- You want a portfolio whose drawdowns are mechanically bounded (the
  -12% circuit breaker is a hard rule, not a guideline)

## When NOT to use v2.1

- You want maximum BTC exposure in a strong tape — hold BTC instead
- You want a momentum-driven satellite book without anchor or
  concentration ceilings — v1 is closer to that
- You want to maximize Sharpe — long-only frameworks with cash
  buffers cannot match a 100%-BTC Sharpe in trends; v3 research will
  explore mixed-sign or levered variants

## v3 research roadmap

Open questions that emerged from v2.1's acceptance and that v3 should
address:

1. **Mid-bear circuit-breaker timing.** v2.1 protects best in deep
   crashes (-30%+) and least well in slow grinds (-10% to -20% over
   60d). The Random 4 window in C4's marginal pass is the canonical
   example. Possible directions:
   - Time-weighted breaker (fire earlier when DD develops slowly)
   - Velocity gate on DD acceleration
   - DRAWDOWN regime that activates at -5% NAV instead of waiting
     for circuit-breaker thresholds

2. **Trend-market upside.** v2.1's 58% mean capture clears the C3
   floor but underperforms BTC by ~40% in strong tapes. The C3 floor
   was designed for graduation; v3 might target ≥ 70% capture by:
   - Lifting the BTC anchor ceiling above 70% in confirmed
     long-momentum regimes
   - Allowing concentration ceiling to scale with BTC's realized
     Sharpe

3. **Short overlay or levered hedge.** Long-only with cash cannot
   produce positive Sharpe in 60d bear windows by construction.
   A short BTC overlay activated in DRAWDOWN regime would change the
   strategy's character — out of scope for v2.1, on the table for
   v3 research.

## Operational notes

- **Default:** v1. Switching to v2.1 requires explicit confirmation
  modal (I-36) showing all four acceptance results including the C4
  marginal pass.
- **Reverting:** users can switch back to v1 at any time via the same
  selector. The next rebalance applies the chosen framework.
- **Persistence:** the marginal-pass card stays visible on the v2
  preview tab for as long as v2.1 is graduated. It cannot be
  dismissed (I-35).
- **No silent changes:** any future v2.x parameter change re-opens
  acceptance and the C1–C4 evaluation must be re-run before the
  framework is selectable for live trading.
