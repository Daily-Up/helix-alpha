/**
 * CLI test for the impact engine.
 *
 *   npm run test:impact
 *
 * Runs the engine, prints a summary, then dumps the top + bottom 5
 * impacts so we can sanity-check that the math worked.
 */

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

async function main() {
  const { runImpactComputeWithAudit } = await import("../src/lib/analysis");
  const { db, Impact } = await import("../src/lib/db");

  console.log("→ Running impact compute (limit=2000, oldest-first)...");
  const summary = await runImpactComputeWithAudit({ limit: 2000 });
  console.log(
    `  pending=${summary.pending}  computed=${summary.computed}\n` +
      `  skip_no_t0=${summary.skipped_no_t0}  skip_no_klines=${summary.skipped_no_klines}\n` +
      `  errors=${summary.errors}  latency=${(summary.latency_ms / 1000).toFixed(1)}s`,
  );

  // Top movers (by abs 1d impact)
  type Row = {
    title: string;
    event_type: string;
    asset_id: string;
    impact_pct_1d: number | null;
    impact_pct_7d: number | null;
    release_time: number;
  };
  const top = db()
    .prepare<[], Row>(
      `SELECT n.title, c.event_type, im.asset_id,
              im.impact_pct_1d, im.impact_pct_7d, n.release_time
       FROM impact_metrics im
       JOIN news_events n ON n.id = im.event_id
       JOIN classifications c ON c.event_id = im.event_id
       WHERE im.impact_pct_1d IS NOT NULL
       ORDER BY ABS(im.impact_pct_1d) DESC
       LIMIT 8`,
    )
    .all();

  if (top.length > 0) {
    console.log("\n──── Biggest 1d moves around classified events ────");
    for (const r of top) {
      const ts = new Date(r.release_time).toISOString().slice(0, 10);
      const d1 =
        r.impact_pct_1d != null ? `${r.impact_pct_1d.toFixed(2)}%` : "—";
      const d7 =
        r.impact_pct_7d != null ? `${r.impact_pct_7d.toFixed(2)}%` : "—";
      console.log(
        `[${ts}] ${r.event_type.padEnd(15)} ${r.asset_id.padEnd(10)} ` +
          `1d=${d1.padStart(8)} 7d=${d7.padStart(8)}  ${r.title.slice(0, 70)}`,
      );
    }
  }

  // Pattern aggregates
  console.log("\n──── Aggregated impact by event_type (1d horizon) ────");
  const agg = Impact.aggregateByEventType("1d", 2);
  for (const a of agg) {
    console.log(
      `${a.event_type.padEnd(15)} n=${String(a.n).padStart(2)}  ` +
        `avg=${a.avg.toFixed(2)}%  median=${a.median.toFixed(2)}%  ` +
        `stddev=${a.stddev.toFixed(2)}%`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
