import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath,"utf8").split("\n")){const m=line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);if(m&&!process.env[m[1]]){let v=m[2].trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const now = Date.now();
const iso = (ms)=> new Date(Number(ms)).toISOString().slice(0,16).replace("T"," ");
const DAY = 86400000;

for (const [label, since] of [["last 24h", now-DAY], ["last 3d", now-3*DAY], ["last 7d", now-7*DAY]]) {
  const rows = (await db.execute({
    sql: `SELECT asset_id, direction, COUNT(*) n
          FROM signals WHERE fired_at >= ?
          GROUP BY asset_id, direction
          HAVING n > 1
          ORDER BY n DESC`,
    args: [since],
  })).rows;
  const total = (await db.execute({ sql:`SELECT COUNT(*) n FROM signals WHERE fired_at >= ?`, args:[since]})).rows[0].n;
  console.log(`\n=== ${label} — ${total} signals total; (asset,dir) with >1: ===`);
  for (const r of rows) console.log(`  ${String(r.asset_id).padEnd(10)} ${String(r.direction).padEnd(5)} ${r.n}`);
}

// Detail: the worst asset in last 3d, list each signal + its catalyst.
const worst = (await db.execute({
  sql: `SELECT asset_id FROM signals WHERE fired_at >= ? GROUP BY asset_id ORDER BY COUNT(*) DESC LIMIT 1`,
  args: [now-3*DAY],
})).rows[0]?.asset_id;
if (worst) {
  console.log(`\n=== detail: ${worst} last 3d ===`);
  const det = (await db.execute({
    sql: `SELECT s.id, s.direction, s.fired_at, s.status, s.tier, s.catalyst_subtype,
                 c.event_type, n.title
          FROM signals s
          LEFT JOIN classifications c ON c.event_id = s.triggered_by_event_id
          LEFT JOIN news_events n ON n.id = s.triggered_by_event_id
          WHERE s.asset_id = ? AND s.fired_at >= ?
          ORDER BY s.fired_at DESC`,
    args: [String(worst), now-3*DAY],
  })).rows;
  for (const r of det) console.log(`  ${iso(r.fired_at)} ${String(r.direction).padEnd(5)} ${String(r.tier).padEnd(7)} ${String(r.catalyst_subtype??"—").padEnd(22)} et=${String(r.event_type??"—").padEnd(18)} ${String(r.title??"").slice(0,50)}`);
}
process.exit(0);
