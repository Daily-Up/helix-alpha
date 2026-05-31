/**
 * Repository — `shadow_portfolio`. Wave 2: async.
 */

import { all, get, run } from "../client";

export interface ShadowPortfolioRow {
  framework_version: "v1" | "v2";
  nav_usd: number;
  cash_usd: number;
  last_rebalance_at: string | null;
  started_at: string;
}

export async function getShadow(
  framework: "v1" | "v2",
): Promise<ShadowPortfolioRow | null> {
  const r = await get<ShadowPortfolioRow>(
    `SELECT framework_version, nav_usd, cash_usd, last_rebalance_at, started_at
     FROM shadow_portfolio WHERE framework_version = ?`,
    [framework],
  );
  return r ?? null;
}

export async function listShadows(): Promise<ShadowPortfolioRow[]> {
  return all<ShadowPortfolioRow>(
    `SELECT framework_version, nav_usd, cash_usd, last_rebalance_at, started_at
     FROM shadow_portfolio ORDER BY framework_version`,
  );
}

export async function updateShadow(
  framework: "v1" | "v2",
  nav_usd: number,
  cash_usd: number,
  last_rebalance_at?: string,
): Promise<void> {
  await run(
    `INSERT INTO shadow_portfolio
       (framework_version, nav_usd, cash_usd, last_rebalance_at, started_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(framework_version) DO UPDATE SET
       nav_usd = excluded.nav_usd,
       cash_usd = excluded.cash_usd,
       last_rebalance_at = excluded.last_rebalance_at`,
    [framework, nav_usd, cash_usd, last_rebalance_at ?? null],
  );
}

export async function ensureShadowsSeeded(starting_nav: number): Promise<void> {
  for (const fw of ["v1", "v2"] as const) {
    await run(
      `INSERT OR IGNORE INTO shadow_portfolio
         (framework_version, nav_usd, cash_usd, started_at)
       VALUES (?, ?, ?, datetime('now'))`,
      [fw, starting_nav, starting_nav],
    );
  }
}
