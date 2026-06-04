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
    case "query_market_regime":
      return summarizeMarketRegime(input, output);
    case "query_similar_catalyst":
      return summarizeSimilarCatalyst(input, output);
    case "query_macro_context":
      return summarizeMacroContext(input, output);
    case "search_x_live":
      return summarizeXLive(input, output);
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
  const asked = `${symbol} signal + price history for the last ${days} ${plural(days, "day")}`;

  const parts: string[] = [];
  // Signal history
  const sum = asObj(o.summary);
  const nSig = asNum(sum.n_signals);
  if (nSig != null && nSig > 0) {
    parts.push(`${nSig} prior ${plural(nSig, "signal")}`);
    const hit = asNum(sum.hit_rate);
    if (hit != null) parts.push(`${fmtPct(hit)} hit rate`);
  }
  // Price trend (new — populated by klines_daily)
  const trend = asObj(o.price_trend);
  const lastPrice = asNum(trend.last_price);
  if (lastPrice != null) {
    parts.push(
      lastPrice >= 1000
        ? `$${Math.round(lastPrice).toLocaleString()}`
        : `$${lastPrice.toFixed(2)}`,
    );
  }
  const pct7 = asNum(trend.pct_change_7d);
  const pct14 = asNum(trend.pct_change_14d);
  if (pct7 != null) parts.push(`${fmtMove(pct7)} 7d`);
  else if (pct14 != null) parts.push(`${fmtMove(pct14)} 14d`);

  return {
    asked,
    found: parts.length > 0 ? parts.join(" · ") : "No prior signals, no kline coverage for this asset",
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

// ─── query_market_regime ───────────────────────────────────────────

function summarizeMarketRegime(input: Json, output: Json): ToolSummary {
  const i = asObj(input);
  const o = asObj(output);
  const symbol = asStr(i.symbol) ?? "BTC";
  const dt = asStr(i.datetime);
  const asked = dt
    ? `${symbol} market regime at ${dt.slice(0, 10)}`
    : `Current ${symbol} market regime`;

  if (o.found === false) return { asked, found: "No data available" };
  const trend = asStr(o.trend);
  const dd = asNum(o.drawdown_pct);
  const r30 = asNum(o.return_30d_pct);
  const rsi = asNum(o.rsi_14);
  const days = asNum(o.days_since_ath);
  if (!trend) return { asked, found: "No data available" };
  const parts = [
    trend.toUpperCase(),
    dd != null ? `${dd.toFixed(1)}% from ATH` : "",
    days != null ? `${days}d since ATH` : "",
    r30 != null ? `${fmtMove(r30)} 30d` : "",
    rsi != null ? `RSI ${rsi.toFixed(0)}` : "",
  ].filter(Boolean);
  return { asked, found: parts.join(" · ") };
}

// ─── query_similar_catalyst ────────────────────────────────────────

function summarizeSimilarCatalyst(input: Json, output: Json): ToolSummary {
  const i = asObj(input);
  const o = asObj(output);
  const category = asStr(i.category) ?? "?";
  const horizon = asStr(i.horizon) ?? "7d";
  const asked = `Historical ${category.replace(/_/g, " ")} events @ ${horizon}`;

  const n = asNum(o.sample_size);
  if (n == null || n === 0) {
    return { asked, found: "No matching historical events" };
  }
  const mean = asNum(o.btc_mean_pct);
  const median = asNum(o.btc_median_pct);
  const hit = asNum(o.btc_hit_rate_pos);
  const parts = [
    `n=${n}`,
    median != null ? `${fmtMove(median)} median BTC` : "",
    mean != null ? `${fmtMove(mean)} mean` : "",
    hit != null ? `${fmtPct(hit)} positive` : "",
  ].filter(Boolean);
  return { asked, found: parts.join(" · ") };
}

// ─── query_macro_context ───────────────────────────────────────────

function summarizeMacroContext(input: Json, output: Json): ToolSummary {
  const i = asObj(input);
  const o = asObj(output);
  const mode = asStr(i.mode) ?? "nearest";
  if (mode === "nearest") {
    const date = asStr(i.date) ?? "?";
    const asked = `Macro context near ${date.slice(0, 10)}`;
    if (o.found === false) return { asked, found: "No macro release in window — quiet day" };
    const ev = asObj(o.event);
    const type = asStr(ev.event_type);
    const surprise = asNum(ev.surprise_proxy);
    const btc1d = asNum(ev.btc_move_1d_pct);
    const parts: string[] = [];
    if (type) parts.push(type);
    if (surprise != null) parts.push(`surprise ${fmtMove(surprise)} vs prior`);
    if (btc1d != null) parts.push(`BTC 1d ${fmtMove(btc1d)}`);
    return { asked, found: parts.length > 0 ? parts.join(" · ") : "n/a" };
  }
  // cohort
  const eventType = asStr(i.event_type) ?? "?";
  const surpriseSign = asStr(i.surprise_sign) ?? "any";
  const asked = `Past ${eventType} reactions (surprise=${surpriseSign})`;
  const n = asNum(o.sample_size);
  if (!n) return { asked, found: "No matching events" };
  const med = asNum(o.btc_1d_median_pct);
  const hit = asNum(o.btc_1d_hit_rate);
  const parts = [
    `n=${n}`,
    med != null ? `BTC 1d median ${fmtMove(med)}` : "",
    hit != null ? `${fmtPct(hit)} positive` : "",
  ].filter(Boolean);
  return { asked, found: parts.join(" · ") };
}

// ─── search_x_live ────────────────────────────────────────────────

function summarizeXLive(input: Json, output: Json): ToolSummary {
  const i = asObj(input);
  const o = asObj(output);
  const query = asStr(i.query) ?? "(no query)";
  const hrs = asNum(i.max_age_hours) ?? 24;
  // Resolve mode: explicit `mode` wins, fall back to legacy `trusted_only`,
  // otherwise default to noise_filter. Same logic as the tool.
  const explicitMode = asStr(i.mode);
  const mode: "trusted_only" | "noise_filter" | "all" =
    (explicitMode === "trusted_only" ||
    explicitMode === "noise_filter" ||
    explicitMode === "all"
      ? explicitMode
      : null) ??
    (i.trusted_only === true ? "trusted_only" : "noise_filter");

  const modeLabel =
    mode === "trusted_only"
      ? "trusted accounts only"
      : mode === "noise_filter"
        ? "noise-filtered"
        : "all results";
  const asked = `Live X search for "${query}" — ${modeLabel}, last ${hrs}h`;

  const matched = asNum(o.matched_count) ?? 0;
  if (matched === 0) {
    return { asked, found: "No tweets in window" };
  }
  const results = asArr(o.results);
  const authors = new Set<string>();
  for (const t of results) {
    const a = asStr(asObj(t).author);
    if (a) authors.add(`@${a}`);
  }
  const top = [...authors].slice(0, 3).join(", ");
  return {
    asked,
    found: `${matched} ${plural(matched, "tweet")} from ${top}${authors.size > 3 ? ` + ${authors.size - 3} more` : ""}`,
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
