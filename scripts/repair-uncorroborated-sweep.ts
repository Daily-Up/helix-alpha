/**
 * Repair signals that were over-aggressively swept as 'uncorroborated'.
 *
 * Pre-fix, the lifecycle sweep marked ANY pending signal with an elapsed
 * corroboration_deadline as expired/uncorroborated, regardless of source
 * quality. Tier-1 (Bloomberg/SEC/Reuters) and tier-2 (PANews/Decrypt/
 * CoinDesk/etc.) signals were getting killed after 8h just because no
 * sibling outlet re-covered the story.
 *
 * The fix restricts the sweep to tier-3 only. This script restores any
 * already-swept signal that wouldn't be killed under the new rule:
 *   - status='expired'
 *   - dismiss_reason='uncorroborated'
 *   - source_tier IN (1, 2) OR source_tier IS NULL
 *   - expires_at is still in the future (window still valid)
 *
 * Also resets corroboration_deadline to null so a future sweep on the
 * restored signal won't re-kill it.
 *
 * Usage: SOSOVALUE_API_KEY=x ANTHROPIC_API_KEY=x npx tsx scripts/repair-uncorroborated-sweep.ts
 */

import { db } from "../src/lib/db";

interface Row {
  id: string;
  asset_id: string;
  direction: string;
  triggered_by_event_id: string | null;
  source_tier: number | null;
  expires_at: number | null;
  fired_at: number;
}

const candidates = db()
  .prepare<[], Row>(
    `SELECT id, asset_id, direction, triggered_by_event_id,
            source_tier, expires_at, fired_at
     FROM signals
     WHERE status = 'expired'
       AND dismiss_reason = 'uncorroborated'
       AND (source_tier IS NULL OR source_tier <= 2)`,
  )
  .all();

const dedupCheck = db().prepare<[string, string, string], { n: number }>(
  `SELECT COUNT(*) AS n FROM signals
   WHERE status = 'pending'
     AND asset_id = ? AND direction = ? AND triggered_by_event_id = ?`,
);

console.log(`[repair] ${candidates.length} candidates marked uncorroborated with tier ≤ 2.`);

const now = Date.now();
const update = db().prepare(
  `UPDATE signals
     SET status = 'pending',
         dismissed_at = NULL,
         dismiss_reason = NULL,
         corroboration_deadline = NULL
   WHERE id = ?`,
);

let restored = 0;
let skipped_dedup = 0;
for (const c of candidates) {
  if (c.expires_at != null && c.expires_at < now) {
    // Window genuinely elapsed — leave expired.
    continue;
  }
  // Idempotence + dedup: don't restore if a same-event/asset/direction
  // signal is already pending. Without this, re-running the script
  // produced duplicate pending rows that bypassed insert-time dedup.
  if (c.triggered_by_event_id) {
    const dup = dedupCheck
      .get(c.asset_id, c.direction, c.triggered_by_event_id)
      ?.n ?? 0;
    if (dup > 0) {
      skipped_dedup++;
      continue;
    }
  }
  update.run(c.id);
  restored++;
  console.log(`  - restored ${c.id.slice(0, 8)} (asset=${c.asset_id}, tier=${c.source_tier ?? "null"})`);
}
if (skipped_dedup > 0) {
  console.log(`[repair] skipped ${skipped_dedup} (already pending duplicate).`);
}

console.log(`[repair] ${restored} signals restored to pending.`);
