/**
 * Stage 1 — Ingestion validation.
 *
 * The earliest gate in the pipeline. Garbage that gets past here pollutes
 * everything downstream:
 *   - HTML in titles renders as raw tags in the UI ("looks broken")
 *   - "original text:" prefixes leak source-feed quirks into reasoning
 *   - Mid-sentence ellipsis truncation reveals the article body was used
 *     where the headline should be (parser confusion)
 *   - Doubled source names ("Bloomberg Bloomberg report") indicate
 *     duplicate concatenation in the upstream feed adapter
 *
 * This module rejects malformed input BEFORE it reaches the classifier.
 * The classifier never has to defend against bad shapes.
 *
 * Contract: every news item that reaches stage 2 (classification) has
 * passed `validateTitle` and `sanitizeText` returned non-empty.
 */

import type { IngestionRejectReason } from "./types";

/**
 * Strip HTML tags + decode common entities + normalize whitespace.
 * Idempotent: sanitize(sanitize(x)) === sanitize(x).
 */
export function sanitizeText(s: string | null | undefined): string {
  if (!s) return "";
  return (
    s
      // Strip <script>/<style> with their content first.
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      // Strip remaining HTML tags.
      .replace(/<[^>]+>/g, " ")
      // Decode the entity set we observe in the wild.
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_m, code) =>
        String.fromCharCode(parseInt(code, 10)),
      )
      // Collapse whitespace.
      .replace(/\s+/g, " ")
      .trim()
  );
}

export interface TitleValidationResult {
  ok: boolean;
  reason?: IngestionRejectReason;
  detail?: string;
}

/**
 * Reject titles that show signs of upstream parser failure.
 *
 * We deliberately favor recall over precision: better to drop a few
 * legitimate titles than let one malformed string hit the classifier
 * (where it consumes Claude tokens and then surfaces in the UI).
 */
export function validateTitle(title: string): TitleValidationResult {
  if (!title || !title.trim()) {
    return { ok: false, reason: "empty_after_sanitize" };
  }

  const t = title.trim();

  // 1. Length cap. Real headlines are <200 chars; >250 is body text.
  if (t.length > 250) {
    return {
      ok: false,
      reason: "malformed_title",
      detail: `length=${t.length}`,
    };
  }

  // 2. HTML present (sanitizer should run first, but defense in depth).
  if (/<[a-zA-Z][\s\S]*?>/.test(t)) {
    return { ok: false, reason: "malformed_title", detail: "html_present" };
  }

  // 3. Parser-artifact prefixes. SoSoValue commentary feeds put quoted
  // body text behind these markers when the parser gets confused.
  const PARSER_PREFIXES = [
    /^\s*original\s+text\s*:/i,
    /^\s*body\s*:/i,
    /^\s*content\s*:/i,
    /^\s*excerpt\s*:/i,
    /,\s*original\s+text\s*:/i,
  ];
  for (const re of PARSER_PREFIXES) {
    if (re.test(t)) {
      return { ok: false, reason: "malformed_title", detail: "parser_prefix" };
    }
  }

  // 4. Mid-sentence ellipsis truncation. A headline ending in an
  // ellipsis followed by no actual sentence terminator means the body
  // got cut at character N. e.g. "...there are se…"
  // Match: ends with "…" or "..." preceded by 1-3 lowercase letters
  // (truncation of a word) — not the legitimate "and more..." pattern.
  if (/\b[a-z]{1,3}[…]\s*$/.test(t) || /\b[a-z]{1,3}\.{3,}\s*$/.test(t)) {
    return {
      ok: false,
      reason: "malformed_title",
      detail: "midsentence_truncation",
    };
  }

  // 5. Doubled source name. "Bloomberg Bloomberg report" = upstream
  // adapter concatenated the source name twice.
  if (/\b(\w+)\s+\1\b/i.test(t)) {
    // Whitelist a few legit doublings (e.g. "WSJ WSJ" doesn't actually
    // happen, but "New New York" is a hypothetical false positive).
    // The real pattern is news-org names; allow only one match without
    // an obvious corp-name double.
    const m = t.match(/\b(\w+)\s+\1\b/i);
    if (m && /^(bloomberg|reuters|wsj|cnbc|coindesk|cointelegraph|panews|chaincatcher|decrypt|theblock|forbes)$/i.test(m[1])) {
      return {
        ok: false,
        reason: "malformed_title",
        detail: `doubled_source_${m[1].toLowerCase()}`,
      };
    }
  }

  return { ok: true };
}
