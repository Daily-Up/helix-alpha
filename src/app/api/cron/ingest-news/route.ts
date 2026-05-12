/**
 * POST /api/cron/ingest-news
 *
 * Pulls recent news from SoSoValue, persists, and classifies via Claude.
 * Idempotent — safe to call every 5 minutes from GitHub Actions.
 *
 * Auth: Bearer token (CRON_SECRET) or x-cron-secret header.
 *
 * Optional query params (for one-off backfills):
 *   ?windowMs=21600000      # default 1h, max 7d
 *   ?maxItems=200
 *   ?reclassify=1           # re-run Claude even on already-classified events
 *   ?skipClassify=1         # pull-only (no Claude call)
 */

import { NextResponse } from "next/server";
import { assertCronAuth, cronAuthErrorResponse } from "@/lib/cron-auth";
import { runNewsIngestWithAudit } from "@/lib/ingest";
import { Assets } from "@/lib/db";
import { DEFAULT_UNIVERSE, resolveUniverse } from "@/lib/universe";

export const runtime = "nodejs"; // we use better-sqlite3 native module
export const dynamic = "force-dynamic"; // never cache cron responses
export const maxDuration = 60; // seconds — Vercel Hobby tier max

async function handle(req: Request): Promise<NextResponse> {
  try {
    assertCronAuth(req);
  } catch (err) {
    return cronAuthErrorResponse(err);
  }

  // Ensure assets table is populated before we link events.
  if (Assets.getAllAssets().length === 0) {
    const resolved = await resolveUniverse(DEFAULT_UNIVERSE);
    Assets.upsertAssets(resolved);
  }

  const url = new URL(req.url);
  const opts = {
    windowMs: numParam(url, "windowMs"),
    maxItems: numParam(url, "maxItems"),
    reclassify: boolParam(url, "reclassify"),
    skipClassify: boolParam(url, "skipClassify"),
  };

  try {
    const summary = await runNewsIngestWithAudit(opts);
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message ?? "ingest failed" },
      { status: 500 },
    );
  }
}

function numParam(url: URL, key: string): number | undefined {
  const v = url.searchParams.get(key);
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function boolParam(url: URL, key: string): boolean | undefined {
  const v = url.searchParams.get(key);
  if (v == null) return undefined;
  return v === "1" || v === "true";
}

export async function POST(req: Request) {
  return handle(req);
}

// GET allowed too — easier to test from browser / `curl` without -X POST.
export async function GET(req: Request) {
  return handle(req);
}
