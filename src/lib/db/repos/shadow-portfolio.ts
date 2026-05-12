/**
 * Repository — `shadow_portfolio` (Part 2 of v2.1 attribution).
 *
 * Tracks a virtual NAV/cash ledger for the non-active framework so we
 * can run both v1 and v2.1 paper-traded in parallel. Positions are
 * not persisted (recomputed each cycle from the most recent rebalance
 * row's new_weights × current NAV ÷ price). Only NAV + cash are
 * stored, plus housekeeping timestamps.
 */

import { db } from "../client";

export interface ShadowPortfolioRow {
  framework_version: "v1" | "v2";
  nav_usd: number;
  cash_usd: number;
  last_rebalance_at: string | null;
  started_at: string;
}

export function getShadow(framework: "v1" | "v2"): ShadowPortfolioRow | null {
  const r = db()
    .prepare<[string], ShadowPortfolioRow>(
      `SELECT framework_version, nav_usd, cash_usd, last_rebalance_at, started_at
       FROM shadow_portfolio WHERE framework_version = ?`,
    )
    .get(framework);
  return r ?? null;
}

export function listShadows(): ShadowPortfolioRow[] {
  return db()
    .prepare<[], ShadowPortfolioRow>(
      `SELECT framework_version, nav_usd, cash_usd, last_rebalance_at, started_at
       FROM shadow_portfolio ORDER BY framework_version`,
    )
    .all();
}

/**
 * Update a shadow framework's NAV + cash. Idempotent on
 * (framework_version) — we keep one row per framework.
 */
export function updateShadow(
  framework: "v1" | "v2",
  nav_usd: number,
  cash_usd: number,
  last_rebalance_at?: string,
): void {
  db()
    .prepare(
      `INSERT INTO shadow_portfolio
         (framework_version, nav_usd, cash_usd, last_rebalance_at, started_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(framework_version) DO UPDATE SET
         nav_usd = excluded.nav_usd,
         cash_usd = excluded.cash_usd,
         last_rebalance_at = excluded.last_rebalance_at`,
    )
    .run(framework, nav_usd, cash_usd, last_rebalance_at ?? null);
}

/** Seed both frameworks at the given starting NAV (idempotent). */
export function ensureShadowsSeeded(starting_nav: number): void {
  for (const fw of ["v1", "v2"] as const) {
    db()
      .prepare(
        `INSERT OR IGNORE INTO shadow_portfolio
           (framework_version, nav_usd, cash_usd, started_at)
         VALUES (?, ?, ?, datetime('now'))`,
      )
      .run(fw, starting_nav, starting_nav);
  }
}
