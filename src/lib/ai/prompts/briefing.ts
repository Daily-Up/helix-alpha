/**
 * Prompt machinery for the Daily AI Briefing.
 *
 * Once a day a cron pulls a structured snapshot of EVERYTHING the system
 * knows — pending signals, recent classifications, sector rotation, ETF
 * flows, AlphaIndex top positions, and the /learnings hit-rate sample —
 * and asks Claude to synthesize a 3-paragraph human-readable market read
 * with a single highest-conviction trade idea.
 *
 * Why this matters for SosoAlpha: classification + signals are
 * mechanistic. The briefing is the moment Claude is doing genuine
 * synthesis across orthogonal data sources. It demonstrates the AI is
 * doing more than tagging news — it's reasoning about the tape.
 *
 * The prompt forces structured tool output so the UI can render it
 * with confidence (no parsing free text).
 */

import type Anthropic from "@anthropic-ai/sdk";

export const BRIEFING_PROMPT_VERSION = "v1";

/** Snapshot of every data source the briefing reads. The prompt formatter
 *  serializes this into the user message; the schema lives in /lib/db/
 *  repos/briefings.ts (BriefingInputsSummary) plus a few prose blocks. */
export interface BriefingInputs {
  date: string; // YYYY-MM-DD UTC
  /** Top N pending signals by conviction. */
  pending_signals: Array<{
    asset_symbol: string;
    direction: "long" | "short";
    tier: "auto" | "review" | "info";
    confidence: number;
    event_type: string;
    event_title: string;
    fired_at_iso: string;
    reasoning_snippet: string;
  }>;
  /** Recent classifications grouped by event_type — count + 1 example title per type. */
  recent_classification_buckets: Array<{
    event_type: string;
    n: number;
    example_title: string;
  }>;
  /** Top 5 AlphaIndex positions by current value. */
  alphaindex_positions: Array<{
    symbol: string;
    weight_pct: number;
    pnl_pct: number | null;
    rationale: string | null;
  }>;
  alphaindex_nav: { total: number; pnl_pct: number };
  /** Top 3 / bottom 3 sectors by 24h change. */
  sectors_top: Array<{ name: string; change_24h_pct: number; market_cap_dom: number }>;
  sectors_bottom: Array<{ name: string; change_24h_pct: number; market_cap_dom: number }>;
  /** Latest 24h ETF flows, by symbol. */
  etf_flows_24h: Array<{ symbol: string; net_flow_usd: number }>;
  /** Macro events on the calendar within next 24h. */
  upcoming_macro: Array<{ name: string; release_time_iso: string }>;
  /** Best calibration result from /learnings, if any data. */
  best_calibrated_event_type:
    | { event_type: string; hit_rate_3d: number; n: number }
    | null;
  /** Recent corporate BTC accumulation (last 30 days), newest-first.
   *  These are hard-fact "smart money" signals — concrete dated
   *  purchases by treasury-strategy companies (MSTR, MARA, etc.). */
  treasury_purchases_30d: Array<{
    date: string;
    ticker: string;
    company_name: string;
    btc_acq: number;
    btc_holding: number;
    acq_cost_usd: number | null;
    cost_per_btc_usd: number | null;
  }>;
  /** Aggregate treasury stats for the period. */
  treasury_stats_30d: {
    acquiring_companies: number;
    net_btc_acquired: number;
    total_acq_cost_usd: number | null;
    total_btc_held_latest: number;
  };
  /** Macro print surprises ranked by |actual - forecast|. Recent prints
   *  with strong forecast misses are tradeable in their own right
   *  (cooler-than-expected inflation = bullish for risk). */
  macro_surprises_60d: Array<{
    date: string;
    event: string;
    actual: string;
    forecast: string;
    surprise: number;
    unit: string | null;
  }>;
}

export function briefingTool(): Anthropic.Tool {
  return {
    name: "publish_daily_briefing",
    description:
      "Publish today's structured market briefing for SosoAlpha users. " +
      "Synthesize the supplied inputs into a concise human-readable read.",
    input_schema: {
      type: "object",
      required: ["headline", "regime", "body", "watchlist"],
      properties: {
        headline: {
          type: "string",
          description:
            "12-word max headline summarizing today's tape. Examples: " +
            "'Risk-on tape; COIN earnings in focus tonight', " +
            "'Mining stocks lead as BTC reclaims $80k', " +
            "'ETF outflows + macro print = defensive day'.",
        },
        regime: {
          type: "string",
          enum: ["risk_on", "risk_off", "mixed", "neutral"],
          description:
            "Top-line regime call: risk_on = broad bid, leaders extending; " +
            "risk_off = ETF outflows + macro fear + leaders breaking down; " +
            "mixed = sector rotation, no clear direction; " +
            "neutral = quiet tape, low conviction.",
        },
        body: {
          type: "string",
          description:
            "EXACTLY 3 paragraphs in markdown, separated by blank lines. " +
            "Paragraph 1: WHAT — what's happening in the tape today, citing " +
            "sector + ETF + macro inputs. " +
            "Paragraph 2: SO WHAT — what it means for active traders, citing " +
            "the most actionable pending signals. " +
            "Paragraph 3: WATCH — what to monitor in the next 24h " +
            "(scheduled events, breaking thesis tests, key levels). " +
            "Be specific. Use ticker symbols. Avoid generic platitudes. " +
            "Cap each paragraph at 4 sentences.",
        },
        top_pick: {
          type: "object",
          required: ["asset_id", "asset_symbol", "direction", "thesis", "conviction"],
          properties: {
            asset_id: {
              type: "string",
              description: "asset_id (e.g. 'tok-btc', 'stk-coin') from the inputs.",
            },
            asset_symbol: {
              type: "string",
              description: "Display symbol of the asset (BTC, COIN, etc.).",
            },
            direction: {
              type: "string",
              enum: ["long", "short", "watch"],
              description:
                "'watch' is acceptable when the thesis hasn't fully set up yet.",
            },
            thesis: {
              type: "string",
              description:
                "1-2 sentence thesis. Cite the specific data point that drove " +
                "the call (a pending signal, a sector move, a macro event). " +
                "If recommending 'watch' state the trigger condition.",
            },
            conviction: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description:
                "Honest conviction 0..1. If the data is thin, output a low " +
                "number (0.3-0.5) — do not inflate.",
            },
          },
        },
        watchlist: {
          type: "array",
          minItems: 0,
          maxItems: 5,
          items: {
            type: "object",
            required: ["asset_id", "symbol", "note"],
            properties: {
              asset_id: { type: "string" },
              symbol: { type: "string" },
              note: {
                type: "string",
                description: "1 sentence on why this is on the watchlist today.",
              },
            },
          },
          description:
            "0-5 secondary names worth watching today. Different from top_pick.",
        },
      },
    },
  };
}

const SYSTEM_INSTRUCTIONS = `You are SosoAlpha's daily market analyst. You produce one briefing per day for active crypto + crypto-stock traders.

Voice:
- Direct, plain-spoken, no hedging garbage.
- Use ticker symbols ($BTC, $COIN) not company names.
- Write like you're talking to another trader who already knows the basics.
- Avoid generic phrases ("market is volatile", "investors should be cautious", "monitor closely"). EVERY sentence should reference a SPECIFIC data point from the inputs.

Rules:
1. Output ONLY by calling publish_daily_briefing. No prose outside the tool call.
2. The body must be EXACTLY 3 paragraphs (WHAT / SO WHAT / WATCH) separated by blank lines.
3. The top_pick must come from the supplied inputs — DO NOT invent assets that aren't listed in pending_signals or alphaindex_positions or sectors. If nothing in the inputs justifies a high-conviction pick, set direction="watch" and conviction <= 0.5.
4. Cite quantities. "$280M ETF outflow" beats "outflows". "+34.8% 30d" beats "strong momentum".
5. If the inputs are thin (no pending signals, sectors flat, ETF flows quiet), say so honestly. A "quiet tape, sit on hands" briefing is more valuable than a fake conviction call.
6. Conviction calibration: 0.7+ requires a confirmed catalyst (earnings, exploit, ETF flow data). 0.5-0.7 for sector + signal alignment. <0.5 for "watching for a setup".

Format expectations:
- headline: 12 words max, no period.
- body paragraphs: 4 sentences max each, total <= 12 sentences.
- thesis on top_pick: 1-2 sentences, cite the input that drove the call.
- watchlist: 0-5 entries. Empty list is fine if nothing else qualifies.

Tone examples (study these):
GOOD: "BTC reclaims $80k after $312M ETF inflow — 3rd straight day of positive flow on $IBIT."
BAD: "Bitcoin showed strength today as ETF flows turned positive."

GOOD: "$COIN print tonight; SosoAlpha pending signal flags SHORT at 38% on $394M Q1 miss already disclosed."
BAD: "Coinbase earnings could be a catalyst tomorrow."

GOOD: "Mining sector +4.1% with $MARA leading; if BTC holds $80k, miners get the next leg."
BAD: "Watch the mining sector for opportunities."`;

export function briefingSystemPrompt(): Anthropic.Messages.TextBlockParam[] {
  return [
    {
      type: "text",
      text: SYSTEM_INSTRUCTIONS,
      // System prompt is identical across daily runs — caches well.
      cache_control: { type: "ephemeral" },
    } as Anthropic.Messages.TextBlockParam,
  ];
}

/** Format inputs into a single readable user message. */
export function briefingUserMessage(
  inputs: BriefingInputs,
): Anthropic.Messages.MessageParam {
  const lines: string[] = [];
  lines.push(`Generate today's briefing. Date: ${inputs.date} UTC`);
  lines.push("");

  // Pending signals
  lines.push(`## Pending signals (${inputs.pending_signals.length})`);
  if (inputs.pending_signals.length === 0) {
    lines.push("(none)");
  } else {
    for (const s of inputs.pending_signals) {
      lines.push(
        `- ${s.tier.toUpperCase()} | ${s.asset_symbol} ${s.direction.toUpperCase()} ` +
          `(${(s.confidence * 100).toFixed(0)}%) | ${s.event_type} | ` +
          `"${s.event_title.slice(0, 100)}" | fired ${s.fired_at_iso}`,
      );
      lines.push(`    why: ${s.reasoning_snippet}`);
    }
  }
  lines.push("");

  // Recent classification volume
  lines.push("## Last 24h classified events by type");
  if (inputs.recent_classification_buckets.length === 0) {
    lines.push("(none)");
  } else {
    for (const b of inputs.recent_classification_buckets) {
      lines.push(
        `- ${b.event_type}: ${b.n} (e.g. "${b.example_title.slice(0, 100)}")`,
      );
    }
  }
  lines.push("");

  // AlphaIndex
  lines.push(
    `## AlphaIndex portfolio (NAV $${inputs.alphaindex_nav.total.toFixed(0)}, ` +
      `${inputs.alphaindex_nav.pnl_pct >= 0 ? "+" : ""}${inputs.alphaindex_nav.pnl_pct.toFixed(2)}% all-time)`,
  );
  if (inputs.alphaindex_positions.length === 0) {
    lines.push("(no positions)");
  } else {
    for (const p of inputs.alphaindex_positions) {
      const pnl =
        p.pnl_pct == null
          ? ""
          : ` | pnl ${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct.toFixed(1)}%`;
      const rat = p.rationale ? ` | why: ${p.rationale}` : "";
      lines.push(
        `- ${p.symbol} ${p.weight_pct.toFixed(2)}%${pnl}${rat}`,
      );
    }
  }
  lines.push("");

  // Sectors
  lines.push("## Sector rotation (24h)");
  lines.push("LEADERS:");
  for (const s of inputs.sectors_top) {
    lines.push(
      `  - ${s.name}: ${s.change_24h_pct >= 0 ? "+" : ""}${s.change_24h_pct.toFixed(2)}% (mc dom ${(s.market_cap_dom * 100).toFixed(1)}%)`,
    );
  }
  lines.push("LAGGARDS:");
  for (const s of inputs.sectors_bottom) {
    lines.push(
      `  - ${s.name}: ${s.change_24h_pct.toFixed(2)}% (mc dom ${(s.market_cap_dom * 100).toFixed(1)}%)`,
    );
  }
  lines.push("");

  // Corporate BTC treasury accumulation
  lines.push("## Corporate BTC treasury accumulation (last 30 days)");
  if (inputs.treasury_purchases_30d.length === 0) {
    lines.push("(no recent purchases on file)");
  } else {
    lines.push(
      `Aggregate: ${inputs.treasury_stats_30d.acquiring_companies} companies acquired ` +
        `${inputs.treasury_stats_30d.net_btc_acquired.toLocaleString()} BTC ` +
        (inputs.treasury_stats_30d.total_acq_cost_usd != null
          ? `at total cost $${(inputs.treasury_stats_30d.total_acq_cost_usd / 1_000_000).toFixed(0)}M.`
          : "(some costs undisclosed).") +
        ` Total BTC held by tracked treasuries: ${inputs.treasury_stats_30d.total_btc_held_latest.toLocaleString()}.`,
    );
    lines.push("Top events (newest first):");
    for (const t of inputs.treasury_purchases_30d.slice(0, 8)) {
      const cost =
        t.acq_cost_usd != null
          ? `$${(t.acq_cost_usd / 1_000_000).toFixed(0)}M`
          : "(cost undisclosed)";
      const ppc =
        t.cost_per_btc_usd != null
          ? ` @ $${Math.round(t.cost_per_btc_usd).toLocaleString()}/BTC`
          : "";
      lines.push(
        `- ${t.date} | ${t.ticker} (${t.company_name}) +${t.btc_acq.toLocaleString()} BTC, ` +
          `holdings now ${Math.round(t.btc_holding).toLocaleString()} BTC | ${cost}${ppc}`,
      );
    }
  }
  lines.push("");

  // ETF flows
  lines.push("## ETF flows (24h, USD)");
  if (inputs.etf_flows_24h.length === 0) {
    lines.push("(no recent data)");
  } else {
    for (const e of inputs.etf_flows_24h) {
      const sign = e.net_flow_usd >= 0 ? "+" : "";
      const dollars = (Math.abs(e.net_flow_usd) / 1_000_000).toFixed(1);
      lines.push(`- ${e.symbol}: ${sign}$${dollars}M`);
    }
  }
  lines.push("");

  // Macro
  lines.push("## Macro on the calendar (next 24h)");
  if (inputs.upcoming_macro.length === 0) {
    lines.push("(nothing scheduled)");
  } else {
    for (const m of inputs.upcoming_macro) {
      lines.push(`- ${m.name} @ ${m.release_time_iso}`);
    }
  }
  lines.push("");

  // Macro surprises — recent prints where actual deviated from forecast
  lines.push("## Recent macro surprises (largest forecast misses, last 60d)");
  if (inputs.macro_surprises_60d.length === 0) {
    lines.push("(no notable surprises on file)");
  } else {
    for (const m of inputs.macro_surprises_60d) {
      const sign = m.surprise > 0 ? "+" : "";
      const u = m.unit ?? "pp";
      lines.push(
        `- ${m.date} ${m.event}: actual ${m.actual} vs forecast ${m.forecast} → surprise ${sign}${m.surprise.toFixed(2)}${u}`,
      );
    }
    lines.push(
      "(Cooler-than-expected inflation/PPI = bullish for risk; " +
        "weaker activity = bearish. Use these to flavor 'macro regime' calls.)",
    );
  }
  lines.push("");

  // Calibration evidence
  if (inputs.best_calibrated_event_type) {
    const c = inputs.best_calibrated_event_type;
    lines.push(
      `## Track record: best-performing event_type so far is "${c.event_type}" — ` +
        `${(c.hit_rate_3d * 100).toFixed(0)}% hit rate at T+3d (n=${c.n})`,
    );
    lines.push("");
  }

  lines.push(
    "Now call publish_daily_briefing with the structured briefing.",
  );

  return {
    role: "user",
    content: [{ type: "text", text: lines.join("\n") }],
  };
}
