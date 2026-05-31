# scripts/

One-off operational utilities — data backfills, diagnostics, repairs.

## Wave 2 status

Excluded from `tsconfig.json` typechecking. These scripts were written
against the Wave 1 `better-sqlite3` API and have not been ported to the
Wave 2 async libSQL API. They no longer compile, but **most have already
served their purpose** (one-shot backfills) so the cost of porting them
exceeds the value.

### Still useful (Wave 2 port candidates if needed again)

- `db-stats.ts` — quick read-only DB summary
- `force-resolve-outcomes.ts` — operational, advance clock + resolve
- `demo-clean.ts` — demo prep / queue cleanup
- `reclassify.ts` — re-classify events under a new prompt version

### One-shot, already ran in production

- `backfill-news.ts`, `backfill-klines.ts`, `backfill-outcomes.ts`,
  `backfill-significance.ts`, `backfill-shadow*` — historical seeds
- `repair-phantom-supersessions.ts`, `repair-uncorroborated-sweep.ts` —
  bug-cleanup migrations
- `dedup-pending-signals.ts`, `skip-backlog.ts` — one-time queue actions

### Diagnostics (kept for reference; not maintained)

- `inspect-*.ts` — explore SoSoValue API surfaces
- `debug-*.ts` — investigate specific bug classes
- `test-*.ts` — ad-hoc smoke tests against external APIs
- `verify-backfill.ts`, `validate-corpus.ts`, `measure-dupes.ts`,
  `calibrate-base-rates.ts`, `v2-acceptance-run.ts`

## Active scripts (Wave 2 native)

- `turso-migrate.mjs` — local SQLite → Turso data migration
- `turso-ping.mjs` — Turso connectivity sanity check
- `capture-landing-screenshots.mjs` — Playwright landing-page captures

These are `.mjs` and not subject to TS typechecking either.
