/**
 * Keyless HTTP client for DefiLlama's public datasets + coins hosts.
 *
 * DefiLlama's `api.llama.fi/emissions` is now a paid endpoint (HTTP 402),
 * but the same unlock data — the exact feed the public defillama.com/unlocks
 * page uses — is served KEYLESS from the datasets CDN
 * (`defillama-datasets.llama.fi`), with token prices from `coins.llama.fi`.
 * No auth header, no new secret.
 *
 * Mirrors the shape of `sosovalue/client.ts` (AbortController timeout,
 * 429/5xx exponential-backoff retry) but drops the API-key header and the
 * token-bucket limiter — these are CDN GETs on a different host.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

export class LlamaError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly bodySnippet: string,
  ) {
    super(`DefiLlama ${status} on ${url}: ${bodySnippet.slice(0, 200)}`);
    this.name = "LlamaError";
  }
}

export interface LlamaGetOptions {
  timeoutMs?: number;
  maxRetries?: number;
  initialBackoffMs?: number;
  fetcher?: typeof fetch;
}

/** GET an absolute URL and parse JSON, with timeout + transient retry. */
export async function llamaGet<T>(
  url: string,
  opts: LlamaGetOptions = {},
): Promise<T> {
  const {
    timeoutMs = 25_000,
    maxRetries = 3,
    initialBackoffMs = 800,
    fetcher = fetch,
  } = opts;

  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt <= maxRetries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetcher(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      lastError = err as Error;
      if ((err as Error).name === "AbortError" && attempt < maxRetries) {
        attempt++;
        await sleep(initialBackoffMs * Math.pow(2, attempt - 1));
        continue;
      }
      throw err;
    }
    clearTimeout(timer);

    const text = await res.text();

    if (!res.ok) {
      const err = new LlamaError(res.status, url, text);
      if (isRetryable(res.status) && attempt < maxRetries) {
        const retryAfter = res.headers.get("retry-after");
        const backoff = retryAfter
          ? Number(retryAfter) * 1000
          : initialBackoffMs * Math.pow(2, attempt);
        lastError = err;
        attempt++;
        await sleep(backoff);
        continue;
      }
      throw err;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new LlamaError(res.status, url, `non-JSON body: ${text.slice(0, 120)}`);
    }
  }

  throw lastError ?? new LlamaError(0, url, "retries exhausted");
}
