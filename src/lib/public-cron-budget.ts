/**
 * Public-cron rate limit.
 *
 * The Briefing "Regenerate" and AlphaIndex "Rebalance" buttons on the
 * live deploy let any anonymous visitor trigger an expensive operation.
 * The cron endpoints proper are CRON_SECRET-protected, so we expose
 * thin public wrappers (/api/public/*) that mirror the cron logic but
 * apply an in-table rate limit instead of a shared-secret check.
 *
 * Strategy: look at `cron_runs` for the same job, and refuse if the
 * latest started_at is more recent than the configured min interval.
 * Combined with the existing per-day idempotency on briefing
 * (`?force=1` not allowed from public callers) and Anthropic's
 * server-side spend cap, this is enough to make the buttons safe to
 * leave on a public deploy.
 */

import { Cron } from "@/lib/db";
import type { JobName } from "@/lib/db/repos/cron";

export interface PublicCronVerdict {
  ok: boolean;
  reason?: string;
  retry_after_s?: number;
  last_run_started_at?: number;
}

export async function checkPublicCronBudget(
  job: JobName,
  minIntervalS: number,
): Promise<PublicCronVerdict> {
  const last = await Cron.lastRun(job);
  if (!last) return { ok: true };

  const ageMs = Date.now() - last.started_at;
  const intervalMs = minIntervalS * 1000;

  if (ageMs < intervalMs) {
    const retryS = Math.ceil((intervalMs - ageMs) / 1000);
    const sinceS = Math.round(ageMs / 1000);
    return {
      ok: false,
      reason:
        `Rate limited — last ${humanJob(job)} ran ${sinceS}s ago. ` +
        `Try again in ${retryS}s.`,
      retry_after_s: retryS,
      last_run_started_at: last.started_at,
    };
  }

  // If the last run is still in flight, refuse (so a slow run doesn't
  // pile up parallel invocations).
  if (last.status === "running") {
    return {
      ok: false,
      reason: `A ${humanJob(job)} is already running — wait for it to finish.`,
      retry_after_s: 30,
      last_run_started_at: last.started_at,
    };
  }

  return { ok: true };
}

function humanJob(j: JobName): string {
  switch (j) {
    case "generate_briefing":
      return "briefing generation";
    case "compute_patterns":
      return "rebalance";
    case "ingest_macro":
      return "macro refresh";
    case "ingest_btc_treasuries":
      return "treasuries refresh";
    case "public_tick":
      return "pipeline tick";
    case "public_generate_signals":
      return "signal generation";
    default:
      return j.replace(/_/g, " ");
  }
}
