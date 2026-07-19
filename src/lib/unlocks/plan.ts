/**
 * Unlock trade plan — turns a stored token_unlocks row into a SHORT plan.
 *
 * Model (from empirical unlock studies — Keyrock 16k+ events, Tokenomist 236):
 * the negative impact is FRONT-LOADED — price bleeds in the days before a
 * known unlock (anticipation / pre-hedging), the date itself is often the
 * anticlimax, and pressure eases within ~1–3 weeks after ("down before,
 * relief after"). So we DON'T short 30 days early; we arm a window a week or
 * two out and plan to cover shortly after the unlock.
 *
 *   Eligible   team (insiders) or investor (private-sale) CLIFFS, ≥1% of float.
 *              Ecosystem / community / airdrop unlocks are skipped (often
 *              neutral-to-positive). Must be SoDEX-perp-tradable to short.
 *   Materiality  by % of circulating float — modest 1–5, strong 5–10, huge >10.
 *   Entry      T−7d (modest) / T−10d (strong) / T−14d (huge); best near T−1..3.
 *   Cover      T+3d (plus stop/target); pressure eases within 1–3 weeks.
 *   Conviction recipient (team>investor) × size × cliff-vs-linear.
 *
 * This is computed at READ time (the phase depends on "now"), so no schema
 * columns are stored for it and no re-ingest is needed to retune.
 */

const DAY = 24 * 60 * 60 * 1000;

export type RecipientClass = "team" | "investor" | "mixed" | "other";
export type Materiality = "huge" | "strong" | "modest" | "small";
/** watching = eligible but pre-entry-window; entry = armed to short now;
 *  holding = unlock passed, in the cover tail; ineligible = calendar-only. */
export type UnlockPhase = "watching" | "entry" | "holding" | "past" | "ineligible";

export interface UnlockPlanInput {
  unlock_at: number;
  unlock_kind: string | null;
  unlock_value_usd: number | null;
  pct_of_circulating: number | null;
  categories_json: string | null;
  tradable_perp: number;
  sodex_symbol: string | null;
}

export interface UnlockTradePlan {
  eligible: boolean;
  recipientClass: RecipientClass;
  materiality: Materiality;
  pctFloat: number;
  isCliff: boolean;
  conviction: number; // 0..1
  priority: "high" | "medium" | "low";
  entryLeadDays: number;
  coverTailDays: number;
  entryAt: number; // ms — window opens
  coverAt: number; // ms — planned cover
  stopPct: number;
  targetPct: number;
  suggestedSizeUsd: number;
  phase: UnlockPhase;
  /** Short human-readable plan, e.g. "Short ~Aug 5 (T−7d) → cover ~Aug 15". */
  note: string;
}

const TEAM_CATS = new Set([
  "insiders",
  "team",
  "contributors",
  "advisors",
  "founders",
]);
const INVESTOR_CATS = new Set([
  "privatesale",
  "private sale",
  "investors",
  "seed",
  "presale",
  "strategic",
  "venture",
]);

export function classifyRecipient(categoriesJson: string | null): RecipientClass {
  let cats: Array<{ category?: string }> = [];
  try {
    cats = JSON.parse(categoriesJson ?? "[]") as Array<{ category?: string }>;
  } catch {
    /* ignore */
  }
  const set = new Set(cats.map((c) => (c.category ?? "").toLowerCase().trim()));
  const hasTeam = [...set].some((c) => TEAM_CATS.has(c));
  const hasInvestor = [...set].some((c) => INVESTOR_CATS.has(c));
  if (hasTeam && hasInvestor) return "mixed";
  if (hasTeam) return "team";
  if (hasInvestor) return "investor";
  return "other";
}

function materialityFor(pct: number): Materiality {
  if (pct >= 10) return "huge";
  if (pct >= 5) return "strong";
  if (pct >= 1) return "modest";
  return "small";
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function computeUnlockTradePlan(
  row: UnlockPlanInput,
  now: number = Date.now(),
): UnlockTradePlan {
  const pctFloat = row.pct_of_circulating ?? 0;
  const recipientClass = classifyRecipient(row.categories_json);
  const materiality = materialityFor(pctFloat);
  const isCliff = (row.unlock_kind ?? "cliff") !== "linear";

  const recipientTradeable =
    recipientClass === "team" ||
    recipientClass === "investor" ||
    recipientClass === "mixed";
  const perpOk = row.tradable_perp === 1 && !!row.sodex_symbol;
  const eligible = perpOk && recipientTradeable && materiality !== "small";

  // Conviction: recipient base × size multiplier × cliff-vs-linear.
  const recBase =
    recipientClass === "team" || recipientClass === "mixed"
      ? 0.6
      : recipientClass === "investor"
        ? 0.45
        : 0.3;
  const sizeMult =
    materiality === "huge"
      ? 1.3
      : materiality === "strong"
        ? 1.1
        : materiality === "modest"
          ? 0.85
          : 0.6;
  const kindMult = isCliff ? 1.0 : 0.8;
  const conviction = Math.max(0.3, Math.min(0.9, recBase * sizeMult * kindMult));
  const priority =
    conviction >= 0.7 ? "high" : conviction >= 0.5 ? "medium" : "low";

  const entryLeadDays =
    materiality === "huge" ? 14 : materiality === "strong" ? 10 : 7;
  const coverTailDays = 3;
  const entryAt = row.unlock_at - entryLeadDays * DAY;
  const coverAt = row.unlock_at + coverTailDays * DAY;

  const stopPct = 6;
  const targetPct =
    materiality === "huge" ? 15 : materiality === "strong" ? 12 : 10;
  const suggestedSizeUsd = Math.round(
    500 * (materiality === "huge" ? 1 : materiality === "strong" ? 0.8 : 0.6),
  );

  let phase: UnlockPhase;
  if (!eligible) phase = "ineligible";
  else if (now < entryAt) phase = "watching";
  else if (now <= row.unlock_at) phase = "entry";
  else if (now <= coverAt) phase = "holding";
  else phase = "past";

  const note = eligible
    ? `Short ~${fmtDate(entryAt)} (T−${entryLeadDays}d) → cover ~${fmtDate(coverAt)} (T+${coverTailDays}d). Best entry closer to the date.`
    : recipientTradeable
      ? `Below ${1}% of float — watch only.`
      : "Ecosystem / community unlock — not a short setup.";

  return {
    eligible,
    recipientClass,
    materiality,
    pctFloat,
    isCliff,
    conviction,
    priority,
    entryLeadDays,
    coverTailDays,
    entryAt,
    coverAt,
    stopPct,
    targetPct,
    suggestedSizeUsd,
    phase,
    note,
  };
}
