/**
 * Regenerate signals through the NEW pipeline.
 *
 *   1. Snapshot the current active queue (stats only).
 *   2. Mark all pending signals as expired with reason
 *      'regenerated_via_new_pipeline' — they were produced by the older
 *      inline-checks code path before the pipeline modules were wired in.
 *   3. Run the signal generator (which now goes through detectDigest +
 *      routeAssets + inferCatalystSubtype + invariant gate + lifecycle).
 *   4. Print the new active queue + summary.
 *
 * Run:
 *   npx tsx scripts/regen-signals.ts
 */

import { config } from "dotenv";
import { resolve } from "node:path";

// override:true so we don't inherit empty/blank ANTHROPIC_API_KEY etc. from
// a parent shell that pre-set the var to empty.
config({ path: resolve(process.cwd(), ".env.local"), override: true });

async function main() {
  const { db, Signals } = await import("../src/lib/db");
  const { runSignalGen } = await import("../src/lib/trading/signal-generator");

  // ── 1. Before snapshot ──────────────────────────────────────────────
  interface BeforeRow {
    tier: string;
    n: number;
  }
  const beforeByTier = db()
    .prepare<[], BeforeRow>(
      `SELECT tier, COUNT(*) AS n FROM signals
       WHERE status = 'pending'
       GROUP BY tier`,
    )
    .all();
  const beforeTotal = beforeByTier.reduce((s, r) => s + r.n, 0);

  console.log("─".repeat(70));
  console.log("BEFORE — active queue (old pipeline)");
  console.log("─".repeat(70));
  console.log(`total pending: ${beforeTotal}`);
  for (const r of beforeByTier) {
    console.log(`  ${r.tier.padEnd(8)} ${r.n}`);
  }

  // Show the specific signals so we know what we're flushing.
  interface SigRow {
    id: string;
    fired_at: number;
    asset_id: string;
    sodex_symbol: string;
    direction: string;
    tier: string;
    confidence: number;
  }
  const beforeSignals = db()
    .prepare<[], SigRow>(
      `SELECT id, fired_at, asset_id, sodex_symbol, direction, tier, confidence
       FROM signals
       WHERE status = 'pending'
       ORDER BY fired_at DESC LIMIT 30`,
    )
    .all();
  console.log("");
  for (const s of beforeSignals) {
    const ageH = ((Date.now() - s.fired_at) / 3600 / 1000).toFixed(1);
    console.log(
      `  ${s.tier.padEnd(8)} ${s.direction.toUpperCase().padEnd(6)} ${s.sodex_symbol.padEnd(12)} conf=${(s.confidence * 100).toFixed(0)}%  ${ageH}h ago  ${s.id.slice(0, 8)}`,
    );
  }

  // ── 2. Purge ────────────────────────────────────────────────────────
  console.log("");
  console.log("─".repeat(70));
  console.log("PURGING old pipeline signals (status=pending → expired)");
  console.log("─".repeat(70));
  const purged = db()
    .prepare(
      `UPDATE signals
       SET status = 'expired',
           dismissed_at = ?,
           dismiss_reason = 'regenerated_via_new_pipeline'
       WHERE status = 'pending'`,
    )
    .run(Date.now());
  console.log(`purged: ${purged.changes}`);

  // ── 3. Regenerate ───────────────────────────────────────────────────
  console.log("");
  console.log("─".repeat(70));
  console.log("REGENERATING through new pipeline");
  console.log("─".repeat(70));
  const summary = await runSignalGen({ lookbackHours: 72 });
  console.log(JSON.stringify(summary, null, 2));

  // ── 4. After snapshot ───────────────────────────────────────────────
  const afterByTier = db()
    .prepare<[], BeforeRow>(
      `SELECT tier, COUNT(*) AS n FROM signals
       WHERE status = 'pending'
       GROUP BY tier`,
    )
    .all();
  const afterTotal = afterByTier.reduce((s, r) => s + r.n, 0);

  console.log("");
  console.log("─".repeat(70));
  console.log("AFTER — active queue (new pipeline)");
  console.log("─".repeat(70));
  console.log(`total pending: ${afterTotal}  (was ${beforeTotal})`);
  for (const r of afterByTier) {
    console.log(`  ${r.tier.padEnd(8)} ${r.n}`);
  }

  interface NewSigRow {
    id: string;
    fired_at: number;
    asset_id: string;
    sodex_symbol: string;
    direction: string;
    tier: string;
    confidence: number;
    catalyst_subtype: string | null;
    expires_at: number | null;
    asset_relevance: number | null;
    promotional_score: number | null;
    source_tier: number | null;
  }
  const afterSignals = db()
    .prepare<[], NewSigRow>(
      `SELECT id, fired_at, asset_id, sodex_symbol, direction, tier, confidence,
              catalyst_subtype, expires_at, asset_relevance, promotional_score, source_tier
       FROM signals
       WHERE status = 'pending'
       ORDER BY fired_at DESC LIMIT 30`,
    )
    .all();
  console.log("");
  for (const s of afterSignals) {
    const ageH = ((Date.now() - s.fired_at) / 3600 / 1000).toFixed(1);
    const ttl = s.expires_at
      ? `${((s.expires_at - Date.now()) / 3600 / 1000).toFixed(1)}h`
      : "—";
    console.log(
      `  ${s.tier.padEnd(8)} ${s.direction.toUpperCase().padEnd(6)} ${s.sodex_symbol.padEnd(12)} ` +
        `conf=${(s.confidence * 100).toFixed(0)}%  ttl=${ttl.padEnd(7)} ` +
        `subtype=${(s.catalyst_subtype ?? "?").padEnd(24)} ` +
        `relev=${s.asset_relevance?.toFixed(2) ?? "?"}  ` +
        `promo=${s.promotional_score?.toFixed(2) ?? "?"}  ` +
        `src=t${s.source_tier ?? "?"}`,
    );
  }

  // Touch Signals so the linter doesn't complain about unused import
  // (used implicitly via the runSignalGen path).
  void Signals;

  console.log("");
  console.log("done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
