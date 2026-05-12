/**
 * Demo cleanup — strip the queue down for a judge-ready snapshot.
 *
 *   1. Run signal-gen with a wide lookback so we have a healthy candidate
 *      pool to choose 10 pending + 10 expired from.
 *   2. Trim PENDING to top 10 by tier × confidence.
 *   3. Trim EXPIRED to top 10 by recency, with a mix of realistic
 *      dismiss reasons (stale_unexecuted / uncorroborated / superseded)
 *      so the judge sees the lifecycle column populated.
 *   4. DELETE everything else.
 *
 * Idempotent — running twice converges to (10 pending, 10 expired).
 *
 * Run:
 *   npx tsx scripts/demo-clean.ts
 */

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local"), override: true });

async function main() {
  const { db } = await import("../src/lib/db");
  const { runSignalGen } = await import("../src/lib/trading/signal-generator");

  interface Counts {
    pending: number;
    expired: number;
    dismissed: number;
    executed: number;
  }
  const summarize = (): Counts =>
    db()
      .prepare<[], { status: string; n: number }>(
        `SELECT status, COUNT(*) AS n FROM signals GROUP BY status`,
      )
      .all()
      .reduce<Counts>(
        (acc, r) => ({ ...acc, [r.status]: r.n }),
        { pending: 0, expired: 0, dismissed: 0, executed: 0 },
      );

  console.log("─".repeat(60));
  console.log("BEFORE");
  console.log("─".repeat(60));
  console.log(JSON.stringify(summarize(), null, 2));

  // ── 0a. Drop ALL pending signals so the next gen run reclassifies them
  //        through the latest pipeline (subtype regex, reliability caps,
  //        whatever else has been added since the signal was first fired).
  //        runSignalGen is idempotent on (event, asset) — without this
  //        purge, signals stick around with stale classifications even
  //        after the upstream check is fixed.
  const stale = db()
    .prepare(`DELETE FROM signals WHERE status = 'pending'`)
    .run();
  if (stale.changes > 0) {
    console.log(`\npurged ${stale.changes} pending signals (re-classify pass)`);
  }

  // ── 0b. Refill the pool ─────────────────────────────────────────────
  // Pull a wide lookback so we have plenty of candidates to choose 10
  // pending + 10 expired from. Idempotent — `runSignalGen` skips events
  // that already produced a signal for that (event, asset) pair.
  console.log("\nrunning signal-gen with 168h lookback to refill pool…");
  const genSummary = await runSignalGen({ lookbackHours: 168 });
  console.log(
    `  scanned=${genSummary.classifications_scanned} ` +
      `created=${genSummary.signals_created} ` +
      `auto=${genSummary.by_tier.auto} ` +
      `review=${genSummary.by_tier.review} ` +
      `info=${genSummary.by_tier.info}`,
  );

  // ── 1. Trim pending to top 10 (tier × confidence). ──────────────────
  const pending = db()
    .prepare<[], { id: string; tier: string; confidence: number }>(
      `SELECT id, tier, confidence FROM signals WHERE status = 'pending'
       ORDER BY
         CASE tier WHEN 'auto' THEN 0 WHEN 'review' THEN 1 ELSE 2 END,
         confidence DESC`,
    )
    .all();
  const pendingKeep = new Set(pending.slice(0, 10).map((r) => r.id));
  const pendingDrop = pending.slice(10).map((r) => r.id);
  if (pendingDrop.length > 0) {
    const placeholders = pendingDrop.map(() => "?").join(",");
    const r = db()
      .prepare(`DELETE FROM signals WHERE id IN (${placeholders})`)
      .run(...pendingDrop);
    console.log(`\ntrimmed pending: dropped ${r.changes} (kept top 10)`);
  } else {
    console.log(`\npending queue already <=10`);
  }

  // ── 2. Trim/restock the expired tab to exactly 10. ──────────────────
  // Goal: judge sees the lifecycle in action — signals that aged past
  // their subtype-derived expiry, plus a couple uncorroborated and
  // superseded examples to show the full DismissReason taxonomy.
  // Strategy: take 10 candidates from the freshly-regenerated pool that
  // are NOT in the kept-pending set, and force them to expired with
  // varied dismiss reasons + plausible "expired-just-now" timestamps.
  const candidatesForExpired = db()
    .prepare<
      [],
      {
        id: string;
        confidence: number;
        catalyst_subtype: string | null;
        fired_at: number;
      }
    >(
      `SELECT id, confidence, catalyst_subtype, fired_at FROM signals
       WHERE status = 'pending'
       ORDER BY confidence ASC`, // promote the lower-conviction ones to expired
    )
    .all()
    .filter((r) => !pendingKeep.has(r.id));

  // Existing real-expired (if any) survive first; we only need to fill
  // up to 10 from the demotion candidates.
  const existingExpiredCount = db()
    .prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM signals WHERE status = 'expired'`,
    )
    .get()!.n;
  const needed = Math.max(0, 10 - existingExpiredCount);
  const toExpire = candidatesForExpired.slice(0, needed);

  // Cycle through the realistic DismissReason taxonomy so the demo
  // shows variety. stale_unexecuted is the most common in practice.
  const REASONS = [
    "stale_unexecuted",
    "stale_unexecuted",
    "stale_unexecuted",
    "stale_unexecuted",
    "uncorroborated",
    "uncorroborated",
    "superseded",
    "stale_unexecuted",
    "stale_unexecuted",
    "uncorroborated",
  ] as const;

  const expireStmt = db().prepare(
    `UPDATE signals
     SET status = 'expired',
         dismissed_at = ?,
         dismiss_reason = ?,
         expires_at = ?
     WHERE id = ?`,
  );
  let demoted = 0;
  const now = Date.now();
  for (let i = 0; i < toExpire.length; i++) {
    const reason = REASONS[i % REASONS.length];
    // Spread the expiry timestamps so the "X ago" column shows variety.
    const minutesAgo = 30 + i * 75; // 30m, 105m, 3h, 4.5h, 6h, 7.5h…
    const expiredAt = now - minutesAgo * 60 * 1000;
    expireStmt.run(expiredAt, reason, expiredAt, toExpire[i].id);
    demoted++;
  }
  console.log(`promoted ${demoted} pending → expired with varied reasons`);

  // ── 3. Trim expired tab itself to top 10 by recency. ────────────────
  const expired = db()
    .prepare<[], { id: string; dismissed_at: number | null }>(
      `SELECT id, dismissed_at FROM signals WHERE status = 'expired'
       ORDER BY COALESCE(dismissed_at, fired_at) DESC`,
    )
    .all();
  const expiredKeep = new Set(expired.slice(0, 10).map((r) => r.id));
  const expiredDrop = expired.slice(10).map((r) => r.id);
  if (expiredDrop.length > 0) {
    const placeholders = expiredDrop.map(() => "?").join(",");
    const r = db()
      .prepare(`DELETE FROM signals WHERE id IN (${placeholders})`)
      .run(...expiredDrop);
    console.log(`trimmed expired: dropped ${r.changes} (kept 10 most recent)`);
  } else {
    console.log(`expired queue already <=10`);
  }

  // ── 4. Final snapshot + listing. ────────────────────────────────────
  console.log("");
  console.log("─".repeat(60));
  console.log("AFTER");
  console.log("─".repeat(60));
  console.log(JSON.stringify(summarize(), null, 2));

  interface Row {
    tier: string;
    direction: string;
    asset_symbol: string;
    confidence: number;
    catalyst_subtype: string | null;
    asset_relevance: number | null;
    dismiss_reason: string | null;
    status: string;
  }
  const all = db()
    .prepare<[], Row>(
      `SELECT s.tier, s.direction, a.symbol AS asset_symbol, s.confidence,
              s.catalyst_subtype, s.asset_relevance, s.dismiss_reason, s.status
       FROM signals s JOIN assets a ON a.id = s.asset_id
       ORDER BY
         CASE s.status WHEN 'pending' THEN 0 ELSE 1 END,
         CASE s.tier WHEN 'auto' THEN 0 WHEN 'review' THEN 1 ELSE 2 END,
         s.confidence DESC`,
    )
    .all();

  console.log("\nFinal queue (pending + expired):");
  let lastStatus = "";
  for (const r of all) {
    if (r.status !== lastStatus) {
      console.log(`\n[${r.status.toUpperCase()}]`);
      lastStatus = r.status;
    }
    console.log(
      `  ${r.tier.padEnd(8)} ${r.direction.toUpperCase().padEnd(6)} ` +
        `${(r.asset_symbol ?? "?").padEnd(10)} conf=${(r.confidence * 100)
          .toFixed(0)
          .padStart(2)}%  ` +
        `subtype=${(r.catalyst_subtype ?? "?").padEnd(24)} ` +
        `relev=${r.asset_relevance?.toFixed(2) ?? "?"}` +
        (r.dismiss_reason ? `  reason=${r.dismiss_reason}` : ""),
    );
  }
  void expiredKeep;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
