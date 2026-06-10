import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath,"utf8").split("\n")){const m=line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);if(m&&!process.env[m[1]]){let v=m[2].trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const now = Date.now();
const iso = (ms)=> ms==null?"—":new Date(Number(ms)).toISOString();

// Signals expired by the buggy clock/news-age passes are identifiable:
// status='expired' but NO dismiss_reason and NO dismissed_at. The real
// lifecycle sweeper ALWAYS stamps a reason ('stale_unexecuted' /
// 'uncorroborated'), so a null reason means a blunt clock killed it.
const bugged = (await db.execute({
  sql: `SELECT id, asset_id, direction, fired_at, expires_at
        FROM signals
        WHERE status = 'expired'
          AND dismiss_reason IS NULL
          AND dismissed_at IS NULL`,
  args: [],
})).rows;

console.log(`now = ${iso(now)}`);
console.log(`Bug-expired signals (no reason stamped): ${bugged.length}`);
const stillLive = bugged.filter((r) => Number(r.expires_at) > now);
const pastHorizon = bugged.filter((r) => Number(r.expires_at) <= now);
console.log(`  still within horizon (will go back to pending/live): ${stillLive.length}`);
console.log(`  past horizon (will be re-expired with proper reason):  ${pastHorizon.length}\n`);

// 1) Revert ALL bugged rows to pending.
const revert = await db.execute({
  sql: `UPDATE signals SET status = 'pending'
        WHERE status = 'expired'
          AND dismiss_reason IS NULL
          AND dismissed_at IS NULL`,
  args: [],
});
console.log(`Reverted ${Number(revert.rowsAffected)} → pending`);

// 2) Re-expire the genuinely past-horizon ones with the correct reason,
//    matching sweepExpiredSignals' stale_unexecuted pass.
const reexpire = await db.execute({
  sql: `UPDATE signals
        SET status = 'expired', dismissed_at = ?, dismiss_reason = 'stale_unexecuted'
        WHERE status = 'pending'
          AND expires_at IS NOT NULL
          AND expires_at <= ?
          AND id IN (${bugged.map(() => "?").join(",") || "''"})`,
  args: [now, now, ...bugged.map((r) => String(r.id))],
});
console.log(`Re-expired ${Number(reexpire.rowsAffected)} past-horizon signals with reason='stale_unexecuted'\n`);

console.log("Signals back to live (within horizon):");
for (const r of stillLive) {
  console.log(`  ${String(r.id).slice(0,12)} ${String(r.asset_id).padEnd(9)} ${r.direction}  expires=${iso(r.expires_at)}`);
}
process.exit(0);
