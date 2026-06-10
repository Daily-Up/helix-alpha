import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath,"utf8").split("\n")){const m=line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);if(m&&!process.env[m[1]]){let v=m[2].trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const now = Date.now();
const iso = (ms)=> ms==null?"—":new Date(Number(ms)).toISOString();

// Recently-fired signals currently flagged expired but whose expires_at is future.
const rows = (await db.execute({
  sql: `SELECT id, asset_id, direction, status, fired_at, expires_at,
               corroboration_deadline, dismiss_reason, dismissed_at,
               effective_end_at, superseded_by_signal_id
        FROM signals
        WHERE status = 'expired'
          AND expires_at > ?
        ORDER BY fired_at DESC
        LIMIT 25`,
  args: [now],
})).rows;

console.log(`now = ${iso(now)}`);
console.log(`Signals marked 'expired' but expires_at is still in the future: ${rows.length}\n`);
for (const r of rows) {
  console.log(`${String(r.id).slice(0,12)} ${String(r.asset_id).padEnd(9)} ${r.direction}`);
  console.log(`   fired=${iso(r.fired_at)}  expires=${iso(r.expires_at)}`);
  console.log(`   corrob_deadline=${iso(r.corroboration_deadline)}  dismissed_at=${iso(r.dismissed_at)}  reason=${r.dismiss_reason}`);
  console.log(`   effective_end_at=${iso(r.effective_end_at)}  superseded_by=${r.superseded_by_signal_id ?? "—"}`);
}
process.exit(0);
