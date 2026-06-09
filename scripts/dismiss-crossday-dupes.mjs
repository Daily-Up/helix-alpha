import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath,"utf8").split("\n")){const m=line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);if(m&&!process.env[m[1]]){let v=m[2].trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const JUNE = 1780272000000;
const ds = (ms)=>new Date(Number(ms)).toISOString().slice(0,10);

const rows = (await db.execute({
  sql: `SELECT o.signal_id, o.asset_id, o.direction, o.outcome, o.realized_pct,
               o.generated_at, n.title
        FROM signal_outcomes o
        LEFT JOIN signals s ON s.id = o.signal_id
        LEFT JOIN news_events n ON n.id = s.triggered_by_event_id
        WHERE o.generated_at >= ?
          AND o.outcome IN ('target_hit','stop_hit','flat')
          AND COALESCE(o.framework_version,'v1') = 'v1'
          AND o.signal_id NOT LIKE '%-shadow-v2'
        ORDER BY o.asset_id, o.direction, o.generated_at ASC`,
  args: [JUNE],
})).rows;

const norm = (t) => String(t ?? "")
  .toLowerCase().replace(/^\[@[^\]]+\]/,"").replace(/[^a-z0-9 ]/g," ")
  .replace(/\s+/g," ").trim().slice(0,50);

const groups = new Map();
for (const r of rows) {
  const key = `${r.asset_id}|${r.direction}|${norm(r.title)}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

const toDismiss = [];
for (const [key, rs] of groups) {
  if (rs.length < 2) continue;
  if (key.split("|")[2].length < 8) continue;
  for (const r of rs) toDismiss.push(r);
}

console.log(`Dismissing ${toDismiss.length} rows across cross-day duplicate clusters:\n`);
for (const r of toDismiss) {
  console.log(`  ${r.asset_id.padEnd(9)} ${r.direction} ${ds(r.generated_at)} ${r.outcome.padEnd(10)} ${String(r.realized_pct).padStart(7)}%  ${String(r.signal_id).slice(0,12)}`);
  await db.execute({
    sql: `UPDATE signal_outcomes SET outcome='dismissed', outcome_at=?, notes=COALESCE(notes,'')||' [dismissed: cross-day duplicate catalyst]' WHERE signal_id=?`,
    args: [Date.now(), String(r.signal_id)],
  });
}
console.log("\nDONE");
process.exit(0);
