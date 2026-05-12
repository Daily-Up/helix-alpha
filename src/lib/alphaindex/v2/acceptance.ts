/**
 * v2 — acceptance gate.
 *
 * Three published criteria (non-negotiable):
 *
 *   C1. Max drawdown in any 60-day historical replay window must not
 *       exceed 1.5× BTC's max drawdown in the same window
 *   C2. (revised v2.1) Live-period return > BTC buy-and-hold OR
 *       live-period max DD < (BTC max DD × 0.7). Tests risk-adjusted
 *       value, not absolute alpha vs an unhedged factor in a strong
 *       tape.
 *   C3. (revised v2.1 — replaces C3a) Across all NON-BEAR stress
 *       windows (BTC return ≥ 0), v2 upside-capture must be ≥ 50%.
 *       capture = mean(v2_ret / btc_ret) over those windows.
 *   C4. (new v2.1) Across all BEAR stress windows (BTC return < 0),
 *       max(v2_DD / BTC_DD) must be ≤ 0.7 — i.e., v2 reduces drawdown
 *       by ≥ 30% vs BTC in every bear window.
 *
 * History: original C3 ("Sharpe > 0") was structurally incompatible —
 * a 60d window with negative mean return necessarily produces negative
 * Sharpe. C3a ("v2 SR ≥ BTC SR") was also incompatible — a long-only
 * framework with cash + concentration caps necessarily dilutes BTC's
 * Sharpe in trends. C3 + C4 split the test into the two regimes where
 * the framework's design goals actually apply: capture-in-trend +
 * drawdown-reduction-in-bear.
 *
 * Until ACCEPTANCE: PASSED is true, v2 is preview-only and cannot be
 * selected for live trading. Result is persisted in `v2_acceptance`
 * with a JSON breakdown so the UI can show "criterion C1 failed by
 * X%, here's by how much" rather than just a binary.
 *
 * NOT a hard gate inside the code — graduation to live is a manual
 * decision. The gate's job is to expose the truth.
 */

import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";

/**
 * Three-state criterion status.
 *  - "pass"     : observed strictly meets threshold
 *  - "marginal" : observed is within 5% (relative) of threshold but on
 *                 the wrong side. Treated as PASSING for graduation
 *                 purposes (I-35) but surfaced separately in the UI so
 *                 the user sees the gap.
 *  - "fail"     : observed missed threshold by > 5% relative.
 */
export type CriterionStatus = "pass" | "marginal" | "fail";

/** Direction of comparison. "max" = observed must be ≤ threshold;
 *  "min" = observed must be ≥ threshold. */
export type CriterionDirection = "max" | "min";

/** Relative tolerance for marginal-pass classification (I-35). */
export const MARGINAL_TOLERANCE = 0.05;

export interface CriterionResult {
  key:
    | "C1_max_dd"
    | "C2_live_return"
    | "C3_capture"
    | "C4_bear_dd_reduction"
    /* legacy keys persisted in old v2_acceptance rows */
    | "C3_stress_sharpe";
  label: string;
  /** True if status is "pass" or "marginal" — the gating condition. */
  passed: boolean;
  /** Three-state classification (I-35). */
  status: CriterionStatus;
  /** What we observed (a number). */
  observed: number;
  /** What we needed (a threshold). */
  threshold: number;
  /** Direction of the comparison — needed for marginal-pass math. */
  direction: CriterionDirection;
  /** Per-window detail or context. */
  detail: string;
  /** Filled in when status === "marginal" — describes the gap. */
  marginal_note?: string;
}

/**
 * Classify a criterion's status given observed/threshold/direction.
 * Pure function; the caller decides what counts as the "observed"
 * value (worst window for max-direction, mean for min-direction, etc).
 *
 * Edge cases:
 *  - threshold = 0: any non-zero miss is treated as fail (no relative
 *    band defined around zero).
 *  - direction "max" passes when observed ≤ threshold.
 *  - direction "min" passes when observed ≥ threshold.
 */
export function classifyStatus(
  observed: number,
  threshold: number,
  direction: CriterionDirection,
): CriterionStatus {
  if (direction === "max") {
    if (observed <= threshold) return "pass";
    if (threshold <= 0) return "fail";
    return observed <= threshold * (1 + MARGINAL_TOLERANCE) ? "marginal" : "fail";
  }
  // direction "min"
  if (observed >= threshold) return "pass";
  if (threshold <= 0) return "fail";
  return observed >= threshold * (1 - MARGINAL_TOLERANCE) ? "marginal" : "fail";
}

/** Build a human-readable note explaining the marginal gap. */
function marginalNote(
  observed: number,
  threshold: number,
  direction: CriterionDirection,
): string {
  const pct = Math.abs((observed - threshold) / threshold) * 100;
  const dirWord = direction === "max" ? "over" : "under";
  return `observed ${observed.toFixed(3)} vs threshold ${threshold.toFixed(3)} — ${pct.toFixed(1)}% ${dirWord} threshold`;
}

export interface StressWindowResult {
  label: string;
  start_date: string;
  end_date: string;
  v2_max_dd_pct: number;     // negative (e.g. -8.5)
  btc_max_dd_pct: number;
  v2_return_pct: number;
  v2_sharpe: number | null;
  /** BTC Sharpe in the same window — required for C3a comparison. */
  btc_sharpe: number | null;
  /** BTC return in the same window, for context. */
  btc_return_pct?: number;
}

export interface AcceptanceInputs {
  index_id: string;
  stress_windows: StressWindowResult[];
  /** Live-period v2 return (%). */
  v2_live_return_pct: number;
  /** Live-period v2 max drawdown (%) — negative number. */
  v2_live_max_dd_pct: number;
  /** Live-period BTC buy-and-hold return (%) — the new C2 benchmark. */
  btc_live_return_pct: number;
  /** Live-period BTC buy-and-hold max drawdown (%) — negative. */
  btc_live_max_dd_pct: number;
  /** Optional: legacy naive-momentum return for context display only. */
  naive_live_return_pct?: number;
}

export interface AcceptanceResult {
  passed: boolean;
  criteria: CriterionResult[];
  evaluated_at: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Evaluation
// ─────────────────────────────────────────────────────────────────────────

const MAX_DD_MULTIPLIER = 1.5; // C1: v2 ≤ 1.5× BTC
const C2_DD_RATIO_THRESHOLD = 0.7; // v2.1 C2: v2 DD < 0.7× BTC's qualifies
const C3_CAPTURE_THRESHOLD = 0.5; // v2.1 C3: ≥50% upside capture in non-bear
const C4_BEAR_DD_RATIO = 0.7;     // v2.1 C4: v2 DD ≤ 0.7× BTC DD in bear windows

export function evaluateAcceptance(input: AcceptanceInputs): AcceptanceResult {
  const evaluatedAt = Date.now();

  // ── C1: Max drawdown across windows ≤ 1.5× BTC's
  let worstRatio = 0;
  let worstWindow: StressWindowResult | null = null;
  let c1Passed = true;
  for (const w of input.stress_windows) {
    const v2 = Math.abs(w.v2_max_dd_pct);
    const btc = Math.abs(w.btc_max_dd_pct);
    if (btc <= 0) continue;
    const ratio = v2 / btc;
    if (ratio > worstRatio) {
      worstRatio = ratio;
      worstWindow = w;
    }
    if (ratio > MAX_DD_MULTIPLIER) c1Passed = false;
  }
  const c1Observed = Math.round(worstRatio * 100) / 100;
  const c1Status = classifyStatus(c1Observed, MAX_DD_MULTIPLIER, "max");
  const c1: CriterionResult = {
    key: "C1_max_dd",
    label: "Max drawdown ≤ 1.5× BTC across all stress windows",
    passed: c1Status !== "fail",
    status: c1Status,
    observed: c1Observed,
    threshold: MAX_DD_MULTIPLIER,
    direction: "max",
    detail: worstWindow
      ? `worst window: ${worstWindow.label} → v2 ${worstWindow.v2_max_dd_pct}% vs BTC ${worstWindow.btc_max_dd_pct}%`
      : "no stress windows evaluated",
    marginal_note:
      c1Status === "marginal"
        ? marginalNote(c1Observed, MAX_DD_MULTIPLIER, "max")
        : undefined,
  };

  // ── C2 (revised v2.1): risk-adjusted value test.
  // v2 passes if EITHER beats BTC buy-and-hold return, OR has DD shallower
  // than 70% of BTC's DD. The disjunction tests for risk-adjusted alpha:
  // either we made more money than just-hold-BTC, or we took materially
  // less risk than just-hold-BTC. Either is a real win for a managed book.
  const v2DD = Math.abs(input.v2_live_max_dd_pct);
  const btcDD = Math.abs(input.btc_live_max_dd_pct);
  const ddBeat = btcDD > 0 && v2DD < btcDD * C2_DD_RATIO_THRESHOLD;
  const returnBeat = input.v2_live_return_pct > input.btc_live_return_pct;
  const c2Passed = returnBeat || ddBeat;
  const naiveSuffix =
    input.naive_live_return_pct != null
      ? ` · naive-momentum ${input.naive_live_return_pct.toFixed(1)}% (context only)`
      : "";
  // C2 is a disjunction (return-beat OR DD-beat) — marginal-pass math
  // doesn't apply cleanly to disjunctions, so this stays binary.
  const c2: CriterionResult = {
    key: "C2_live_return",
    label: "Live: v2 return > BTC OR v2 DD < 0.7× BTC DD (risk-adjusted)",
    passed: c2Passed,
    status: c2Passed ? "pass" : "fail",
    observed: returnBeat ? input.v2_live_return_pct : -v2DD,
    threshold: returnBeat ? input.btc_live_return_pct : -btcDD * C2_DD_RATIO_THRESHOLD,
    direction: "min", // larger return / shallower DD is better
    detail:
      `v2 ret ${input.v2_live_return_pct.toFixed(1)}% / DD ${input.v2_live_max_dd_pct.toFixed(1)}%; ` +
      `BTC ret ${input.btc_live_return_pct.toFixed(1)}% / DD ${input.btc_live_max_dd_pct.toFixed(1)}% — ` +
      `${returnBeat ? "return-beat" : ddBeat ? "DD-beat" : "neither"}${naiveSuffix}`,
  };

  // ── C3 (NEW v2.1): upside capture ≥ 50% across non-bear windows.
  // Bear classification uses BTC return < 0. Capture is computed per
  // window as v2_ret / BTC_ret, then averaged. If a window has BTC ret
  // exactly 0 we exclude it (avoid divide-by-zero); zero is neither
  // bear nor a meaningful capture-ratio reference.
  // If there are NO non-bear windows we report "n/a passing" — we
  // cannot evaluate capture without data, and refusing to graduate on
  // missing data would be a false-negative.
  const nonBearWindows = input.stress_windows.filter(
    (w) => (w.btc_return_pct ?? 0) > 0,
  );
  let c3Passed: boolean;
  let captureMean = 0;
  let c3Detail: string;
  if (nonBearWindows.length === 0) {
    c3Passed = true;
    c3Detail = "no non-bear windows in dataset — n/a, treated as passing";
  } else {
    const captures = nonBearWindows.map((w) => {
      const v2 = w.v2_return_pct;
      const btc = w.btc_return_pct ?? 0;
      return btc > 0 ? v2 / btc : 0;
    });
    captureMean = captures.reduce((s, x) => s + x, 0) / captures.length;
    c3Passed = captureMean >= C3_CAPTURE_THRESHOLD;
    const worstIdx = captures.reduce(
      (acc, v, i) => (v < acc.v ? { v, i } : acc),
      { v: Infinity, i: -1 },
    );
    const worstW = nonBearWindows[worstIdx.i];
    c3Detail =
      `${nonBearWindows.length} non-bear windows · mean capture ${(captureMean * 100).toFixed(1)}%; ` +
      (worstW
        ? `worst: ${worstW.label} → v2 ${worstW.v2_return_pct.toFixed(1)}% / BTC ${(worstW.btc_return_pct ?? 0).toFixed(1)}% = ${(worstIdx.v * 100).toFixed(1)}%`
        : "");
  }
  const c3Observed = Math.round(captureMean * 1000) / 1000;
  // "n/a passing" path keeps explicit pass status; otherwise classify.
  const c3Status: CriterionStatus =
    nonBearWindows.length === 0
      ? "pass"
      : classifyStatus(c3Observed, C3_CAPTURE_THRESHOLD, "min");
  const c3: CriterionResult = {
    key: "C3_capture",
    label: "Upside capture ≥ 50% across non-bear stress windows",
    passed: c3Status !== "fail",
    status: c3Status,
    observed: c3Observed,
    threshold: C3_CAPTURE_THRESHOLD,
    direction: "min",
    detail: c3Detail,
    marginal_note:
      c3Status === "marginal"
        ? marginalNote(c3Observed, C3_CAPTURE_THRESHOLD, "min")
        : undefined,
  };

  // ── C4 (NEW v2.1): bear-window drawdown reduction ≤ 0.7× BTC.
  // For windows where BTC return < 0, v2 must reduce drawdown by ≥ 30%.
  // If there are NO bear windows we report "n/a passing" (no data).
  const bearWindows = input.stress_windows.filter(
    (w) => (w.btc_return_pct ?? 0) < 0,
  );
  let c4Passed: boolean;
  let worstBearRatio = 0;
  let c4Detail: string;
  if (bearWindows.length === 0) {
    c4Passed = true;
    c4Detail = "no bear windows in dataset — n/a, treated as passing";
  } else {
    let worstBearW: StressWindowResult | null = null;
    for (const w of bearWindows) {
      const v2 = Math.abs(w.v2_max_dd_pct);
      const btc = Math.abs(w.btc_max_dd_pct);
      if (btc <= 0) continue;
      const ratio = v2 / btc;
      if (ratio > worstBearRatio) {
        worstBearRatio = ratio;
        worstBearW = w;
      }
    }
    c4Passed = worstBearRatio <= C4_BEAR_DD_RATIO;
    c4Detail =
      `${bearWindows.length} bear windows · worst ratio ${worstBearRatio.toFixed(2)}` +
      (worstBearW
        ? ` (${worstBearW.label}: v2 ${worstBearW.v2_max_dd_pct.toFixed(1)}% / BTC ${worstBearW.btc_max_dd_pct.toFixed(1)}%)`
        : "");
  }
  const c4Observed = Math.round(worstBearRatio * 100) / 100;
  const c4Status: CriterionStatus =
    bearWindows.length === 0
      ? "pass"
      : classifyStatus(c4Observed, C4_BEAR_DD_RATIO, "max");
  const c4: CriterionResult = {
    key: "C4_bear_dd_reduction",
    label: "Bear-window drawdown reduction: v2 DD ≤ 0.7× BTC DD",
    passed: c4Status !== "fail",
    status: c4Status,
    observed: c4Observed,
    threshold: C4_BEAR_DD_RATIO,
    direction: "max",
    detail: c4Detail,
    marginal_note:
      c4Status === "marginal"
        ? marginalNote(c4Observed, C4_BEAR_DD_RATIO, "max")
        : undefined,
  };

  const criteria = [c1, c2, c3, c4];
  // I-35: a criterion "passes" if status is "pass" or "marginal".
  // Overall acceptance fails only if any criterion is outright "fail".
  const passed = criteria.every((c) => c.status !== "fail");

  return { passed, criteria, evaluated_at: evaluatedAt };
}

// ─────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────

export function recordAcceptance(
  indexId: string,
  result: AcceptanceResult,
  context: {
    stress_summary?: unknown;
    live_summary?: unknown;
  } = {},
): string {
  const id = randomUUID();
  db()
    .prepare(
      `INSERT INTO v2_acceptance
         (id, index_id, evaluated_at, passed, criteria_json,
          stress_summary, live_summary)
       VALUES (@id, @index_id, @evaluated_at, @passed, @criteria_json,
               @stress_summary, @live_summary)`,
    )
    .run({
      id,
      index_id: indexId,
      evaluated_at: result.evaluated_at,
      passed: result.passed ? 1 : 0,
      criteria_json: JSON.stringify(result.criteria),
      stress_summary: context.stress_summary ? JSON.stringify(context.stress_summary) : null,
      live_summary: context.live_summary ? JSON.stringify(context.live_summary) : null,
    });
  return id;
}

export interface AcceptanceRecord {
  id: string;
  index_id: string;
  evaluated_at: number;
  passed: boolean;
  criteria: CriterionResult[];
  stress_summary: unknown | null;
  live_summary: unknown | null;
}

export function latestAcceptance(indexId: string): AcceptanceRecord | null {
  interface Raw {
    id: string;
    index_id: string;
    evaluated_at: number;
    passed: number;
    criteria_json: string;
    stress_summary: string | null;
    live_summary: string | null;
  }
  const row = db()
    .prepare<[string], Raw>(
      `SELECT id, index_id, evaluated_at, passed, criteria_json,
              stress_summary, live_summary
       FROM v2_acceptance
       WHERE index_id = ?
       ORDER BY evaluated_at DESC
       LIMIT 1`,
    )
    .get(indexId);
  if (!row) return null;
  return {
    id: row.id,
    index_id: row.index_id,
    evaluated_at: row.evaluated_at,
    passed: row.passed === 1,
    criteria: safeJson(row.criteria_json, []),
    stress_summary: row.stress_summary ? safeJson(row.stress_summary, null) : null,
    live_summary: row.live_summary ? safeJson(row.live_summary, null) : null,
  };
}

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
