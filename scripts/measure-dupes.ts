/**
 * Measure duplicate rate in classified news_events to quantify how
 * much Claude spend has been burned on dups.
 *
 * Heuristic: normalize title (lowercase, strip punctuation, split into
 * tokens, drop common stopwords), then group by token-set Jaccard
 * similarity. Two events are considered "duplicates" if their token
 * sets overlap by ≥60% AND they share at least one matched currency
 * AND they're within 48h of each other.
 *
 * Run:
 *   npx tsx scripts/measure-dupes.ts
 */

import { config } from "dotenv";
import { resolve } from "node:path";
import Database from "better-sqlite3";

config({ path: resolve(process.cwd(), ".env.local") });

// Bypass the env validator (which requires ANTHROPIC_API_KEY) — this
// script only reads the DB.
const dbPath = resolve(
  process.cwd(),
  process.env.DATABASE_PATH ?? "./data/sosoalpha.db",
);
const conn = new Database(dbPath, { readonly: true });
const db = () => conn;

const STOPWORDS = new Set([
  "the","a","an","is","are","was","were","be","been","being",
  "of","to","in","on","at","by","for","with","as","from","about",
  "and","or","but","not","this","that","these","those","it","its",
  "has","have","had","do","does","did","will","would","could","should",
  "after","before","over","under","up","down","out","off","into","onto",
  "new","now","just","new","says","said","reports","reported","reportedly",
  "via","using","launched","announces","announced","announcement","launch",
  "team","group","ltd","inc","corp","co","sa","plc",
]);

function normalizeTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/<[^>]+>/g, " ") // strip HTML
      .replace(/[^a-z0-9$\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

interface Row {
  id: string;
  release_time: number;
  title: string;
  matched_currencies: string;
}

const rows = db()
  .prepare<[], Row>(
    `SELECT e.id, e.release_time, e.title, e.matched_currencies
     FROM news_events e
     INNER JOIN classifications c ON c.event_id = e.id
     ORDER BY e.release_time DESC`,
  )
  .all();

console.log(`Analyzing ${rows.length} classified events...`);

interface Enriched {
  id: string;
  release_time: number;
  title: string;
  tokens: Set<string>;
  currencies: Set<string>;
}

const enriched: Enriched[] = rows.map((r) => {
  const mc = JSON.parse(r.matched_currencies || "[]") as Array<{ currency_id: string }>;
  return {
    id: r.id,
    release_time: r.release_time,
    title: r.title.slice(0, 200),
    tokens: normalizeTokens(r.title),
    currencies: new Set(mc.map((c) => c.currency_id)),
  };
});

// Sliding window: for each event, compare to previous events within 48h.
// If ≥60% Jaccard AND share ≥1 currency, mark as duplicate.
const WINDOW_MS = 48 * 60 * 60 * 1000;
const SIMILARITY_THRESHOLD = 0.6;

const isDup: Set<string> = new Set();
const dupGroups: Map<string, string[]> = new Map(); // canonical -> [dups]

for (let i = 0; i < enriched.length; i++) {
  const a = enriched[i];
  if (isDup.has(a.id)) continue;
  const groupMembers: string[] = [];
  for (let j = i + 1; j < enriched.length; j++) {
    const b = enriched[j];
    if (isDup.has(b.id)) continue;
    if (a.release_time - b.release_time > WINDOW_MS) break;
    // Currency overlap (allow if neither side has currencies — pure-text dup)
    const sharedCcy =
      a.currencies.size === 0 || b.currencies.size === 0
        ? true
        : [...a.currencies].some((c) => b.currencies.has(c));
    if (!sharedCcy) continue;
    const sim = jaccard(a.tokens, b.tokens);
    if (sim >= SIMILARITY_THRESHOLD) {
      isDup.add(b.id);
      groupMembers.push(b.id);
    }
  }
  if (groupMembers.length > 0) {
    dupGroups.set(a.id, groupMembers);
  }
}

const totalDups = isDup.size;
const dupPct = (totalDups / rows.length) * 100;

console.log(`\nTotal classified events:        ${rows.length}`);
console.log(`Detected duplicates:            ${totalDups} (${dupPct.toFixed(1)}%)`);
console.log(`Estimated wasted classifications: ${totalDups}`);

// Sonnet 4.5 pricing: ~$0.003 per classification (approx, depends on title length)
const ESTIMATED_COST_PER_CLASSIFICATION = 0.003;
console.log(
  `Estimated wasted Claude spend:  $${(totalDups * ESTIMATED_COST_PER_CLASSIFICATION).toFixed(2)}`,
);

console.log(`\nTop duplicate clusters (canonical → # of dups):`);
const sortedGroups = [...dupGroups.entries()]
  .sort((a, b) => b[1].length - a[1].length)
  .slice(0, 10);
for (const [canonId, dups] of sortedGroups) {
  const canon = enriched.find((e) => e.id === canonId)!;
  console.log(`\n  [${dups.length + 1}x] ${canon.title.slice(0, 100)}`);
  for (const dupId of dups.slice(0, 3)) {
    const dup = enriched.find((e) => e.id === dupId)!;
    console.log(`     ↳ ${dup.title.slice(0, 100)}`);
  }
  if (dups.length > 3) console.log(`     ↳ … and ${dups.length - 3} more`);
}
