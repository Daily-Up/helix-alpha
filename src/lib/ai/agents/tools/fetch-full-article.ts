/**
 * fetch_full_article tool.
 *
 * The classifier only sees the title + a short snippet by default. When
 * the headline is ambiguous ("Major exchange halts withdrawals"), the
 * agent often needs the full article body to decide what it actually
 * means. This tool fetches the URL and extracts the main text.
 *
 * Implementation is intentionally simple — strip script/style/nav,
 * collapse whitespace, take what's left. It's not a perfect readability
 * parser but it's good enough to let Claude reason on substantive
 * paragraphs instead of just headlines.
 */

import type { AgentTool } from "./types";

interface Input {
  url: string;
  /** Max chars of extracted body to return. Default 4000. */
  max_chars?: number;
}

interface Output {
  url: string;
  final_url: string;
  http_status: number;
  title: string | null;
  text: string;
  text_length: number;
  truncated: boolean;
  notes?: string;
}

const MAX_FETCH_BYTES = 1_000_000; // 1 MB ceiling
const FETCH_TIMEOUT_MS = 12_000;

export const fetchFullArticleTool: AgentTool<Input, Output> = {
  spec: {
    name: "fetch_full_article",
    description:
      "Fetch a news article's URL and return its extracted main text. " +
      "Use this when the headline alone is ambiguous and you need to read " +
      "the article body to classify accurately. The output is a cleaned " +
      "plain-text snippet — no HTML, no nav, no comments. Truncated to " +
      "the most informative section.",
    input_schema: {
      type: "object",
      required: ["url"],
      properties: {
        url: {
          type: "string",
          description:
            "Absolute URL of the article. Use the source_link from the news event.",
        },
        max_chars: {
          type: "number",
          description: "Max chars of body to return. Default 4000, max 8000.",
        },
      },
    },
  },
  async handle(input) {
    if (!input.url || !/^https?:\/\//i.test(input.url)) {
      throw new Error(`invalid url: ${input.url}`);
    }
    const maxChars = Math.min(8000, Math.max(500, input.max_chars ?? 4000));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(input.url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          // Some outlets block the default node fetch UA.
          "user-agent":
            "Mozilla/5.0 (compatible; HelixResearchAgent/1.0; +https://helix-alpha-kappa.vercel.app)",
          accept: "text/html,*/*",
        },
      });

      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("text/html") && !ct.includes("text/plain")) {
        return {
          url: input.url,
          final_url: res.url,
          http_status: res.status,
          title: null,
          text: "",
          text_length: 0,
          truncated: false,
          notes: `non-HTML response (${ct || "no content-type"})`,
        };
      }

      // Read up to the byte ceiling so a giant page doesn't OOM us.
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (reader) {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(value);
          total += value.length;
          if (total >= MAX_FETCH_BYTES) {
            await reader.cancel();
            break;
          }
        }
      }
      const html = new TextDecoder("utf-8", { fatal: false }).decode(
        concat(chunks),
      );

      const title = extractTitle(html);
      const text = extractMainText(html, maxChars);
      return {
        url: input.url,
        final_url: res.url,
        http_status: res.status,
        title,
        text,
        text_length: text.length,
        truncated: text.length >= maxChars,
        notes: total >= MAX_FETCH_BYTES ? "page truncated at 1MB" : undefined,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function extractTitle(html: string): string | null {
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!t) return null;
  return decodeEntities(stripTags(t[1])).trim().slice(0, 250) || null;
}

/**
 * Lightweight main-content extraction:
 *  1. Drop script/style/noscript/iframe blocks entirely.
 *  2. Strip remaining tags.
 *  3. Collapse whitespace, drop noise lines (cookie banners, share-this).
 *  4. Take the first N chars worth of substantive paragraphs.
 */
function extractMainText(html: string, maxChars: number): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<iframe[\s\S]*?<\/iframe>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Convert paragraph-like tags to newlines so structure survives.
  s = s.replace(/<\/(p|div|h[1-6]|li|article|section|br)>/gi, "\n");
  s = stripTags(s);
  s = decodeEntities(s);
  s = s
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length >= 40) // drop ultra-short lines (nav, attrs)
    .filter(
      (l) =>
        !/^(share|tweet|facebook|copy link|advertisement|subscribe|cookie|accept all)/i.test(
          l,
        ),
    )
    .join("\n\n");

  return s.slice(0, maxChars).trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x?[0-9a-f]+;/gi, " ");
}
