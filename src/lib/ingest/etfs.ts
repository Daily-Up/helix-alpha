/**
 * ETF ingest — pulls aggregate flows + per-fund history from SoSoValue.
 *
 * Two layers:
 *   • Aggregate per (symbol, country_code) — total inflows across all funds
 *   • Per-fund — for every ETF fund in the asset universe
 *
 * Date params are YYYY-MM-DD (the ETF endpoints' format), not ms.
 */

import { Assets, Cron, ETFFlows } from "@/lib/db";
import { ETFs, type ETFCountryCode, type ETFSupportedSymbol } from "@/lib/sosovalue";
import type { Asset } from "@/lib/universe";

export interface ETFIngestSummary {
  aggregates_processed: number;
  aggregates_failed: number;
  agg_rows_upserted: number;
  funds_processed: number;
  funds_failed: number;
  fund_rows_upserted: number;
  errors: Array<{ key: string; error: string }>;
  latency_ms: number;
}

export interface ETFIngestOptions {
  /** Limit of rows per call (default 30, max 300 per API). */
  limit?: number;
  delayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runETFIngest(
  opts: ETFIngestOptions = {},
): Promise<ETFIngestSummary> {
  const t0 = Date.now();
  const limit = Math.min(300, Math.max(1, opts.limit ?? 30));
  const delayMs = opts.delayMs ?? 600;

  const all = Assets.getAllAssets();
  const aggregates = all.filter((a): a is Asset => a.kind === "etf_aggregate");
  const funds = all.filter((a): a is Asset => a.kind === "etf_fund");

  let aggRows = 0;
  let aggFailed = 0;
  let fundRows = 0;
  let fundFailed = 0;
  const errors: ETFIngestSummary["errors"] = [];

  // ── Aggregates ─────────────────────────────────────────────────
  for (const a of aggregates) {
    if (a.sosovalue.kind !== "etf_aggregate") continue;
    const symbol = a.sosovalue.symbol as ETFSupportedSymbol;
    const country = a.sosovalue.country_code as ETFCountryCode;
    try {
      const rows = await ETFs.getETFSummaryHistory({
        symbol,
        country_code: country,
        limit,
      });
      aggRows += ETFFlows.upsertAggregateFlows(symbol, country, rows);
    } catch (err) {
      aggFailed++;
      errors.push({
        key: `agg:${symbol}-${country}`,
        error: (err as Error).message ?? String(err),
      });
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  // ── Per-fund history ───────────────────────────────────────────
  for (const f of funds) {
    if (f.sosovalue.kind !== "etf_fund") continue;
    const ticker = f.sosovalue.ticker;
    try {
      const rows = await ETFs.getETFHistory(ticker, { limit });
      fundRows += ETFFlows.upsertFundFlows(rows);
    } catch (err) {
      fundFailed++;
      errors.push({
        key: `fund:${ticker}`,
        error: (err as Error).message ?? String(err),
      });
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  return {
    aggregates_processed: aggregates.length,
    aggregates_failed: aggFailed,
    agg_rows_upserted: aggRows,
    funds_processed: funds.length,
    funds_failed: fundFailed,
    fund_rows_upserted: fundRows,
    errors,
    latency_ms: Date.now() - t0,
  };
}

export async function runETFIngestWithAudit(
  opts: ETFIngestOptions = {},
): Promise<ETFIngestSummary & { run_id: number }> {
  const { id, data } = await Cron.recordRun("ingest_etf_aggregate", async () => {
    const summary = await runETFIngest(opts);
    const text =
      `aggs=${summary.aggregates_processed} (${summary.agg_rows_upserted} rows) ` +
      `funds=${summary.funds_processed} (${summary.fund_rows_upserted} rows) ` +
      `failed=${summary.aggregates_failed + summary.funds_failed}`;
    return { summary: text, data: summary };
  });
  return { ...(data as ETFIngestSummary), run_id: id };
}
