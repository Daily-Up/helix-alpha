/**
 * generateSetup — the on-demand "Setup" brain.
 *
 * Pulls an asset's recent SoSoValue-classified news + daily price stats,
 * asks Claude for a grounded trade setup (bias, conviction, reasoning,
 * levels, entry/target/stop), and returns it with the raw sources so the
 * UI can show exactly which headlines drove the call.
 */

import { Assets, all } from "@/lib/db";
import { Market } from "@/lib/sodex";
import { anthropic, getModel } from "./client";
import {
  SetupSchema,
  setupSystemPrompt,
  setupTool,
  SETUP_PROMPT_VERSION,
  type Setup,
} from "./prompts/setup";
import type Anthropic from "@anthropic-ai/sdk";

export interface SetupSource {
  title: string;
  event_type: string;
  sentiment: string;
  severity: string;
  classified_at: number;
}

export interface PriceContext {
  current: number | null;
  mark: number | null;
  high_7d: number | null;
  low_7d: number | null;
  high_30d: number | null;
  low_30d: number | null;
  change_7d_pct: number | null;
  change_30d_pct: number | null;
}

export interface SetupResult {
  asset: { id: string; symbol: string; name: string; sodex_symbol: string | null };
  setup: Setup;
  price: PriceContext;
  sources: SetupSource[];
  generated_at: number;
  prompt_version: string;
  model: string;
  cost_usd: number;
}

// Haiku-4.5 / Sonnet-4.5 blended pricing is handled generically; the
// setup is a single low-volume call so we price it with the model's rate.
const PRICING = { input: 3, cached: 0.3, output: 15 }; // $/M tokens (Sonnet)

async function loadSources(assetId: string): Promise<SetupSource[]> {
  return all<SetupSource>(
    `SELECT n.title            AS title,
            c.event_type       AS event_type,
            c.sentiment        AS sentiment,
            c.severity         AS severity,
            c.classified_at    AS classified_at
     FROM event_assets ea
     JOIN news_events n     ON n.id = ea.event_id
     JOIN classifications c ON c.event_id = ea.event_id
     WHERE ea.asset_id = ?
     ORDER BY c.classified_at DESC
     LIMIT 15`,
    [assetId],
  );
}

async function loadPrice(
  assetId: string,
  sodexSymbol: string | null,
): Promise<PriceContext> {
  interface Bar { date: string; high: number; low: number; close: number }
  const bars = await all<Bar>(
    `SELECT date, high, low, close FROM klines_daily
     WHERE asset_id = ? ORDER BY date DESC LIMIT 30`,
    [assetId],
  );
  const lastClose = bars[0]?.close ?? null;
  const close7 = bars[6]?.close ?? null;
  const close30 = bars[29]?.close ?? bars[bars.length - 1]?.close ?? null;
  const window7 = bars.slice(0, 7);
  const hi7 = window7.length ? Math.max(...window7.map((b) => b.high)) : null;
  const lo7 = window7.length ? Math.min(...window7.map((b) => b.low)) : null;
  const hi30 = bars.length ? Math.max(...bars.map((b) => b.high)) : null;
  const lo30 = bars.length ? Math.min(...bars.map((b) => b.low)) : null;

  // Live SoDEX mark price — best-effort, time-boxed so a slow gateway can't
  // stall the setup. Falls back to the last daily close.
  let mark: number | null = null;
  if (sodexSymbol) {
    try {
      const timeout = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("ticker timeout")), 3500),
      );
      const tickers = (await Promise.race([
        Market.getAllTickersBySymbol(),
        timeout,
      ])) as Map<string, { lastPx: string }>;
      const t = tickers.get(sodexSymbol);
      const n = t ? Number(t.lastPx) : NaN;
      if (Number.isFinite(n) && n > 0) mark = n;
    } catch {
      // ignore — mark stays null, daily close carries the price context
    }
  }

  const pct = (now: number | null, then: number | null) =>
    now != null && then != null && then > 0 ? ((now - then) / then) * 100 : null;

  const current = mark ?? lastClose;
  return {
    current,
    mark,
    high_7d: hi7,
    low_7d: lo7,
    high_30d: hi30,
    low_30d: lo30,
    change_7d_pct: pct(current, close7),
    change_30d_pct: pct(current, close30),
  };
}

function userMessage(
  asset: { symbol: string; name: string },
  price: PriceContext,
  sources: SetupSource[],
): Anthropic.Messages.MessageParam {
  const fmt = (n: number | null) => (n == null ? "n/a" : n.toLocaleString());
  const priceBlock = [
    `Asset: ${asset.name} (${asset.symbol})`,
    `Current price: ${fmt(price.current)}${price.mark == null ? " (last daily close — no live mark)" : " (live SoDEX mark)"}`,
    `7d: high ${fmt(price.high_7d)} / low ${fmt(price.low_7d)} / change ${price.change_7d_pct == null ? "n/a" : price.change_7d_pct.toFixed(1) + "%"}`,
    `30d: high ${fmt(price.high_30d)} / low ${fmt(price.low_30d)} / change ${price.change_30d_pct == null ? "n/a" : price.change_30d_pct.toFixed(1) + "%"}`,
  ].join("\n");

  const newsBlock = sources.length
    ? sources
        .map(
          (s, i) =>
            `${i + 1}. [${s.event_type} · ${s.sentiment} · ${s.severity}] ${s.title}`,
        )
        .join("\n")
    : "(no recent classified news for this asset)";

  return {
    role: "user",
    content:
      `Produce a trade setup for ${asset.symbol}.\n\n` +
      `PRICE CONTEXT\n${priceBlock}\n\n` +
      `RECENT NEWS (most recent first, from SoSoValue, classified by Helix)\n${newsBlock}\n\n` +
      `Weigh the news sentiment against the price trend. Anchor levels and the entry/target/stop to the price context above. If the evidence is thin or conflicting, return a neutral, low-conviction read with null levels.`,
  };
}

export async function generateSetup(assetId: string): Promise<SetupResult> {
  const asset = await Assets.getAssetById(assetId);
  if (!asset) throw new Error(`asset '${assetId}' not found`);

  const sodexSymbol = asset.tradable?.symbol ?? null;
  const [sources, price] = await Promise.all([
    loadSources(assetId),
    loadPrice(assetId, sodexSymbol),
  ]);

  const client = anthropic();
  const model = getModel();
  const resp = await client.messages.create({
    model,
    max_tokens: 1200,
    system: setupSystemPrompt(),
    tools: [setupTool()],
    tool_choice: { type: "tool", name: "publish_setup" },
    messages: [userMessage(asset, price, sources)],
  });

  const toolUse = resp.content.find((b) => b.type === "tool_use") as
    | Extract<Anthropic.Messages.ContentBlock, { type: "tool_use" }>
    | undefined;
  if (!toolUse) throw new Error("Setup call returned no tool use");
  const setup = SetupSchema.parse(toolUse.input);

  const u = resp.usage;
  const cached =
    (u as unknown as { cache_read_input_tokens?: number })
      .cache_read_input_tokens ?? 0;
  const cost_usd =
    (u.input_tokens * PRICING.input +
      cached * PRICING.cached +
      u.output_tokens * PRICING.output) /
    1_000_000;

  return {
    asset: {
      id: asset.id,
      symbol: asset.symbol,
      name: asset.name,
      sodex_symbol: sodexSymbol,
    },
    setup,
    price,
    sources,
    generated_at: Date.now(),
    prompt_version: SETUP_PROMPT_VERSION,
    model,
    cost_usd,
  };
}
