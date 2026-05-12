/**
 * SoDEX HTTP client — read-only public market endpoints.
 *
 * Auth is NOT required for /markets/* endpoints. We use this to fetch
 * symbols, tickers, candles, and the order book. Write endpoints (placing
 * real orders) require EIP-712 signatures and are NOT implemented here —
 * AlphaTrade uses paper execution with these prices.
 */

const DEFAULT_SPOT_BASE =
  process.env.SODEX_SPOT_REST_URL ?? "https://mainnet-gw.sodex.dev/api/v1/spot";

const DEFAULT_PERPS_BASE =
  process.env.SODEX_PERPS_REST_URL ??
  "https://mainnet-gw.sodex.dev/api/v1/perps";

/** Resolve the base URL for a given SoDEX market kind. */
export function baseFor(market: "spot" | "perp"): string {
  return market === "perp" ? DEFAULT_PERPS_BASE : DEFAULT_SPOT_BASE;
}

export interface SodexErrorPayload {
  status: number;
  statusText: string;
  body: unknown;
  url: string;
}

export class SodexError extends Error {
  public readonly payload: SodexErrorPayload;
  constructor(payload: SodexErrorPayload) {
    super(`SoDEX ${payload.status} ${payload.statusText} on ${payload.url}`);
    this.name = "SodexError";
    this.payload = payload;
  }
}

interface RequestOptions {
  /** Loose type so typed query interfaces are assignable. */
  query?: object;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  baseOverride?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildQs(query: object | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
    if (v == null) continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export async function spotGet<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const {
    query,
    timeoutMs = 15_000,
    fetcher = fetch,
    baseOverride,
  } = options;

  const base = baseOverride ?? DEFAULT_SPOT_BASE;
  const url = `${base}${path}${buildQs(query)}`;

  // Simple retry on transient failures (429 / 5xx).
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetcher(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === "AbortError") {
        throw new SodexError({
          status: 0,
          statusText: "Timeout",
          body: { message: `${url} timed out after ${timeoutMs}ms` },
          url,
        });
      }
      throw err;
    }
    clearTimeout(timer);

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }

    if (!res.ok) {
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
      throw new SodexError({
        status: res.status,
        statusText: res.statusText,
        body: parsed,
        url,
      });
    }

    // SoDEX wraps responses in { code, data } when there's a code field.
    if (
      parsed &&
      typeof parsed === "object" &&
      "data" in parsed
    ) {
      return (parsed as { data: T }).data;
    }
    return parsed as T;
  }

  throw new SodexError({
    status: 0,
    statusText: "RetriesExhausted",
    body: null,
    url,
  });
}
