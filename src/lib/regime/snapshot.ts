/**
 * Live market-context snapshot.
 *
 * Composes the BTC / ETH / SOL regime triplet into a compact
 * markdown blob used in two places:
 *
 *   1. **Agent system prompts** — prepended to research / verification
 *      / debate so the agent knows the tape from the first token, no
 *      tool call needed. Cuts an entire round trip on every run AND
 *      means a brand-new conversation starts with the correct context.
 *
 *   2. **UI Market Pulse ribbon** — same data rendered as a persistent
 *      header on /agents and /signal/[id] so the user always sees what
 *      the agent saw.
 *
 * The shape is intentionally small (5 lines) so it adds minimal token
 * pressure to the agent's system prompt cache.
 */

import { getRegime, type RegimeSnapshot } from "./classifier";

const SYMBOLS = ["BTC", "ETH", "SOL"] as const;

export interface MarketPulse {
  computed_at: number;
  rows: Array<RegimeSnapshot | { symbol: string; missing: true }>;
}

/** Pull the trio in parallel. Each lookup runs ~50ms against Turso. */
export async function getMarketPulse(at?: number): Promise<MarketPulse> {
  const ts = at ?? Date.now();
  const rows = await Promise.all(
    SYMBOLS.map(async (s) => {
      const r = await getRegime(s, ts);
      return r ?? { symbol: s, missing: true as const };
    }),
  );
  return { computed_at: ts, rows };
}

/**
 * Render the pulse as a one-line-per-asset markdown blob the agent
 * sees in its system prompt. Format chosen for token efficiency —
 * the model parses these in a single glance, no JSON.
 *
 *   MARKET PULSE — 2026-06-04T07:50Z
 *   - BTC: DOWN, close $65,812, -20.6% from ATH (28d ago), RSI(14) 38, 30d return -17.8%, vol 32%
 *   - ETH: DOWN, close $1,820, -26.2% from ATH (47d), RSI 35, 30d -22.7%, vol 43%
 *   - SOL: DOWN, close $72, -26.6% from ATH (23d), RSI 41, 30d -14.5%, vol 50%
 */
export function formatPulseForPrompt(pulse: MarketPulse): string {
  // Quantize the timestamp to the hour. Regime moves slowly and this
  // lets multiple agent runs within the hour reuse the Anthropic
  // prompt cache (cache hit requires byte-identical system prompt).
  // Without quantizing, every run is a fresh minute → cache miss →
  // pay full input rate on the ~3k-token system prompt.
  const hour = new Date(Math.floor(pulse.computed_at / 3_600_000) * 3_600_000)
    .toISOString()
    .slice(0, 13) + ":00Z";
  const lines = [
    `MARKET PULSE — ${hour}  (auto-injected; you don't need to call query_market_regime to know this)`,
  ];
  for (const r of pulse.rows) {
    if ("missing" in r) {
      lines.push(`- ${r.symbol}: no data`);
      continue;
    }
    const dd = r.drawdown_pct.toFixed(1);
    const r30 = r.return_30d_pct == null ? "n/a" : `${r.return_30d_pct >= 0 ? "+" : ""}${r.return_30d_pct.toFixed(1)}%`;
    const close = r.close >= 1000 ? `$${Math.round(r.close).toLocaleString()}` : `$${r.close.toFixed(2)}`;
    lines.push(
      `- ${r.symbol}: ${r.trend.toUpperCase()}, close ${close}, ${dd}% from ATH (${r.days_since_ath}d ago), RSI(14) ${r.rsi_14.toFixed(0)}, 30d ${r30}, vol ${r.vol_pct.toFixed(0)}%`,
    );
  }
  return lines.join("\n");
}
