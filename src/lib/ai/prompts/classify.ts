/**
 * Prompt machinery for the news classifier.
 *
 * The classifier returns a strictly-shaped JSON via Anthropic tool use.
 * That gives us validated, structured output without parsing free text.
 *
 * The static parts of the prompt (taxonomy + asset universe) are marked
 * cache_control so repeated classifications across an ingest run only
 * pay full input cost on the first call.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { EventTypes, Sentiments, Severities } from "@/lib/db";
import type { Asset } from "@/lib/universe";

/**
 * v5 fixes two production bugs surfaced in the live signals review:
 *
 *   1. COUNTERPARTY LEAKAGE — when Company A's news mentions Company B
 *      as a counterparty/partner (e.g. "IREN reports $3.4B contract with
 *      NVIDIA"), v4 sometimes added stk-nvda to affected_asset_ids,
 *      which then became a misplaced signal on NVDA. v5 forbids this:
 *      counterparties NEVER go in affected_asset_ids unless the news is
 *      ALSO substantively about them.
 *
 *   2. DIRECTION-MIXED ARTICLES — articles like "21Shares L2 report:
 *      smaller L2s shutting down, ARB/OP/Base dominate" have winners AND
 *      losers in the same body. v4's single `sentiment` field forces ONE
 *      direction, so all affected assets got SHORT signals — including
 *      ARB and OP, who the article said are WINNING. v5 enforces that
 *      affected_asset_ids must contain ONLY assets that match the
 *      chosen sentiment direction. Mixed-direction articles must pick a
 *      side or return an empty asset list.
 *
 * v4 still applies (strict proxy rule) — these are additive constraints.
 */
/**
 * v6 adds Dimension 3 reasoning fields: mechanism_length,
 * mechanism_reasoning, counterfactual_strength, counterfactual_reasoning.
 *
 * These let the gate (Dimension 4) cap conviction deterministically:
 *   • mechanism_length 1 → no cap; 2 → 0.85; 3 → 0.70; 4 → 0.55.
 *   • counterfactual weak → no cap; moderate → 0.80; strong → 0.60.
 *
 * The cap is enforced as a pure function on the persisted classification —
 * the model self-applying it is a soft expectation, not a hard one. If the
 * model produces inconsistent fields, the gate refuses upstream-style
 * (`mechanism_conviction_excess`, `counterfactual_conviction_excess`).
 */
export const CLASSIFY_PROMPT_VERSION = "v6";

/**
 * The tool Claude is forced to call. Tool inputs become our typed output.
 */
export function classifyTool(): Anthropic.Tool {
  return {
    name: "classify_event",
    description:
      "Record the structured classification of a single crypto/finance news event.",
    input_schema: {
      type: "object",
      required: [
        "event_type",
        "sentiment",
        "severity",
        "confidence",
        "actionable",
        "event_recency",
        "affected_asset_ids",
        "reasoning",
        // v6 / Dimension 3 — reasoning chain depth + counterargument
        "mechanism_length",
        "mechanism_reasoning",
        "counterfactual_strength",
        "counterfactual_reasoning",
      ],
      properties: {
        event_type: {
          type: "string",
          enum: [...EventTypes],
          description:
            "The category of the event. Pick the SINGLE most accurate label. " +
            "Use 'other' only when nothing else fits.",
        },
        sentiment: {
          type: "string",
          enum: [...Sentiments],
          description:
            "Net price-impact direction (positive = bullish, negative = " +
            "bearish, neutral = no clear bias) that applies to ALL assets " +
            "in affected_asset_ids. If the article has both winners and " +
            "losers, you must either (a) pick one side and only include " +
            "those assets, or (b) use 'neutral' with an empty asset list. " +
            "NEVER include a winner under 'negative' or a loser under " +
            "'positive' — this creates wrong-direction trades.",
        },
        severity: {
          type: "string",
          enum: [...Severities],
          description:
            "Magnitude estimate. high = likely >5% move within 24h, " +
            "medium = 1-5%, low = <1% or background noise.",
        },
        confidence: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description:
            "Your confidence in this classification, 0..1. Be honest — a " +
            "vague rumor with no source should be 0.3-0.5; a confirmed " +
            "exploit with on-chain evidence should be 0.9+.",
        },
        actionable: {
          type: "boolean",
          description:
            "TRUE only if a trader could profitably act on this RIGHT NOW. " +
            "FALSE for: retrospective articles, post-mortems, summaries of " +
            "old events, opinion/commentary, governance discussions, " +
            "announcements about events that already happened more than 24h " +
            "ago. The market has already priced in old news.",
        },
        event_recency: {
          type: "string",
          enum: ["live", "today", "this_week", "older"],
          description:
            "When did the underlying event ACTUALLY happen, regardless of " +
            "when this article was published? " +
            "'live' = breaking, happening now (<6h). " +
            "'today' = within last 24h. " +
            "'this_week' = within last 7 days. " +
            "'older' = older than a week, or referencing past events. " +
            "An article published TODAY about an exploit from APRIL is 'older'.",
        },
        affected_asset_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Asset IDs from the universe whose price will move in the " +
            "SAME direction as 'sentiment'. Use the exact ids shown " +
            "(e.g. 'tok-btc', 'etf-ibit'). Two strict rules: " +
            "(1) Counterparties (companies named only as partners/clients " +
            "of the SUBJECT) NEVER go in this list — only the actual " +
            "subject(s) of the news. " +
            "(2) Every id must match the sentiment direction. If the news " +
            "has winners and losers, include only one side or return []. " +
            "Empty array is fine when no listed asset clearly matches.",
        },
        reasoning: {
          type: "string",
          description:
            "1-3 sentence explanation covering: WHY this event_type, WHY " +
            "this sentiment, WHY these affected assets, AND why it is or " +
            "is not actionable right now. Keep it concise — this surfaces in the UI.",
        },

        // ── v6 / Dimension 3 — explicit reasoning chain ──
        mechanism_length: {
          type: "integer",
          enum: [1, 2, 3, 4],
          description:
            "How many causal steps separate this event from a price move? " +
            "1 = direct (earnings miss → stock down; exploit drains funds → token down). " +
            "2 = one hop (Fed cuts rates → risk-on → BTC up). " +
            "3 = two hops (regulatory clarity in country X → exchanges expand → small caps benefit). " +
            "4 = speculative chain (X happens → Y happens → narrative shifts → token Z benefits). " +
            "Conviction is hard-capped by this length: 1=no cap, 2=0.85, 3=0.70, 4=0.55. " +
            "Counting is on the LITERAL chain to a price move, not on how strong each hop is.",
        },
        mechanism_reasoning: {
          type: "string",
          description:
            "Walk the chain in plain prose: 'Step 1 → Step 2 → ... → price move'. " +
            "Identify where the chain weakens. 1-2 sentences max.",
        },
        counterfactual_strength: {
          type: "string",
          enum: ["weak", "moderate", "strong"],
          description:
            "If a smart trader would take the OPPOSITE side of this trade, how " +
            "credible is their case? 'weak' = no real counterargument (slam-dunk). " +
            "'moderate' = a serious objection exists but is outweighed. " +
            "'strong' = the counter case is roughly as strong as ours; the trade " +
            "is genuinely contested. Conviction caps: weak=no cap, moderate=0.80, " +
            "strong=0.60.",
        },
        counterfactual_reasoning: {
          type: "string",
          description:
            "1-2 sentences making the strongest case for the OPPOSITE direction. " +
            "If counterfactual_strength is 'weak', this should still articulate the " +
            "opposing view (even if weak); empty strings are not acceptable.",
        },
      },
    },
  };
}

/**
 * Build the system prompt. Static across all events in a batch so we
 * mark it cache_control = ephemeral for ~90% input-cost savings on
 * subsequent calls within 5 minutes.
 */
export function classifySystemPrompt(
  universe: Asset[],
): Anthropic.Messages.TextBlockParam[] {
  // Mark tradable assets with (T) so Claude can prefer them when the
  // primary affected asset isn't directly tradable on SoDEX.
  const universeLines = universe
    .map((a) => {
      const trad = a.tradable ? " (T)" : "";
      return `${a.id} (${a.symbol}, ${a.kind}, ${a.name})${trad}`;
    })
    .join("\n");

  const intro = `You are SosoAlpha's event classifier. You read raw crypto/finance news and label each item with a structured taxonomy so it can be matched against historical patterns and used for live signal generation.

Rules:
- Output ONLY by calling the classify_event tool. No prose.
- Pick the SINGLE most accurate event_type. If multiple apply, pick the one a trader would react to most strongly.
- "affected_asset_ids" must use IDs from the universe below verbatim. Skip assets only tangentially mentioned.
- "severity" reflects price-impact magnitude, not the writer's tone.
- "sentiment" reflects market interpretation. A confirmed exploit is "negative" for the exploited protocol but possibly "positive" for competitors.
- "confidence" should reward concrete evidence (links, on-chain hashes, named officials) and penalise rumors / unsourced posts.

CRITICAL — actionable & event_recency:
- The TIMESTAMP on the news item is when the article was PUBLISHED, not when the underlying event happened. Read the body to determine when the event itself occurred.
- If the article body or title mentions a SPECIFIC date (e.g. "1/9 April", "January 15 2026", "in Q1 2025"), use THAT date for event_recency, NOT the publish time.
- A long-form analysis, retrospective, opinion piece, AMA recap, podcast notes → actionable=false even if it discusses recent events. Traders need a fresh catalyst, not commentary.
- A scheduled event in the future (e.g. "FOMC tomorrow", "unlock in 3 days") → actionable=true ONLY if it's within 48h. Earlier than that → actionable=false.
- Macro reports of just-released numbers (CPI print, employment data, jobs) → live + actionable.
- Generic price commentary ("BTC breaks $80k") with no specific catalyst → actionable=false. Pure price reporting isn't tradable.

CONCRETE EXAMPLES (study these):

EX 1 — body starts: "1/9 April 2026, $292M exploit on KelpDAO + LayerZero..."
   → event happened on 9 April. Article today is a recap.
   → event_recency="older", actionable=false.
   → Reasoning should say: "Article from May referencing April exploit; market already priced in."

EX 2 — body: "Today, AAVE protocol drained $200M in flash loan attack..."
   → "Today" = article date = event date. Fresh catalyst.
   → event_recency="live", actionable=true.

EX 3 — body: "Reflecting on the 2024 FTX collapse..."
   → Retrospective on past event.
   → event_recency="older", actionable=false.

EX 4 — body: "Coinbase reported a net loss of $394M for Q1..."
   → Earnings just released. Fresh tradable catalyst.
   → event_recency="live" or "today", actionable=true.

EX 5 — body: "BTC breaks $80,000" with no specific catalyst, just price observation
   → No catalyst. Pure price commentary.
   → event_recency="live" but actionable=false (nothing to act on).

EX 6 — body: "FOMC meeting next week — analysts expect..."
   → Scheduled event >48h away.
   → event_recency="this_week", actionable=false.

EX 7 — body: "FOMC decision today: Fed holds rates at 5.25%..."
   → Just-released macro print.
   → event_recency="live", actionable=true.

TRADABLE PROXIES (STRICT — only fallback when primary is NOT tradable):
- Assets marked "(T)" in the universe list are directly tradable on SoDEX.
- DEFAULT RULE: keep affected_asset_ids tight to assets actually mentioned in the news. Do NOT pad with proxies.
- ONLY include a proxy if NONE of the primary affected assets are tradable. If even ONE primary asset has "(T)", skip proxies entirely.

COUNTERPARTY RULE (NEW in v5 — read carefully):
A "counterparty" is a company/asset NAMED in the news but is NOT the SUBJECT of the news. The subject is whose announcement / earnings / event this is.
- A counterparty NEVER goes in affected_asset_ids, even if it's tradable. The news is not about them — it's about the subject.
- To check: ask "if I had to write a one-line headline, whose name comes first?" That's the subject.
- Counterparties get news of their own. We don't piggyback their tickers off other companies' announcements.

WRONG vs RIGHT examples for counterparty:
- "IREN reports Q3 earnings + $3.4B AI contract with NVIDIA"
  - Subject = IREN (their earnings, their announcement). NVIDIA is a counterparty.
  - WRONG: ["stk-iren", "stk-nvda"] — NVDA isn't the subject.
  - WRONG: ["stk-nvda", "stk-iren"] — same mistake, different order.
  - RIGHT: ["stk-iren", "tok-btc"] — IREN as subject, BTC as proxy because IREN isn't tradable. NVDA stays out.
- "Coinbase partners with AWS to launch AI agent payments"
  - Subject = Coinbase. AWS/Amazon is a counterparty.
  - RIGHT: ["stk-coin"]. Do NOT add stk-amzn.
- "MicroStrategy buys 30,000 BTC"
  - This is a 2-subject story: MSTR (their treasury action) AND BTC (the asset acquired in size).
  - RIGHT: ["trs-mstr", "tok-btc"] — both are genuine subjects.
  - The distinction: BTC is the OBJECT of the action and the news IS substantively about BTC accumulation.

Examples (proxy + counterparty rules combined):
- Coinbase Q1 earnings → COIN-USD (T) is tradable → ["stk-coin"]. Do NOT add tok-btc or idx-ssimag7.
- MSTR 30k BTC purchase → both MSTR and BTC are subjects → ["trs-mstr", "tok-btc"].
- RIOT (mining stock, not tradable) earnings beat → no T → fallback proxy: ["stk-riot", "tok-btc"].
- IREN $3.4B NVIDIA contract → IREN is subject, NVDA is counterparty → ["stk-iren", "tok-btc"].
- AAVE protocol exploit → tok-aave (T) directly tradable → ["tok-aave"]. Do NOT add idx-ssidefi.
- Pharos (PROS) listing on Bithumb → PROS not in universe → no signal possible → empty array OR include closest sector index ["idx-ssidefi"] as best-guess proxy.
- US Treasury buyback → no specific equity, macro event → ["perp-us500"].
- Oil price spike → ["perp-cl"].
- General "AI narrative heating up" → no specific asset → ["idx-ssimag7"] as broad-market proxy.

IMPORTANT: keep the list MINIMAL. If you can't think of which proxy belongs, return only the directly-affected primary assets. Empty array is acceptable when no listed asset matches.

SENTIMENT-DIRECTION CONSISTENCY (NEW in v5 — critical):
The "sentiment" field describes ONE direction (positive / negative / neutral) that applies to ALL affected_asset_ids as a group. Therefore:

RULE: every asset in affected_asset_ids MUST be impacted in the SAME direction as the chosen sentiment.

If an article is bullish for some assets and bearish for others (mixed direction), you MUST do ONE of:
  (a) Pick the side with the dominant tradable assets and include ONLY those, OR
  (b) Return an empty affected_asset_ids when neither side is clearly tradable, OR
  (c) Set sentiment="neutral" if the article is genuinely two-sided commentary.

NEVER include a winner under sentiment="negative" or a loser under sentiment="positive". Doing so will cause the signal generator to fire a wrong-direction trade.

WRONG vs RIGHT examples for direction-mixed articles:
- "21Shares L2 report: smaller L2s shutting down, ARB/OP/Base dominate 90% market share"
  - Winners: ARB, OP. Losers: smaller L2s (KINTO, BLAST — likely not in universe). The reasoning is about consolidation: BAD for tail, GOOD for leaders.
  - WRONG: sentiment="negative", affected_asset_ids=["tok-arb", "tok-op", "tok-eth"] — fires SHORT on the winners. This is the bug.
  - RIGHT: sentiment="positive", affected_asset_ids=["tok-arb", "tok-op"] — only the named winners.
  - ALSO RIGHT: sentiment="neutral", affected_asset_ids=[] — research/commentary not actionable.
- "ETF outflows: BTC -$200M, ETH -$50M, SOL +$30M"
  - WRONG: include all three under sentiment="negative" — SOL had inflows.
  - RIGHT: sentiment="negative", affected_asset_ids=["tok-btc", "tok-eth"]. SOL is a separate, opposite-direction story.
- "Exchange A delists Token X but adds Token Y"
  - Two opposite events bundled. Either pick the bigger one for sentiment, or set neutral with empty list.

Event-type rubric (most-to-least common):
- exploit:        protocol hacked / drained / rug. exploit losses confirmed
- regulatory:     SEC / CFTC / law enforcement / government action
- etf_flow:       unusual ETF inflow/outflow, fund launch, fee change
- partnership:    integration, partnership, alliance announcement
- listing:        exchange listing or delisting
- social_platform: X API ban, Discord seizure, Telegram action — story is about a SOCIAL platform's behavior, not the token's
- unlock:         token unlock / vesting cliff / scheduled supply event
- airdrop:        airdrop announcement / eligibility / claim window
- earnings:       public-company earnings (COIN, MSTR, miners, etc.)
- macro:          CPI / FOMC / employment / inflation / rate decisions
- treasury:       corporate BTC/ETH purchase or sale
- governance:     DAO vote, parameter change
- tech_update:    upgrade, hard fork, mainnet launch
- security:       vulnerability discovered/patched (no exploit yet)
- narrative:      shift in market narrative, sector rotation news
- fundraising:    VC round, token sale (not airdrop)
- other:          last resort`;

  const universeIntro = `\n\nThe asset universe (use these EXACT ids in affected_asset_ids):\n${universeLines}`;

  return [
    {
      type: "text",
      text: intro + universeIntro,
      // The Anthropic TS SDK supports cache_control via cast — accept any
      // here so we don't fight the type system on every model bump.
      cache_control: { type: "ephemeral" },
    } as Anthropic.Messages.TextBlockParam,
  ];
}

/**
 * Format a single event into the user-message block.
 * Strips HTML tags from content so the model doesn't waste tokens on markup.
 */
export function classifyUserMessage(event: {
  id: string;
  release_time: number;
  title: string;
  content: string | null;
  category: number;
  tags: string[];
  matched_currencies: Array<{ symbol: string; name: string }>;
  author?: string | null;
}): Anthropic.Messages.MessageParam {
  const contentText = (event.content ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);

  const matched =
    event.matched_currencies.length > 0
      ? event.matched_currencies.map((c) => c.symbol).join(", ")
      : "—";
  const tags = event.tags.length > 0 ? event.tags.join(", ") : "—";

  return {
    role: "user",
    content: [
      {
        type: "text",
        text:
          `Classify this event:\n\n` +
          `id: ${event.id}\n` +
          `released: ${new Date(event.release_time).toISOString()}\n` +
          `category: ${event.category}\n` +
          `author: ${event.author ?? "—"}\n` +
          `matched_currencies: ${matched}\n` +
          `tags: ${tags}\n` +
          `title: ${event.title}\n\n` +
          `body:\n${contentText || "(no body)"}\n\n` +
          `Call classify_event now.`,
      },
    ],
  };
}
