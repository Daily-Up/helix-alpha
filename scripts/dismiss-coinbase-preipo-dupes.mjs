import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath,"utf8").split("\n")){const m=line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);if(m&&!process.env[m[1]]){let v=m[2].trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const ds = (ms)=>new Date(Number(ms)).toISOString().slice(0,10);

const candidates = (await db.execute({
  sql: `SELECT o.signal_id, o.asset_id, o.direction, o.outcome, o.realized_pct,
               o.generated_at, n.title
        FROM signal_outcomes o
        LEFT JOIN signals s ON s.id = o.signal_id
        LEFT JOIN news_events n ON n.id = s.triggered_by_event_id
        WHERE o.asset_id = 'stk-coin' AND o.direction = 'long'
          AND substr(datetime(o.generated_at/1000,'unixepoch'),1,10) IN ('2026-06-04','2026-06-05')
          AND o.outcome IN ('target_hit','stop_hit','flat')
        ORDER BY o.generated_at ASC`,
  args: [],
})).rows;

console.log("Matched rows:");
for (const r of candidates) {
  console.log(`  ${String(r.signal_id).slice(0,14)} ${ds(r.generated_at)} ${r.direction} ${r.outcome} ${r.realized_pct}%  ${String(r.title??"").slice(0,60)}`);
}

const dupeIds = candidates
  .filter((r) => /pre-?IPO|perpetual futures|Coinbase is launching/i.test(String(r.title ?? "")))
  .map((r) => String(r.signal_id));

console.log(`\nDismissing ${dupeIds.length} duplicate(s):`, dupeIds);
for (const id of dupeIds) {
  await db.execute({
    sql: `UPDATE signal_outcomes SET outcome='dismissed', outcome_at=?, notes=COALESCE(notes,'')||' [dismissed: duplicate Coinbase pre-IPO perps catalyst]' WHERE signal_id=?`,
    args: [Date.now(), id],
  });
}
console.log("DONE");
process.exit(0);
