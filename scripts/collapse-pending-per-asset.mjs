import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath,"utf8").split("\n")){const m=line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);if(m&&!process.env[m[1]]){let v=m[2].trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const now = Date.now();
const iso = (ms)=> new Date(Number(ms)).toISOString().slice(0,16).replace("T"," ");
const DRY = process.argv.includes("--dry");

// Enforce the per-asset same-direction cap: at most ONE pending signal
// per (asset_id, direction). Keep the highest confidence (tie → most
// recent); supersede the rest. Mirrors findSameDirectionPendingForAsset
// + the generator's same-dir cap.
const pend = (await db.execute({
  sql: `SELECT id, asset_id, direction, confidence, fired_at, tier
        FROM signals WHERE status = 'pending'
        ORDER BY asset_id, direction, confidence DESC, fired_at DESC`,
  args: [],
})).rows;

const groups = new Map();
for (const r of pend) {
  const k = `${r.asset_id}|${r.direction}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}

let kept = 0, superseded = 0;
for (const [k, rs] of groups) {
  if (rs.length < 2) { kept += rs.length; continue; }
  const keep = rs[0]; // already ordered: highest confidence, then newest
  kept++;
  console.log(`\n${k}  (${rs.length} pending) → keep ${String(keep.id).slice(0,12)} conf=${keep.confidence} fired=${iso(keep.fired_at)}`);
  for (const r of rs.slice(1)) {
    console.log(`   supersede ${String(r.id).slice(0,12)} conf=${r.confidence} fired=${iso(r.fired_at)}`);
    if (!DRY) {
      await db.execute({
        sql: `UPDATE signals
              SET status='dismissed', dismissed_at=?, dismiss_reason='superseded',
                  superseded_by_signal_id=?, effective_end_at=?
              WHERE id=?`,
        args: [now, String(keep.id), now, String(r.id)],
      });
    }
    superseded++;
  }
}

console.log(`\n${DRY ? "[DRY RUN] " : ""}kept ${kept} live · superseded ${superseded}`);
process.exit(0);
