/**
 * GET/POST /api/cron/backup-db
 *
 * Nightly DB backup. Copies the active SQLite file into
 * `<DATABASE_PATH>/../backups/sosoalpha-YYYY-MM-DD.db` and prunes any
 * files older than 30 days. Schedule once per day (e.g. 03:00 UTC) via
 * the same cron mechanism as tick.
 */

import { NextResponse } from "next/server";
import { dirname, resolve } from "node:path";
import { assertCronAuth, cronAuthErrorResponse } from "@/lib/cron-auth";
import { Cron } from "@/lib/db";
import { Alerts } from "@/lib/db";
import { env } from "@/lib/env";
import { runDatabaseBackup, pruneOldBackups } from "@/lib/system-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(req: Request): Promise<NextResponse> {
  try {
    assertCronAuth(req);
  } catch (err) {
    return cronAuthErrorResponse(err);
  }

  const dbPath = resolve(process.cwd(), env.DATABASE_PATH);
  const backupDir = resolve(dirname(dbPath), "backups");

  try {
    const { data } = await Cron.recordRun("backup_db", async () => {
      const r = runDatabaseBackup({ backup_dir: backupDir });
      const p = pruneOldBackups({ backup_dir: backupDir, retention_days: 30 });
      if (!r.ok) {
        Alerts.raiseAlert("backup_failed", "error", r.error ?? "unknown");
      }
      return {
        summary: `backup ${r.ok ? "ok" : "FAILED"}: ${r.path ?? r.error} · pruned ${p.deleted}`,
        data: { backup: r, prune: p },
      };
    });
    return NextResponse.json({ ok: true, ...data });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
