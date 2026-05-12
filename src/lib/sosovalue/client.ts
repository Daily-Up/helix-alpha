/**
 * SoSoValue OpenAPI HTTP client.
 *
 * Thin wrapper over fetch that:
 *   - Injects the x-soso-api-key header
 *   - Builds query strings from a flat object (skipping undefined)
 *   - Throws structured errors with the upstream status + body
 *   - Centralises base URL / timeout policy
 *
 * All endpoint-specific helpers in this folder go through this.
 */

import { env } from "@/lib/env";

export interface SoSoValueErrorPayload {
  status: number;
  statusText: string;
  body: unknown;
  url: string;
}

export class SoSoValueError extends Error {
  public readonly payload: SoSoValueErrorPayload;
  constructor(payload: SoSoValueErrorPayload) {
    super(
      `SoSoValue API ${payload.status} ${payload.statusText} on ${payload.url}`,
    );
    this.name = "SoSoValueError";
    this.payload = payload;
  }
}

export type QueryValue = string | number | boolean | undefined | null;

/**
 * Any plain object whose values are query-compatible primitives.
 *
 * This is intentionally loose so typed query interfaces (NewsQuery, etc.)
 * with optional fields are assignable without requiring an index signature.
 */
export type QueryObject = object;

export interface RequestOptions {
  /** Query parameters; undefined values are dropped. */
  query?: QueryObject;
  /** Request timeout in ms (default 20s). */
  timeoutMs?: number;
  /** Override fetch (for tests). */
  fetcher?: typeof fetch;
  /** Cache hint passed to Next.js fetch. */
  next?: { revalidate?: number; tags?: string[] };
  /** Max retries on 429 / 5xx (default 3). */
  maxRetries?: number;
  /** Initial backoff in ms (default 1000, doubles each retry). */
  initialBackoffMs?: number;
}

function buildQueryString(query: QueryObject | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

/**
 * Perform a GET request against the SoSoValue OpenAPI.
 * The path should be the endpoint after `/openapi/v1`, e.g. `/news` or
 * `/currencies/{id}/klines`.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Should we retry this status code? 429 + 5xx are transient. */
function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

// ─────────────────────────────────────────────────────────────────────────
// Rate limiter — token bucket
// ─────────────────────────────────────────────────────────────────────────
//
// SoSoValue OpenAPI ceiling is 20 requests / minute. Without this the
// backfill / batch ingest scripts hit 429 cascades. Implemented as a
// process-local FIFO queue: every sosoGet() awaits a permit before
// firing, so callers don't need to think about throttling.
//
// Burst size = 20, refill = 1 token every 3 seconds (= 20/min).

const TOKENS_PER_MINUTE = Number(
  process.env.SOSOVALUE_RATE_LIMIT_PER_MIN ?? "20",
);
const REFILL_INTERVAL_MS = Math.ceil(60_000 / Math.max(1, TOKENS_PER_MINUTE));

let _tokens = TOKENS_PER_MINUTE;
let _lastRefill = Date.now();
const _waitQueue: Array<() => void> = [];

function tickRefill(): void {
  const now = Date.now();
  const elapsed = now - _lastRefill;
  const earned = Math.floor(elapsed / REFILL_INTERVAL_MS);
  if (earned > 0) {
    _tokens = Math.min(TOKENS_PER_MINUTE, _tokens + earned);
    _lastRefill += earned * REFILL_INTERVAL_MS;
  }
  while (_tokens > 0 && _waitQueue.length > 0) {
    _tokens--;
    const resolve = _waitQueue.shift()!;
    resolve();
  }
}

/** Block until a permit is available. Always resolves; never throws. */
async function acquireRateLimit(): Promise<void> {
  tickRefill();
  if (_tokens > 0) {
    _tokens--;
    return;
  }
  // Wait in line.
  await new Promise<void>((resolve) => {
    _waitQueue.push(resolve);
  });
}

// Background tick so queued requests get released even if no new ones arrive.
if (typeof setInterval !== "undefined") {
  setInterval(tickRefill, 500).unref?.();
}

export async function sosoGet<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const {
    query,
    timeoutMs = 20_000,
    fetcher = fetch,
    next,
    maxRetries = 3,
    initialBackoffMs = 1000,
  } = options;

  const url = `${env.SOSOVALUE_BASE_URL}${path}${buildQueryString(query)}`;

  let attempt = 0;
  let lastError: SoSoValueError | null = null;

  while (attempt <= maxRetries) {
    // Global rate limit — wait for a permit before every attempt.
    await acquireRateLimit();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetcher(url, {
        method: "GET",
        headers: {
          "x-soso-api-key": env.SOSOVALUE_API_KEY,
          Accept: "application/json",
        },
        signal: controller.signal,
        ...(next ? { next } : {}),
      });
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === "AbortError") {
        throw new SoSoValueError({
          status: 0,
          statusText: "Timeout",
          body: { message: `Request to ${url} timed out after ${timeoutMs}ms` },
          url,
        });
      }
      throw err;
    }
    clearTimeout(timer);

    let parsed: unknown;
    const text = await response.text();
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }

    if (!response.ok) {
      const error = new SoSoValueError({
        status: response.status,
        statusText: response.statusText,
        body: parsed,
        url,
      });

      // Retry on 429 / 5xx with exponential backoff (and honour Retry-After if present).
      if (isRetryable(response.status) && attempt < maxRetries) {
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterMs = retryAfterHeader
          ? Number(retryAfterHeader) * 1000
          : initialBackoffMs * Math.pow(2, attempt);
        lastError = error;
        attempt++;
        await sleep(retryAfterMs);
        continue;
      }
      throw error;
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      "data" in parsed &&
      !("list" in (parsed as Record<string, unknown>))
    ) {
      return (parsed as { data: T }).data;
    }
    return parsed as T;
  }

  // Exhausted retries.
  throw lastError ?? new SoSoValueError({
    status: 0,
    statusText: "RetriesExhausted",
    body: null,
    url,
  });
}
