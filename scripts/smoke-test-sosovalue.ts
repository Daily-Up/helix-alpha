/**
 * Comprehensive smoke test for the SoSoValue API client.
 *
 * Run from the project root:
 *   npm run smoke:sosovalue
 *
 * Read-only — writes nothing. Verifies every endpoint we depend on,
 * using the real (docs-verified) param names + response shapes.
 */

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

async function main() {
  const sv = await import("../src/lib/sosovalue");
  const {
    Currencies,
    News,
    ETFs,
    Indices,
    CryptoStocks,
    Sector,
    Macro,
    Treasuries,
    toMs,
  } = sv;

  // ── 1. Currencies ───────────────────────────────────────────────
  console.log("→ /currencies");
  const currencies = await Currencies.getCurrencies();
  console.log(`  ✓ ${currencies.length} currencies`);
  const btc = currencies.find((c) => c.symbol?.toLowerCase() === "btc");
  if (!btc) throw new Error("BTC not found in /currencies");
  console.log(
    `  BTC → currency_id=${btc.currency_id} symbol=${btc.symbol} name=${btc.name}`,
  );

  // ── 2. News feed ────────────────────────────────────────────────
  console.log("→ /news (last 24h, 5 items)");
  const news = await News.getNews({
    language: "en",
    page: 1,
    page_size: 5,
    start_time: Date.now() - 24 * 60 * 60 * 1000,
    end_time: Date.now(),
  });
  console.log(`  ✓ total=${news.total}, returned=${news.list.length}`);
  for (const item of news.list.slice(0, 3)) {
    const ts = new Date(toMs(item.release_time)).toISOString();
    const cur =
      (item.matched_currencies ?? []).map((c) => c.symbol).join(",") || "-";
    console.log(`  • [${ts}] (${cur}) ${item.title.slice(0, 80)}`);
  }

  // ── 3. News search (no 7-day limit) ─────────────────────────────
  console.log("→ /news/search keyword='ETF'");
  const search = await News.searchNews({ keyword: "ETF", page_size: 3 });
  console.log(`  ✓ total=${search.total}, returned=${search.list.length}`);

  // ── 4. Daily klines ─────────────────────────────────────────────
  console.log(`→ /currencies/${btc.currency_id}/klines (14d daily)`);
  const klines = await Currencies.getDailyKlines(btc.currency_id, 14);
  console.log(`  ✓ ${klines.length} candles`);
  if (klines.length) {
    const last = klines[klines.length - 1];
    console.log(
      `  last → ${new Date(toMs(last.timestamp)).toISOString().slice(0, 10)} close=$${last.close}`,
    );
  }

  // ── 5. ETF list (correct params: symbol + country_code) ─────────
  console.log("→ /etfs symbol=BTC country_code=US");
  const btcEtfs = await ETFs.getETFs({ symbol: "BTC", country_code: "US" });
  console.log(`  ✓ ${btcEtfs.length} BTC ETFs`);
  for (const e of btcEtfs.slice(0, 5)) {
    console.log(`  • ${e.ticker.padEnd(6)} ${e.exchange.padEnd(8)} ${e.name}`);
  }

  // ── 6. ETF aggregate history ────────────────────────────────────
  console.log("→ /etfs/summary-history symbol=BTC country_code=US (limit=10)");
  const btcAgg = await ETFs.getETFSummaryHistory({
    symbol: "BTC",
    country_code: "US",
    limit: 10,
  });
  console.log(`  ✓ ${btcAgg.length} aggregate rows`);
  for (const row of btcAgg.slice(0, 3)) {
    const inflow =
      typeof row.total_net_inflow === "number"
        ? `$${(row.total_net_inflow / 1e6).toFixed(1)}M`
        : "?";
    const aum =
      typeof row.total_net_assets === "number"
        ? `$${(row.total_net_assets / 1e9).toFixed(2)}B`
        : "?";
    console.log(`  • ${row.date}  inflow=${inflow}  aum=${aum}`);
  }

  // ── 7. Per-fund snapshot ────────────────────────────────────────
  console.log("→ /etfs/IBIT/market-snapshot");
  const ibit = await ETFs.getETFMarketSnapshot("IBIT");
  console.log(
    `  ✓ IBIT ${ibit.date}  inflow=$${(ibit.net_inflow ?? 0).toLocaleString()}  AUM=$${((ibit.net_assets ?? 0) / 1e9).toFixed(2)}B`,
  );

  // ── 8. Indices ──────────────────────────────────────────────────
  console.log("→ /indices");
  const indices = await Indices.getIndices();
  console.log(`  ✓ ${indices.length} indexes: ${indices.slice(0, 6).join(", ")}...`);

  if (indices.length) {
    const t = indices[0];
    console.log(`→ /indices/${t}/market-snapshot`);
    const snap = await Indices.getIndexMarketSnapshot(t);
    const change24 = snap["24h_change_pct"];
    console.log(
      `  ✓ ${t} price=${snap.price ?? "?"} 24h=${change24 !== undefined ? (change24 * 100).toFixed(2) + "%" : "?"}`,
    );
  }

  // ── 9. Crypto stocks ────────────────────────────────────────────
  console.log("→ /crypto-stocks");
  const stocks = await CryptoStocks.getCryptoStocks();
  console.log(`  ✓ ${stocks.length} stocks`);
  const mstr = stocks.find((s) => s.ticker === "MSTR");
  if (mstr) console.log(`  MSTR → ${mstr.name} (${mstr.exchange}, ${mstr.sector})`);

  // ── 10. Sector spotlight ────────────────────────────────────────
  console.log("→ /currencies/sector-spotlight");
  const sectorData = await Sector.getSectorSpotlight();
  const sectors = sectorData.sector ?? [];
  const top = [...sectors]
    .sort((a, b) => (b.change_pct_24h ?? 0) - (a.change_pct_24h ?? 0))
    .slice(0, 3);
  for (const s of top) {
    console.log(
      `  ${s.name.padEnd(12)} 24h=${(s.change_pct_24h * 100).toFixed(2)}%  dom=${(s.marketcap_dom * 100).toFixed(2)}%`,
    );
  }

  // ── 11. Macro calendar ──────────────────────────────────────────
  console.log("→ /macro/events");
  const cal = await Macro.getMacroCalendar();
  console.log(`  ✓ ${cal.length} calendar days`);
  for (const d of cal.slice(0, 3)) {
    console.log(`  • ${d.date}  ${d.events.join(", ")}`);
  }

  // ── 12. BTC treasuries ──────────────────────────────────────────
  console.log("→ /btc-treasuries");
  try {
    const tres = await Treasuries.getBTCTreasuries();
    console.log(`  ✓ ${tres.length} treasury companies`);
    for (const c of tres.slice(0, 3)) {
      console.log(`  • ${c.ticker.padEnd(6)} ${c.name}`);
    }
  } catch (err) {
    console.log(`  ✗ ${(err as Error).message.slice(0, 120)}`);
  }

  console.log("\n✅ Full smoke test complete.");
}

main().catch((err) => {
  console.error("\n✗ Smoke test failed:");
  console.error(err);
  process.exit(1);
});
