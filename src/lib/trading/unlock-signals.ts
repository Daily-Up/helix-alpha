/**
 * Token-unlock SHORT-signal generator.
 *
 * A standalone, calendar-driven generator — deliberately NOT routed through
 * `runSignalGen`, whose direction is inferred sentiment-first (a neutral
 * "unlock" headline yields no signal) and whose proxy-hallucination gate is
 * built for fuzzy news→asset routing we don't need here (the unlock IS the
 * token). Instead we read upcoming, perp-tradable unlocks from
 * `token_unlocks`, hardcode `direction:"short"` (a large unlock = predictable
 * sell pressure), and reuse the exact persistence + invariant + outcome
 * machinery of the main pipeline. Rows land in the `signals` table, so they
 * render on /signals and execute through the unchanged ExecuteLiveButton /
 * paper-executor path — as SHORTS on the perp, one click.
 *
 * Deliberate divergences from runSignalGen (all safe for a first-party
 * calendar source): direction hardcoded; significance from the sell-pressure
 * proxy (not headline novelty); expires_at anchored to the unlock; the
 * hallucination/duplicate-news gates are skipped (asset comes from the
 * token's own mapping). Idempotent per unlock via event_chain_id.
 */

import { randomUUID } from "node:crypto";
import { Assets, Cron, Outcomes, Signals, TokenUnlocks } from "@/lib/db";
import type { NewSignal, SignalTier, TokenUnlockRow } from "@/lib/db";
import {
  checkSignalInvariants,
  type PreSaveSignal,
} from "@/lib/pipeline/invariants";
import { classifyAssetClass } from "@/lib/pipeline/base-rates";
import { findAsset } from "@/lib/universe";

export interface UnlockSignalGenSummary {
  scanned: number;
  created: number;
  skipped_below_threshold: number;
  skipped_no_asset: number;
  skipped_duplicate: number;
  skipped_invariant: number;
  by_tier: Record<SignalTier, number>;
  latency_ms: number;
}

export interface UnlockSignalGenOptions {
  /** Position-ahead horizon: unlocks within this many hours generate a
   *  short. Default 720h (30d) — large unlocks are known weeks ahead and
   *  price tends to weaken into them; the reasoning states the exact date. */
  leadHours?: number;
  /** Min unlock as % of circulating float to signal. Default 0.5. */
  minPctFloat?: number;
  /** Min unlock USD to signal when below the pct gate (very large absolute
   *  sell even at low % of float). Default 10M. */
  minUsd?: number;
  /** Base position size (× severity). Default 500 (settings default). */
  baseSizeUsd?: number;
}

const STOP_PCT = 5;
const TARGET_PCT = 12;
const HORIZON = "48h";
const REACTION_WINDOW_MS = 48 * 60 * 60 * 1000;

function tierFor(conviction: number): SignalTier {
  if (conviction >= 0.75) return "auto";
  if (conviction >= 0.5) return "review";
  return "info";
}

function severityFor(pctFloat: number, usd: number): number {
  if (pctFloat >= 3 || usd >= 25_000_000) return 1.0;
  if (pctFloat >= 1 || usd >= 8_000_000) return 0.7;
  return 0.4;
}

function bearishNote(row: TokenUnlockRow): string {
  try {
    const cats = JSON.parse(row.categories_json ?? "[]") as Array<{
      category?: string;
    }>;
    const set = new Set(cats.map((c) => (c.category ?? "").toLowerCase()));
    if (set.has("insiders") || set.has("privatesale") || set.has("investors"))
      return "team/investor tranche";
    if (set.has("airdrop") || set.has("publicsale")) return "community tranche";
  } catch {
    /* ignore */
  }
  return "scheduled tranche";
}

async function generateOne(
  row: TokenUnlockRow,
  opts: Required<Pick<UnlockSignalGenOptions, "minPctFloat" | "minUsd" | "baseSizeUsd">>,
  summary: UnlockSignalGenSummary,
): Promise<void> {
  const pctFloat = row.pct_of_circulating ?? 0;
  const usd = row.unlock_value_usd ?? 0;

  // (A) Threshold — below this it's calendar-only, no signal.
  if (pctFloat < opts.minPctFloat && usd < opts.minUsd) {
    summary.skipped_below_threshold++;
    return;
  }

  // A tradable row must carry an asset + perp symbol (upcomingUnlocks with
  // tradableOnly guarantees this, but be defensive).
  if (!row.asset_id || !row.sodex_symbol) {
    summary.skipped_no_asset++;
    return;
  }

  // (B) Idempotency — no triggering news_event, so dedup on event_chain_id.
  const eventChainId = `unlock:${row.id}`;
  if (await Signals.existsForEventChain(eventChainId)) {
    summary.skipped_duplicate++;
    return;
  }

  const asset = findAsset(row.symbol);
  if (!asset) {
    summary.skipped_no_asset++;
    return;
  }

  // (C) Sell-pressure proxy → conviction. 5%+ of float saturates.
  const proxy = Math.min(1, Math.max(0, pctFloat / 5));
  const conviction = Math.min(0.9, 0.45 + 0.45 * proxy);
  const severity = severityFor(pctFloat, usd);
  const size = Math.round(opts.baseSizeUsd * severity);
  const tier = tierFor(conviction);
  const significanceScore = Math.max(1e-6, proxy);
  const expiresAt = row.unlock_at + REACTION_WINDOW_MS;
  const assetClass = classifyAssetClass({ kind: asset.kind, symbol: asset.symbol }) ?? "unknown";

  const usdText = usd >= 1_000_000 ? `$${(usd / 1e6).toFixed(1)}M` : `$${Math.round(usd).toLocaleString()}`;
  const reasoning =
    `Scheduled ${row.unlock_kind ?? "cliff"} unlock of ${usdText} ` +
    `(${pctFloat.toFixed(2)}% of circulating float — ${bearishNote(row)}) ` +
    `on ${row.unlock_date}. Predictable, datable sell pressure → short into the unlock.`;

  // (D) Pre-save invariant gate (same as the main pipeline).
  const preSave: PreSaveSignal = {
    asset_id: row.asset_id,
    asset_kind: asset.kind,
    asset_symbol: asset.symbol,
    direction: "short",
    tier,
    confidence: conviction,
    reasoning,
    expected_horizon: HORIZON,
    suggested_stop_pct: STOP_PCT,
    suggested_target_pct: TARGET_PCT,
    asset_relevance: 1.0, // the unlock IS this exact asset
    catalyst_subtype: "unlock_supply",
    promotional_score: 0,
    source_tier: 1,
    expires_at: expiresAt,
    corroboration_deadline: null,
    event_chain_id: eventChainId,
    is_digest: false,
    title_validation_ok: true,
    base_rate: null,
    mechanism_length: null,
    counterfactual_strength: null,
  };
  const check = checkSignalInvariants(preSave);
  if (!check.ok) {
    summary.skipped_invariant++;
    const blocked = check.violations.filter((v) => v.severity === "block");
    console.warn(
      `[unlock-signals] invariant block for ${row.symbol} ${row.unlock_date}: ` +
        blocked.map((v) => v.rule).join(", "),
    );
    return;
  }

  // Ensure the asset row exists so the signals.asset_id FK + render join
  // resolve, regardless of whether the seed/ingest ran first. Idempotent.
  try {
    await Assets.upsertAsset(asset);
  } catch {
    /* non-fatal — seed step owns this normally */
  }

  const id = randomUUID();
  const newSignal: NewSignal = {
    id,
    triggered_by_event_id: null,
    pattern_id: null,
    asset_id: row.asset_id,
    sodex_symbol: row.sodex_symbol,
    direction: "short",
    tier,
    confidence: conviction,
    expected_impact_pct: null,
    expected_horizon: HORIZON,
    suggested_size_usd: size,
    suggested_stop_pct: STOP_PCT,
    suggested_target_pct: TARGET_PCT,
    reasoning,
    secondary_asset_ids: null,
    catalyst_subtype: "unlock_supply",
    expires_at: expiresAt,
    corroboration_deadline: null,
    event_chain_id: eventChainId,
    asset_relevance: 1.0,
    promotional_score: 0,
    source_tier: 1,
    significance_score: significanceScore,
  };
  await Signals.insertSignal(newSignal);
  await Outcomes.insertOutcomeFromSignal({
    signal_id: id,
    asset_class: assetClass,
    price_at_generation: row.price_usd ?? null,
  });
  if (!(await Outcomes.outcomeExistsFor(id))) {
    throw new Error(`unlock-signals: outcome record failed for ${id} (I-30)`);
  }
  summary.created++;
  summary.by_tier[tier]++;
}

export async function generateUnlockSignals(
  opts: UnlockSignalGenOptions = {},
): Promise<UnlockSignalGenSummary> {
  const t0 = Date.now();
  const leadHours = opts.leadHours ?? 720;
  const resolved = {
    minPctFloat: opts.minPctFloat ?? 0.5,
    minUsd: opts.minUsd ?? 10_000_000,
    baseSizeUsd: opts.baseSizeUsd ?? 500,
  };

  const summary: UnlockSignalGenSummary = {
    scanned: 0,
    created: 0,
    skipped_below_threshold: 0,
    skipped_no_asset: 0,
    skipped_duplicate: 0,
    skipped_invariant: 0,
    by_tier: { auto: 0, review: 0, info: 0 },
    latency_ms: 0,
  };

  const candidates = await TokenUnlocks.upcomingUnlocks({
    withinMs: leadHours * 60 * 60 * 1000,
    tradableOnly: true,
  });
  summary.scanned = candidates.length;

  for (const row of candidates) {
    try {
      await generateOne(row, resolved, summary);
    } catch (err) {
      console.warn(
        `[unlock-signals] failed on ${row.symbol} ${row.unlock_date}: ${(err as Error).message}`,
      );
    }
  }

  summary.latency_ms = Date.now() - t0;
  return summary;
}

export async function generateUnlockSignalsWithAudit(
  opts: UnlockSignalGenOptions = {},
): Promise<UnlockSignalGenSummary & { run_id: number }> {
  const { id, data } = await Cron.recordRun(
    "generate_unlock_signals",
    async () => {
      const s = await generateUnlockSignals(opts);
      const text =
        `scanned=${s.scanned} created=${s.created} ` +
        `(auto=${s.by_tier.auto}, review=${s.by_tier.review}, info=${s.by_tier.info}) ` +
        `dup=${s.skipped_duplicate} below=${s.skipped_below_threshold} ` +
        `latency=${(s.latency_ms / 1000).toFixed(1)}s`;
      return { summary: text, data: s };
    },
  );
  return { ...(data as UnlockSignalGenSummary), run_id: id };
}
