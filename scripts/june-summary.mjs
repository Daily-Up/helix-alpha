import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath,"utf8").split("\n")){const m=line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);if(m&&!process.env[m[1]]){let v=m[2].trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const JUNE = 1780272000000;
const rows = (await db.execute({sql:`SELECT signal_id, asset_id, direction, outcome, realized_pct, price_at_outcome FROM signal_outcomes WHERE generated_at >= ? AND outcome IN ('target_hit','stop_hit','flat') ORDER BY generated_at ASC`, args:[JUNE]})).rows;
let tgt=0,stp=0,flat=0,priced=0,unpriced=0,sumRp=0;
const wins = [], losses = [];
for (const r of rows) {
  if (r.outcome==='target_hit') tgt++; else if (r.outcome==='stop_hit') stp++; else flat++;
  if (r.price_at_outcome==null) { unpriced++; continue; }
  priced++;
  const rp = Number(r.realized_pct);
  sumRp += rp;
  if (rp > 0) wins.push(rp); else losses.push(rp);
}
console.log(`June resolved outcomes: ${rows.length}`);
console.log(`  labels: target_hit=${tgt} stop_hit=${stp} flat=${flat}`);
console.log(`  priced=${priced} unpriced(—)=${unpriced}`);
console.log(`  win-rate (realized_pct>0, priced only): ${wins.length}/${priced} = ${priced?(100*wins.length/priced).toFixed(1):0}%`);
console.log(`  avg realized (priced): ${priced?(sumRp/priced).toFixed(2):0}%`);
console.log(`  best ${Math.max(...wins,0).toFixed(2)}%  worst ${Math.min(...losses,0).toFixed(2)}%`);
process.exit(0);
