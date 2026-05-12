/**
 * Repository — `btc_treasury_companies`, `btc_treasury_purchases`.
 *
 * Mirrors the SoSoValue /btc-treasuries surface. The purchase ledger
 * is the high-leverage data: dated, named-quantity BTC accumulation
 * events that drive corporate-treasury news. Feeds the Daily Briefing.
 */

import { db } from "../client";

export interface TreasuryCompanyRow {
  ticker: string;
  name: string;
  list_location: string | null;
  last_synced_at: number;
}

export interface TreasuryPurchaseRow {
  ticker: string;
  /** YYYY-MM-DD UTC. */
  date: string;
  /** Total BTC holdings AFTER this transaction. */
  btc_holding: number;
  /** BTC acquired this transaction (negative = disposed). */
  btc_acq: number;
  /** USD spent — null when not disclosed. */
  acq_cost_usd: number | null;
  /** Derived cost per BTC — null when amount or cost missing. */
  avg_btc_cost_usd: number | null;
  ingested_at: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Companies
// ─────────────────────────────────────────────────────────────────────────

export function upsertCompany(c: {
  ticker: string;
  name: string;
  list_location?: string | null;
}): void {
  db()
    .prepare(
      `INSERT INTO btc_treasury_companies (ticker, name, list_location, last_synced_at)
       VALUES (?, ?, ?, unixepoch() * 1000)
       ON CONFLICT(ticker) DO UPDATE SET
         name           = excluded.name,
         list_location  = excluded.list_location,
         last_synced_at = excluded.last_synced_at`,
    )
    .run(c.ticker, c.name, c.list_location ?? null);
}

export function listCompanies(): TreasuryCompanyRow[] {
  return db()
    .prepare<[], TreasuryCompanyRow>(
      `SELECT * FROM btc_treasury_companies ORDER BY ticker`,
    )
    .all();
}

export function countCompanies(): number {
  const r = db()
    .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM btc_treasury_companies`)
    .get();
  return r?.n ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────
// Purchases
// ─────────────────────────────────────────────────────────────────────────

export function upsertPurchase(p: {
  ticker: string;
  date: string;
  btc_holding: number;
  btc_acq: number;
  acq_cost_usd: number | null;
  avg_btc_cost_usd: number | null;
}): void {
  db()
    .prepare(
      `INSERT INTO btc_treasury_purchases
         (ticker, date, btc_holding, btc_acq, acq_cost_usd, avg_btc_cost_usd, ingested_at)
       VALUES (@ticker, @date, @btc_holding, @btc_acq, @acq_cost_usd, @avg_btc_cost_usd, unixepoch() * 1000)
       ON CONFLICT(ticker, date) DO UPDATE SET
         btc_holding      = excluded.btc_holding,
         btc_acq          = excluded.btc_acq,
         acq_cost_usd     = excluded.acq_cost_usd,
         avg_btc_cost_usd = excluded.avg_btc_cost_usd,
         ingested_at      = excluded.ingested_at`,
    )
    .run(p);
}

/** Recent purchases across all companies, newest-first. */
export function listRecentPurchases(opts: {
  /** Max events to return. */
  limit?: number;
  /** Only events from the last N days. */
  daysBack?: number;
  /** Filter to a specific ticker. */
  ticker?: string;
} = {}): Array<TreasuryPurchaseRow & { company_name: string }> {
  const limit = opts.limit ?? 30;
  const params: Array<string | number> = [];
  const where: string[] = [];

  if (opts.daysBack != null) {
    const cutoff = new Date(Date.now() - opts.daysBack * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    where.push("p.date >= ?");
    params.push(cutoff);
  }
  if (opts.ticker) {
    where.push("p.ticker = ?");
    params.push(opts.ticker);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit);

  return db()
    .prepare<typeof params, TreasuryPurchaseRow & { company_name: string }>(
      `SELECT p.*, c.name AS company_name
       FROM btc_treasury_purchases p
       LEFT JOIN btc_treasury_companies c ON c.ticker = p.ticker
       ${whereSql}
       ORDER BY p.date DESC, p.ticker
       LIMIT ?`,
    )
    .all(...params);
}

/** Aggregate stats for the dashboard / briefing input. */
export function getAggregateStats(daysBack = 30): {
  total_companies: number;
  acquiring_companies_30d: number;
  net_btc_acquired_30d: number;
  total_btc_held_latest: number;
  total_acq_cost_30d_usd: number | null;
} {
  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const totalCompanies = countCompanies();

  interface AggRow {
    n_acquiring: number;
    net_btc: number;
    total_cost: number | null;
  }
  const agg = db()
    .prepare<[string], AggRow>(
      `SELECT
         COUNT(DISTINCT ticker) AS n_acquiring,
         SUM(btc_acq) AS net_btc,
         SUM(acq_cost_usd) AS total_cost
       FROM btc_treasury_purchases
       WHERE date >= ?`,
    )
    .get(cutoff);

  // Latest snapshot of total holdings — sum each ticker's most recent
  // btc_holding row.
  interface LatestRow {
    total_held: number;
  }
  const latest = db()
    .prepare<[], LatestRow>(
      `SELECT SUM(btc_holding) AS total_held
       FROM (
         SELECT btc_holding,
                ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
         FROM btc_treasury_purchases
       )
       WHERE rn = 1`,
    )
    .get();

  return {
    total_companies: totalCompanies,
    acquiring_companies_30d: agg?.n_acquiring ?? 0,
    net_btc_acquired_30d: agg?.net_btc ?? 0,
    total_btc_held_latest: latest?.total_held ?? 0,
    total_acq_cost_30d_usd: agg?.total_cost ?? null,
  };
}
