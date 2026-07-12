import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath,"utf8").split("\n")){const m=line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);if(m&&!process.env[m[1]]){let v=m[2].trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

// Sponsored/KOL Twitter accounts the user chose to remove (case-insensitive).
const BLOCKED = ["cryptorover", "watcherguru", "coinspace_", "cointelegraph", "coindesk"];
const now = Date.now();

// Every signal whose triggering event came from one of these authors.
const sigs = (await db.execute({
  sql: `SELECT s.id, s.status, n.author
        FROM signals s
        LEFT JOIN news_events n ON n.id = s.triggered_by_event_id
        WHERE LOWER(COALESCE(n.author,'')) IN (${BLOCKED.map(() => "?").join(",")})`,
  args: BLOCKED,
})).rows;

console.log(`Found ${sigs.length} signals from sponsored sources:`);
const byAuthor = {};
for (const s of sigs) byAuthor[String(s.author)] = (byAuthor[String(s.author)] || 0) + 1;
for (const [a, n] of Object.entries(byAuthor)) console.log(`  ${a}: ${n}`);

let outcomesDismissed = 0, signalsDismissed = 0;
for (const s of sigs) {
  const id = String(s.id);
  // Drop from the track record: dismiss the outcome (perf page only counts
  // target_hit/stop_hit/flat), so it leaves win-rate + avg calculations.
  const o = await db.execute({
    sql: `UPDATE signal_outcomes
          SET outcome='dismissed', outcome_at=?,
              notes=COALESCE(notes,'')||' [dismissed: sponsored/KOL source]'
          WHERE signal_id=? AND outcome IN ('target_hit','stop_hit','flat')`,
    args: [now, id],
  });
  outcomesDismissed += Number(o.rowsAffected);
  // Also remove from the live feed (unless already executed — leave a real
  // trade's record intact).
  if (s.status !== "executed") {
    const r = await db.execute({
      sql: `UPDATE signals SET status='dismissed', dismissed_at=?, dismiss_reason='user_dismissed'
            WHERE id=? AND status!='executed'`,
      args: [now, id],
    });
    signalsDismissed += Number(r.rowsAffected);
  }
}
console.log(`\nDismissed ${outcomesDismissed} outcomes (removed from track record) · ${signalsDismissed} signals (removed from feed)`);
process.exit(0);
