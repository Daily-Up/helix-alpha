/**
 * Per-tool plain-English summarizers for the agent trace UI.
 *
 * Each function takes the raw `input` and `output` payloads of a
 * tool call (the same JSON objects the agent saw) and returns a
 * short human-readable string describing what the agent asked and
 * what it got back. No JSON dumps — that's what was making the
 * audit page read like a debug log.
 *
 * Falls back to an empty string when a tool's summarizer isn't
 * implemented; the caller hides the row's expanded body when both
 * summaries are empty.
 */

type Json = unknown;

function asObj(v: Json): Record<string, Json> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, Json>)
    : {};
}

function asArr(v: Json): Json[] {
  return Array.isArray(v) ? v : [];
}

function asStr(v: Json): string | null {
  return typeof v === "string" ? v : null;
}

function asNum(v: Json): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function fmtMove(x: number): string {
  const sign = x >= 0 ? "+" : "";
  return `${sign}${x.toFixed(2)}%`;
}

function plural(n: number, singular: string, pluralForm?: string): string {
  return n === 1 ? singular : (pluralForm ?? singular + "s");
}

// ─────────────────────────────────────────────────────────────────────

export interface ToolSummary {
  /** One-line plain-English of what the agent asked for. */
  asked: string;
  /** One-line plain-English of what came back. */
  found: string;
}

export function summarizeToolCall(
  tool: string,
  input: Json,
  output: Json,
): ToolSummary {
  switch (tool) {
    case "search_outlet_coverage":
      return summarizeOutletCoverage(input, output);
    case "query_asset_history":
      return summarizeAssetHistory(input, output);
    case "query_event_type_stats":
      return summarizeEventTypeStats(input, output);
    case "query_base_rate":
      return summarizeBaseRate(input, output);
    case "query_price_around_catalyst":
      return summarizePriceAroundCatalyst(input, output);
    case "fetch_full_article":
      return summarizeFullArticle(input, output);
    case "submit_classification":
      return summarizeSubmitClassification(input, output);
    case "submit_verdict":
      return summarizeSubmitVerdict(input, output);
    default:
      return { asked: "", found: "" };
  }
}

// ─── search_outlet_coverage ────────────────────────────────────────

function summarizeOutletCoverage(input: Json, output: Json): ToolSummary {
  const i = asObj(input);
  const o = asObj(output);
  const query = asStr(i.query) ?? "(no query)";
  const hrs = asNum(i.window_hours);
  const asked = hrs
    ? `News matching "${query}" in the last ${hrs}h`
    : `News matching "${query}"`;

  const matches = asArr(o.matches);
  if (matches.length === 0) {
    const scanned = asNum(o.total_scanned);
    return {
      asked,
      found: scanned
        ? `No matches across ${scanned.toLocaleString()} scanned articles`
        : "No matches",
    };
  }
  // Top 3 outlets with their similarity, deduped by author.
  const outlets = new Map<string, number>();
  for (const m of matches) {
    const mo = asObj(m);
    const author = asStr(mo.author) ?? "unknown";
    const sim = asNum(mo.similarity) ?? 0;
    if (!outlets.has(author) || (outlets.get(author) ?? 0) < sim) {
      outlets.set(author, sim);
    }
  }
  const top = [...outlets.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([a, s]) => `${a} (${fmtPct(s)} match)`)
    .join(", ");
  return {
    asked,
    found: `${matches.length} corroborating ${plural(matches.length, "article")} from ${top}${outlets.size > 3 ? ` and ${outlets.size - 3} more` : ""}`,
  };
}

// ─── query_asset_history ───────────────────────────────────────────

function summarizeAssetHistory(input: Json, output: Json): ToolSummary {
  const i = asObj(input);
  const o = asObj(output);
  const symbol = asStr(i.symbol) ?? "?";
  const days = asNum(i.days) ?? 14;
  const asked = `${symbol} price + news history for the last ${days} ${plural(days, "day")}`;

  const lastPrice = asNum(o.last_price);
  const pctChange = asNum(o.pct_change);
  const newsCount = asNum(o.news_count);
  const parts: string[] = [];
  if (lastPrice != null) parts.push(`$${lastPrice.toLocaleString()}`);
  if (pctChange != null) parts.push(`${fmtMove(pctChange * 100)} over window`);
  if (newsCount != null)
    parts.push(`${newsCount} prior ${plural(newsCount, "story", "stories")}`);
  return {
    asked,
    found: parts.length > 0 ? parts.join(" · ") : "Insufficient data",
  };
}

// ─── query_event_type_stats ────────────────────────────────────────

function summarizeEventTypeStats(input: Json, output: Json): ToolSummary {
  const i = asObj(input);
  const o = asObj(output);
  const eventType = asStr(i.event_type) ?? "?";
  const sentiment = asStr(i.sentiment);
  const days = asNum(i.days) ?? 90;

  const asked = sentiment
    ? `Hit rate for past ${days}d ${sentiment} ${eventType} events`
    : `Hit rate for past ${days}d ${eventType} events`;

  const sample = asNum(o.sample_size);
  if (sample == null || sample === 0) {
    return { asked, found: "No prior events in window" };
  }
  const hit3d = asNum(o.hit_rate_3d);
  const mean3d = asNum(o.mean_realized_pct_3d);
  const parts: string[] = [
    `n=${sample.toLocaleString()}`,
    hit3d != null ? `${fmtPct(hit3d)} 3d hit rate` : "",
    mean3d != null ? `${fmtMove(mean3d)} avg 3d move` : "",
  ].filter(Boolean);
  return { asked, found: parts.join(" · ") };
}

// ─── query_base_rate ───────────────────────────────────────────────

function summarizeBaseRate(input: Json, output: Json): ToolSummary {
  const i = asObj(input);
  const o = asObj(output);
  const subtype = asStr(i.catalyst_subtype) ?? "?";
  const assetClass = asStr(i.asset_class) ?? "?";
  const asked = `Base rate for ${subtype.replace(/_/g, " ")} on ${assetClass} assets`;

  const sample = asNum(o.sample_size);
  if (sample == null || sample === 0) {
    return { asked, found: "No historical sample available" };
  }
  const hit = asNum(o.hit_rate);
  const mean = asNum(o.mean_realized_pct);
  const parts = [
    `n=${sample}`,
    hit != null ? `${fmtPct(hit)} hit rate` : "",
    mean != null ? `${fmtMove(mean)} avg move` : "",
  ].filter(Boolean);
  return { asked, found: parts.join(" · ") };
}

// ─── query_price_around_catalyst ───────────────────────────────────

function summarizePriceAroundCatalyst(input: Json, output: Json): ToolSummary {
  const i = asObj(input);
  const o = asObj(output);
  const symbol = asStr(i.symbol) ?? "?";
  const catalyst = asStr(i.catalyst_iso);
  const asked = catalyst
    ? `${symbol} price action around ${new Date(catalyst).toISOString().slice(0, 10)}`
    : `${symbol} price tape around catalyst`;

  if (o.error || o.ok === false) {
    const reason = asStr(o.error) ?? asStr(o.reason) ?? "no price data";
    return { asked, found: `Unavailable — ${reason}` };
  }
  const pre = asNum(o.pct_pre);
  const post = asNum(o.pct_post);
  const parts: string[] = [];
  if (pre != null) parts.push(`${fmtMove(pre * 100)} in lead-up`);
  if (post != null) parts.push(`${fmtMove(post * 100)} since`);
  if (parts.length === 0) {
    const lastPrice = asNum(o.last_price);
    if (lastPrice != null) parts.push(`Last ${symbol}: $${lastPrice.toLocaleString()}`);
  }
  return {
    asked,
    found: parts.length > 0 ? parts.join(" · ") : "Limited data",
  };
}

// ─── fetch_full_article ────────────────────────────────────────────

function summarizeFullArticle(input: Json, output: Json): ToolSummary {
  const i = asObj(input);
  const o = asObj(output);
  const url = asStr(i.url) ?? "";
  const host = url.replace(/^https?:\/\//, "").split("/")[0] ?? "article";
  const asked = `Full text of ${host}`;
  const text = asStr(o.text) ?? asStr(o.body);
  if (!text) return { asked, found: "Fetch failed" };
  return {
    asked,
    found: `Pulled ${text.length.toLocaleString()} chars`,
  };
}

// ─── submit_classification / submit_verdict ────────────────────────

function summarizeSubmitClassification(input: Json, _: Json): ToolSummary {
  void _;
  const i = asObj(input);
  const t = asStr(i.event_type) ?? "?";
  const s = asStr(i.sentiment) ?? "?";
  const conf = asNum(i.confidence);
  return {
    asked: "Submit classification",
    found:
      conf != null
        ? `${t} · ${s} · ${fmtPct(conf)} confidence`
        : `${t} · ${s}`,
  };
}

function summarizeSubmitVerdict(input: Json, _: Json): ToolSummary {
  void _;
  const i = asObj(input);
  const v = asStr(i.verdict) ?? "?";
  const tier = asStr(i.new_tier);
  return {
    asked: "Submit verdict",
    found: tier ? `${v} → ${tier} tier` : v,
  };
}
