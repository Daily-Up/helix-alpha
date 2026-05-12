/**
 * Dedup pending signals sharing the same (asset_id, direction,
 * triggered_by_event_id).
 *
 * The `existsForEventAsset` guard fires at INSERT time, but restored
 * signals (from phantom-supersession or over-aggressive-sweep repair
 * scripts) bypass that guard. After two passes of repair on the same
 * historical pairs, the DB ended up with multiple pending rows per
 * (event, asset, direction).
 *
 * Resolution: keep the row with the highest `significance_score`
 * (tiebreak by most-recent fired_at). Mark the rest as `superseded`
 * by the winner via the existing `markSuperseded` helper — consistent
 * with Phase E semantics.
 *
 * Idempotent. Safe to re-run; only acts when duplicates exist.
 */

import { db } from "../src/lib/db";
import { markSuperseded } from "../src/lib/db/repos/signals";

interface Group {
  asset_id: string;
  direction: string;
  triggered_by_event_id: string;
  n: number;
}

interface SignalRow {
  id: string;
  significance_score: number | null;
  fired_at: number;
}

const groups = db()
  .prepare<[], Group>(
    `SELECT asset_id, direction, triggered_by_event_id, COUNT(*) AS n
     FROM signals
     WHERE status = 'pending' AND triggered_by_event_id IS NOT NULL
     GROUP BY asset_id, direction, triggered_by_event_id
     HAVING n > 1`,
  )
  .all();

console.log(`[dedup] ${groups.length} groups with duplicate pending signals.`);

let supersededTotal = 0;
for (const g of groups) {
  const rows = db()
    .prepare<[string, string, string], SignalRow>(
      `SELECT id, significance_score, fired_at FROM signals
       WHERE asset_id = ? AND direction = ? AND triggered_by_event_id = ?
         AND status = 'pending'
       ORDER BY COALESCE(significance_score, 0) DESC, fired_at DESC`,
    )
    .all(g.asset_id, g.direction, g.triggered_by_event_id);
  if (rows.length < 2) continue;
  const winner = rows[0]!;
  const losers = rows.slice(1);
  console.log(
    `\n  ${g.asset_id} ${g.direction}: winner=${winner.id.slice(0, 8)} (sig=${winner.significance_score ?? "—"})`,
  );
  for (const l of losers) {
    markSuperseded(l.id, winner.id);
    supersededTotal++;
    console.log(`    superseded ${l.id.slice(0, 8)} (sig=${l.significance_score ?? "—"})`);
  }
}

console.log(`\n[dedup] superseded ${supersededTotal} duplicate(s).`);
const remaining = db()
  .prepare<[], { n: number }>(
    `SELECT COUNT(*) AS n FROM (
       SELECT 1 FROM signals
       WHERE status = 'pending' AND triggered_by_event_id IS NOT NULL
       GROUP BY asset_id, direction, triggered_by_event_id
       HAVING COUNT(*) > 1
     )`,
  )
  .get();
console.log(`[dedup] remaining duplicate groups: ${remaining?.n ?? "?"} (target: 0).`);
