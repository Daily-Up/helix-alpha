/**
 * safeHref — protocol allow-list for URLs rendered into an `<a href>`.
 *
 * React escapes an attribute's VALUE but does NOT block dangerous URL
 * schemes: a `javascript:…` or `data:text/html,…` href still executes on
 * click (the `target` is ignored for `javascript:` URIs). External link
 * fields we render — news `source_link` / `original_link` from the
 * SoSoValue feed — are not authored by us and are not scheme-checked at
 * ingest (`sanitizeText` cleans text, not URL schemes), so we validate at
 * the render layer.
 *
 * Returns the URL only when it is a same-document/relative link or an
 * absolute URL on the allow-list (http/https/mailto). Anything else
 * returns `undefined`, so the `<a>` renders with no href — inert.
 */

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function safeHref(url: string | null | undefined): string | undefined {
  if (url == null) return undefined;
  const trimmed = url.trim();
  if (trimmed === "") return undefined;

  // Same-document / relative links ("/path", "#anchor", "?q=1") have no
  // scheme to abuse.
  if (/^[/#?]/.test(trimmed)) return trimmed;

  try {
    // Absolute URL: allow only the listed schemes. The URL parser
    // normalizes obfuscations ("JavaScript:", "java\tscript:", leading
    // whitespace) to the real protocol — the same normalization a browser
    // applies before dispatching a click — so "javascript:", "data:" and
    // "vbscript:" are rejected here.
    const parsed = new URL(trimmed);
    return ALLOWED_PROTOCOLS.has(parsed.protocol) ? trimmed : undefined;
  } catch {
    // Not parseable as an absolute URL. Reject anything that still looks
    // like it carries a scheme; otherwise treat it as a bare relative path.
    return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? undefined : trimmed;
  }
}
