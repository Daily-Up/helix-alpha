/**
 * One-time repair for phantom-superseded signals.
 *
 * Diagnosis: pre-fix, the signal generator called Signals.markSuperseded
 * BEFORE the pre-save invariant gate. When the gate refused the
 * candidate new signal, the supersession of the prior signal still
 * persisted — leaving signals marked status='expired' (or 'superseded'
 * after the semantic fix) with `reasoning` prefixed `Superseded by
 * signal {uuid}.` where that {uuid} was never inserted into the signals
 * table.
 *
 * This script finds those orphan supersessions and reverts the affected
 * signals to status='pending', clearing the phantom reasoning prefix.
 *
 * Safe to re-run — idempotent. Only touches rows whose superseder UUID
 * fails the existence check.
 *
 * Usage: SOSOVALUE_API_KEY=x ANTHROPIC_API_KEY=x npx tsx scripts/repair-phantom-supersessions.ts
 */

import { db } from "../src/lib/db";

interface Candidate {
  id: string;
  status: string;
  reasoning: string;
  expires_at: number | null;
}

// Find signals whose reasoning references a superseding UUID.
const candidates = db()
  .prepare<[], Candidate>(
    `SELECT id, status, reasoning, expires_at
     FROM signals
     WHERE reasoning LIKE 'Superseded by signal %'
       AND status IN ('expired', 'superseded')`,
  )
  .all();

console.log(`[repair] ${candidates.length} candidate rows to inspect.`);

const checkExists = db().prepare<[string], { n: number }>(
  `SELECT COUNT(*) AS n FROM signals WHERE id = ?`,
);

const update = db().prepare(
  `UPDATE signals
     SET status = 'pending',
         reasoning = ?,
         superseded_by_signal_id = NULL,
         effective_end_at = NULL,
         dismissed_at = NULL
   WHERE id = ?`,
);

let repaired = 0;
const restored: Array<{ id: string; supersederId: string }> = [];

for (const c of candidates) {
  // Pull the UUID out of "Superseded by signal {uuid}. ..."
  const m = c.reasoning.match(/^Superseded by signal ([a-f0-9-]{36})\. ([\s\S]*)/);
  if (!m) continue;
  const supersederId = m[1]!;
  const cleanedReasoning = m[2]!;

  const exists = (checkExists.get(supersederId)?.n ?? 0) > 0;
  if (exists) continue; // genuine supersession, leave it alone

  // Phantom — the superseder UUID was never inserted. Also verify the
  // signal's window is still open before restoring; we don't want to
  // bring back an event whose horizon has genuinely elapsed.
  const now = Date.now();
  if (c.expires_at != null && c.expires_at < now) {
    console.log(
      `[repair] ${c.id} phantom but window elapsed (expires=${new Date(c.expires_at).toISOString()}), leaving status=expired (was the right call by accident)`,
    );
    continue;
  }

  update.run(cleanedReasoning, c.id);
  repaired++;
  restored.push({ id: c.id, supersederId });
}

console.log(`[repair] restored ${repaired} signal(s) from phantom supersession.`);
for (const r of restored) {
  console.log(`  - ${r.id} (was marked superseded by ${r.supersederId.slice(0, 8)}…, which doesn't exist)`);
}
