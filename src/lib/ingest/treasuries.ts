/**
 * BTC Treasuries ingest.
 *
 *   1. Pull /btc-treasuries → upsert ~56 companies
 *   2. For each company → /btc-treasuries/{ticker}/purchase-history
 *      → upsert each dated event into btc_treasury_purchases
 *
 * Idempotent on (ticker, date). Safe to run hourly. Throttles between
 * per-company calls so the 20 req/min rate limit isn't hit even with a
 * concurrent news ingest.
 *
 * Cost-per-BTC is derived as `acq_cost / btc_acq` rather than relying on
 * the API's `avg_btc_cost` field, which we observed to be unreliable
 * (always 0.09 / 0.10 for MSTR, regardless of actual price).
 */

import { Cron, Treasuries } from "@/lib/db";
import { Treasuries as TreasuriesAPI } from "@/lib/sosovalue";

export interface TreasuriesIngestSummary {
  companies_processed: number;
  companies_new: number;
  companies_failed: number;
  purchases_upserted: number;
  errors: Array<{ ticker: string; error: string }>;
  latency_ms: number;
}

export interface TreasuriesIngestOptions {
  /** Throttle between per-company calls (ms). Default 600ms. */
  delayMs?: number;
  /** Only sync companies whose ticker is in this list (for testing). */
  onlyTickers?: string[];
  /** Cap purchases pulled per company. API caps at 50 per page. */
  pageSize?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runTreasuriesIngest(
  opts: TreasuriesIngestOptions = {},
): Promise<TreasuriesIngestSummary> {
  const t0 = Date.now();
  const delayMs = opts.delayMs ?? 600;
  const pageSize = opts.pageSize ?? 50;

  // ── 1. Company list ────────────────────────────────────────────
  const list = await TreasuriesAPI.getBTCTreasuries();
  const filtered = opts.onlyTickers
    ? list.filter((c) => opts.onlyTickers!.includes(c.ticker))
    : list;

  let companiesNew = 0;
  let companiesFailed = 0;
  let purchasesUpserted = 0;
  const errors: TreasuriesIngestSummary["errors"] = [];

  // Detect newly-tracked companies for the summary.
  const existingTickers = new Set(
    Treasuries.listCompanies().map((c) => c.ticker),
  );

  for (const company of filtered) {
    if (!existingTickers.has(company.ticker)) companiesNew++;
    Treasuries.upsertCompany({
      ticker: company.ticker,
      name: company.name,
      list_location: company.list_location ?? null,
    });
  }

  // ── 2. Per-company purchase history ────────────────────────────
  for (const company of filtered) {
    try {
      const purchases = await TreasuriesAPI.getBTCPurchaseHistory(
        company.ticker,
        { page: 1, page_size: pageSize },
      );

      for (const p of purchases) {
        const btcAcq = Number(p.btc_acq);
        const btcHolding = Number(p.btc_holding);
        const acqCost =
          p.acq_cost != null && p.acq_cost !== "" ? Number(p.acq_cost) : null;

        // Skip rows where the core numbers don't parse — avoid
        // corrupting the table with NaN holdings.
        if (!Number.isFinite(btcAcq) || !Number.isFinite(btcHolding)) continue;

        // Derive cost-per-BTC ourselves (the API's avg_btc_cost is unreliable).
        const derivedCost =
          acqCost != null && Number.isFinite(acqCost) && btcAcq !== 0
            ? acqCost / btcAcq
            : null;

        Treasuries.upsertPurchase({
          ticker: company.ticker,
          date: p.date,
          btc_holding: btcHolding,
          btc_acq: btcAcq,
          acq_cost_usd: acqCost,
          avg_btc_cost_usd: derivedCost,
        });
        purchasesUpserted++;
      }
    } catch (err) {
      companiesFailed++;
      errors.push({
        ticker: company.ticker,
        error: (err as Error).message ?? String(err),
      });
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  return {
    companies_processed: filtered.length,
    companies_new: companiesNew,
    companies_failed: companiesFailed,
    purchases_upserted: purchasesUpserted,
    errors,
    latency_ms: Date.now() - t0,
  };
}

export async function runTreasuriesIngestWithAudit(
  opts: TreasuriesIngestOptions = {},
): Promise<TreasuriesIngestSummary & { run_id: number }> {
  const { id, data } = await Cron.recordRun(
    "ingest_btc_treasuries",
    async () => {
      const summary = await runTreasuriesIngest(opts);
      const text =
        `companies=${summary.companies_processed} ` +
        `(new=${summary.companies_new}, failed=${summary.companies_failed}) ` +
        `purchases=${summary.purchases_upserted} ` +
        `latency=${(summary.latency_ms / 1000).toFixed(1)}s`;
      return { summary: text, data: summary };
    },
  );
  return { ...(data as TreasuriesIngestSummary), run_id: id };
}
