/**
 * Inspect SoDEX mainnet — what's tradable and what's the real shape?
 *
 *   npm run inspect:sodex
 *
 * Public market endpoints don't need auth, so we just GET them.
 */

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

const SPOT_BASE =
  process.env.SODEX_SPOT_REST_URL ?? "https://mainnet-gw.sodex.dev/api/v1/spot";

async function rawGet(path: string, query: Record<string, string> = {}) {
  const qs = new URLSearchParams(query).toString();
  const url = `${SPOT_BASE}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function main() {
  console.log(`SoDEX spot base: ${SPOT_BASE}\n`);

  // 1) /markets/symbols — what's tradable
  console.log("══ GET /markets/symbols ══");
  const symbols = await rawGet("/markets/symbols");
  console.log("status:", symbols.status);
  type SymRow = {
    name: string;
    displayName: string;
    baseCoin: string;
    quoteCoin: string;
    status: string;
  };
  if (symbols.body && typeof symbols.body === "object") {
    const data =
      "data" in symbols.body
        ? (symbols.body as { data: unknown }).data
        : symbols.body;
    if (Array.isArray(data)) {
      console.log(`total symbols: ${data.length}\n`);
      console.log(
        "PAIR".padEnd(22) +
          " DISPLAY".padEnd(14) +
          " BASE".padEnd(10) +
          " STATUS",
      );
      console.log("─".repeat(60));
      for (const row of data as SymRow[]) {
        console.log(
          `${row.name.padEnd(22)} ${row.displayName.padEnd(14)} ${row.baseCoin.padEnd(10)} ${row.status}`,
        );
      }
      // Highlight any SSI symbols
      const ssi = (data as SymRow[]).filter(
        (r) =>
          r.name.toLowerCase().includes("ssi") ||
          r.baseCoin.toLowerCase().includes("ssi") ||
          r.displayName.toLowerCase().includes("ssi") ||
          r.displayName.toLowerCase().includes("mag7") ||
          r.displayName.toLowerCase().includes("defi") ||
          r.displayName.toLowerCase().includes("meme"),
      );
      console.log(`\nSSI / index-like pairs: ${ssi.length}`);
      for (const r of ssi)
        console.log(`  ${r.name} (${r.displayName}) [${r.status}]`);
    }
  }

  // 2) /markets/coins — coins universe
  console.log("\n══ GET /markets/coins ══");
  const coins = await rawGet("/markets/coins");
  console.log("status:", coins.status);
  if (coins.body && typeof coins.body === "object") {
    const data =
      "data" in coins.body
        ? (coins.body as { data: unknown }).data
        : coins.body;
    if (Array.isArray(data)) {
      console.log(`total coins: ${data.length}`);
      const names = (data as Array<{ name: string }>).map((c) => c.name);
      console.log(`all coins: ${names.join(", ")}`);
    }
  }

  // 3) /markets/tickers — current prices
  console.log("\n══ GET /markets/tickers ══");
  const tickers = await rawGet("/markets/tickers");
  console.log("status:", tickers.status);
  type TickerRow = {
    symbol: string;
    lastPx: string;
    changePct: number;
    quoteVolume: string;
  };
  if (tickers.body && typeof tickers.body === "object") {
    const data =
      "data" in tickers.body
        ? (tickers.body as { data: unknown }).data
        : tickers.body;
    if (Array.isArray(data)) {
      console.log(`total tickers: ${data.length}\n`);
      console.log(
        "SYMBOL".padEnd(22) +
          " LAST".padStart(12) +
          " 24h%".padStart(8) +
          " 24h vol(USDC)".padStart(18),
      );
      console.log("─".repeat(60));
      const sorted = [...(data as TickerRow[])].sort(
        (a, b) => Number(b.quoteVolume) - Number(a.quoteVolume),
      );
      for (const t of sorted) {
        const px = Number(t.lastPx);
        const pct = Number(t.changePct);
        const vol = Number(t.quoteVolume);
        console.log(
          `${t.symbol.padEnd(22)} ${px.toFixed(4).padStart(12)} ${pct.toFixed(2).padStart(7)}% ${vol.toLocaleString().padStart(17)}`,
        );
      }
    }
  }

  // 4) Try a candle for one symbol if we found one
  if (symbols.body && typeof symbols.body === "object") {
    const data =
      "data" in symbols.body
        ? (symbols.body as { data: Array<{ symbol?: string }> }).data
        : null;
    const first = data?.[0]?.symbol;
    if (first) {
      console.log(`\n══ GET /markets/candles?symbol=${first}&interval=1d ══`);
      const candles = await rawGet("/markets/candles", {
        symbol: first,
        interval: "1d",
        limit: "3",
      });
      console.log("status:", candles.status);
      console.log(JSON.stringify(candles.body, null, 2)?.slice(0, 800));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
