/**
 * Demo-budget guard for the PUBLIC agent endpoint.
 *
 * The /signal/[id] and /agents pages expose a "Run live agent" button
 * that anyone visiting the deploy can click. To stop a single page-view
 * — or a bot — from running up the Anthropic bill, every public agent
 * invocation goes through this guard first.
 *
 * Two rules:
 *   1. Rate limit: at most N runs in M seconds (default 1 per 30s).
 *   2. Daily spend cap: refuse if today's total agent cost is already
 *      above DEMO_DAILY_SPEND_CAP (default $3.00).
 *
 * Both checks query `agent_traces` directly — no separate table needed,
 * no in-memory state (irrelevant on Vercel serverless anyway).
 */

import { get } from "@/lib/db";

export interface GuardVerdict {
  ok: boolean;
  reason?: string;
  /** Today's spend so far, USD. Always populated. */
  spend_today_usd: number;
  /** Daily cap in effect. */
  spend_cap_usd: number;
  /** Seconds until rate-limit resets, if blocked. */
  retry_after_s?: number;
}

const DEFAULT_DAILY_CAP = 3.0;
const DEFAULT_MIN_INTERVAL_S = 30;

function dailyCap(): number {
  const raw = process.env.DEMO_DAILY_SPEND_CAP;
  if (!raw) return DEFAULT_DAILY_CAP;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_CAP;
}

function minIntervalS(): number {
  const raw = process.env.DEMO_MIN_INTERVAL_S;
  if (!raw) return DEFAULT_MIN_INTERVAL_S;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MIN_INTERVAL_S;
}

/**
 * Check whether a demo agent run can proceed RIGHT NOW. The caller
 * should refuse the request when ok=false and surface `reason` to the
 * UI. We never run the agent if the verdict is not ok.
 */
export async function checkDemoBudget(): Promise<GuardVerdict> {
  const dayStart = startOfTodayUtcMs();
  const cap = dailyCap();
  const minInterval = minIntervalS();

  // 1. Today's total cost from agent_traces (status=ok and error both count
  //    — we paid for the LLM calls either way).
  const todayRow = await get<{ total: number | null }>(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total
       FROM agent_traces
      WHERE started_at >= ?`,
    [dayStart],
  );
  const spend = Number(todayRow?.total ?? 0);

  if (spend >= cap) {
    return {
      ok: false,
      reason:
        `Today's demo budget exhausted ($${spend.toFixed(2)} / $${cap.toFixed(2)}). ` +
        `Resets at 00:00 UTC. Existing traces remain visible.`,
      spend_today_usd: spend,
      spend_cap_usd: cap,
    };
  }

  // 2. Rate limit. Look at the most recent agent trace of any kind in
  //    the last minInterval seconds. We throttle on TOTAL recent agent
  //    activity, not just demo-initiated runs — the spend pool is shared,
  //    so cron-launched runs count for cooldown purposes too.
  const lastRow = await get<{ started_at: number | null }>(
    `SELECT MAX(started_at) AS started_at FROM agent_traces`,
  );
  const last = Number(lastRow?.started_at ?? 0);
  const now = Date.now();
  if (last > 0 && now - last < minInterval * 1000) {
    const retry = Math.ceil((minInterval * 1000 - (now - last)) / 1000);
    return {
      ok: false,
      reason: `Rate limited — last agent run was ${Math.round((now - last) / 1000)}s ago. Wait ${retry}s.`,
      spend_today_usd: spend,
      spend_cap_usd: cap,
      retry_after_s: retry,
    };
  }

  return {
    ok: true,
    spend_today_usd: spend,
    spend_cap_usd: cap,
  };
}

function startOfTodayUtcMs(): number {
  const now = new Date();
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0,
    0,
    0,
    0,
  );
}
