/**
 * Cron-route auth.
 *
 * All /api/cron/* routes call assertCronAuth(request). Accepts the secret
 * via either:
 *   - Authorization: Bearer <secret>      (GitHub Actions, curl, etc.)
 *   - x-cron-secret: <secret>             (alternative for clients that
 *                                          can't set Authorization)
 *
 * If CRON_SECRET is unset (local dev), auth is skipped — but a warning is
 * logged so we don't accidentally ship that config to production.
 */

import { NextResponse } from "next/server";

export class CronAuthError extends Error {
  status = 401;
  constructor(public reason: string) {
    super(`cron auth failed: ${reason}`);
  }
}

/**
 * Throws CronAuthError on failure. Call at the top of every cron handler.
 *
 * In production, set CRON_SECRET in Vercel env vars and pass it as an
 * Authorization Bearer token from GitHub Actions.
 */
export function assertCronAuth(req: Request): void {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    if (process.env.NODE_ENV === "production") {
      throw new CronAuthError("CRON_SECRET is not configured");
    }
    // In dev, allow unauthenticated calls so we can curl locally.
    console.warn(
      "[cron-auth] CRON_SECRET not set — allowing request (dev mode)",
    );
    return;
  }

  const auth = req.headers.get("authorization") ?? "";
  const xSecret = req.headers.get("x-cron-secret") ?? "";

  const presented =
    auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : xSecret;

  if (!presented) throw new CronAuthError("missing token");
  if (!timingSafeEqual(presented, expected))
    throw new CronAuthError("token mismatch");
}

/** Convert any error from assertCronAuth into a JSON 401. */
export function cronAuthErrorResponse(err: unknown): NextResponse {
  if (err instanceof CronAuthError) {
    return NextResponse.json({ ok: false, error: err.reason }, { status: 401 });
  }
  return NextResponse.json(
    { ok: false, error: (err as Error).message ?? "unknown error" },
    { status: 500 },
  );
}

/** Constant-time string compare to thwart timing attacks. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
