import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath,"utf8").split("\n")){const m=line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);if(m&&!process.env[m[1]]){let v=m[2].trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const JUNE = 1780272000000;
const iso = (m) => m==null?"—":new Date(Number(m)).toISOString().slice(0,10);

// ── Resolved Helix calls (genuine graded predictions) ──────────────
// A resolved call = signal_outcomes row with a terminal label AND a real
// priced outcome (price_at_outcome present, so win/loss is defined).
// Exclude dismissed/blocked (never traded) and shadow-v2 mirrors.
async function resolvedSet(sinceMs) {
  const r = await db.execute({
    sql: `SELECT o.signal_id, o.conviction, o.realized_pct, o.outcome,
                 o.generated_at, o.asset_id, o.direction, n.author, n.title
          FROM signal_outcomes o
          LEFT JOIN signals s ON s.id = o.signal_id
          LEFT JOIN news_events n ON n.id = s.triggered_by_event_id
          WHERE o.outcome IN ('target_hit','stop_hit','flat')
            AND o.price_at_outcome IS NOT NULL
            AND o.conviction IS NOT NULL
            AND COALESCE(o.framework_version,'v1')='v1'
            AND o.signal_id NOT LIKE '%-shadow-v2'
            AND o.generated_at >= ?`,
    args: [sinceMs],
  });
  return r.rows;
}

function brier(rows) {
  // predicted prob = conviction; actual = 1 if closed green (realized>0).
  let s = 0;
  for (const x of rows) {
    const p = Number(x.conviction);
    const y = Number(x.realized_pct) > 0 ? 1 : 0;
    s += (p - y) * (p - y);
  }
  return rows.length ? s / rows.length : null;
}

function reliability(rows) {
  const bins = [[0.3,0.5],[0.5,0.6],[0.6,0.7],[0.7,0.8],[0.8,1.01]];
  return bins.map(([lo,hi]) => {
    const inb = rows.filter(x => { const p=Number(x.conviction); return p>=lo && p<hi; });
    const wins = inb.filter(x => Number(x.realized_pct) > 0).length;
    return { band:`${lo.toFixed(2)}-${hi>1?"1.00":hi.toFixed(2)}`, n:inb.length,
             hit: inb.length? (wins/inb.length):null, avgP: inb.length? inb.reduce((a,x)=>a+Number(x.conviction),0)/inb.length:null };
  });
}

for (const [label, since] of [["ALL-TIME", 0], ["JUNE-2026+", JUNE]]) {
  const rows = await resolvedSet(since);
  const b = brier(rows);
  const dates = rows.map(x=>Number(x.generated_at)).sort((a,b)=>a-b);
  console.log(`\n===== ${label} — resolved & priced Helix calls =====`);
  console.log(`  n = ${rows.length}   since ${iso(dates[0])}  latest ${iso(dates.at(-1))}`);
  console.log(`  OUT-OF-SAMPLE Brier (conviction vs win) = ${b==null?"—":b.toFixed(4)}`);
  const wins = rows.filter(x=>Number(x.realized_pct)>0).length;
  console.log(`  base rate (win freq) = ${rows.length? (wins/rows.length).toFixed(3):"—"}  |  Brier of always-predicting-baserate = ${rows.length?((wins/rows.length)*(1-wins/rows.length)).toFixed(4):"—"}`);
  console.log(`  reliability bins:`);
  for (const rb of reliability(rows)) console.log(`    conv ${rb.band}: n=${String(rb.n).padStart(3)}  hit=${rb.hit==null?"—":(rb.hit*100).toFixed(0)+"%"}  (avg conv ${rb.avgP==null?"—":(rb.avgP*100).toFixed(0)+"%"})`);
}

// ── Real misses: high-conviction calls that lost (for the corrections column)
const misses = await resolvedSet(0);
const realMisses = misses
  .filter(x => Number(x.realized_pct) < 0 && Number(x.conviction) >= 0.6)
  .sort((a,b) => Number(a.realized_pct) - Number(b.realized_pct))
  .slice(0, 8);
console.log(`\n===== REAL MISSES (conviction >= 0.60, closed red) — candidates for Corrections =====`);
for (const m of realMisses) console.log(`  ${iso(m.generated_at)} ${String(m.asset_id).padEnd(9)} ${String(m.direction).padEnd(5)} conv ${(Number(m.conviction)*100).toFixed(0)}% -> ${Number(m.realized_pct).toFixed(2)}%  [${m.author||"?"}] ${String(m.title||"").slice(0,50)}`);

// ── Corpus: is it 95? does it hold any P(win)/calibration? ──────────
const cCount = (await db.execute("SELECT COUNT(*) n FROM historical_catalysts")).rows[0].n;
const cCols = (await db.execute("PRAGMA table_info(historical_catalysts)")).rows.map(r=>r.name);
console.log(`\n===== CORPUS (historical_catalysts) =====`);
console.log(`  rows = ${cCount}`);
console.log(`  columns = ${cCols.join(", ")}`);
process.exit(0);
