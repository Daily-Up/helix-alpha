/**
 * POST /api/settings/framework
 *
 * Body: { framework: "v1" | "v2", confirmed: true }
 *
 * Sets `index_framework_version`. The `confirmed: true` flag is a
 * server-side guard (I-36) — the UI's confirmation modal must collect
 * explicit user acknowledgement before this endpoint will accept a
 * switch to v2. Switching back to v1 doesn't require confirmation.
 */

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { FrameworkSwitches, IndexFund, Settings, ShadowPortfolio } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const b = body as { framework?: unknown; confirmed?: unknown };
  const framework = b.framework;
  if (framework !== "v1" && framework !== "v2") {
    return NextResponse.json(
      { ok: false, error: "framework must be 'v1' or 'v2'" },
      { status: 400 },
    );
  }
  // I-36: switching to v2 requires explicit user confirmation. Switching
  // back to v1 is always safe.
  if (framework === "v2" && b.confirmed !== true) {
    return NextResponse.json(
      {
        ok: false,
        error: "v2 selection requires explicit confirmation",
      },
      { status: 400 },
    );
  }

  // Capture context for the switch journal (I-38). Compute trailing
  // 30d returns from each framework's last 30 NAV-history days, where
  // available. Best-effort: if data is sparse the field is null.
  const settings = Settings.getSettings();
  const previous = settings.index_framework_version ?? "v1";
  const switchedFrom = previous as "v1" | "v2";
  const switchedTo = framework as "v1" | "v2";

  // Apply the change first.
  Settings.setSetting("index_framework_version", framework);

  // Only journal real transitions; clicking the current framework is
  // a no-op.
  if (switchedFrom !== switchedTo) {
    try {
      const liveShadow = ShadowPortfolio.getShadow(switchedTo);
      const oldShadow = ShadowPortfolio.getShadow(switchedFrom);
      const v1Ret = compute30dReturnFromRebalances("alphacore", "v1");
      const v2Ret = compute30dReturnFromRebalances("alphacore", "v2");
      FrameworkSwitches.recordSwitch({
        id: randomUUID(),
        from_version: switchedFrom,
        to_version: switchedTo,
        user_confirmed_understanding: switchedTo === "v2" ? true : false,
        live_nav_at_switch: liveShadow?.nav_usd ?? 10_000,
        shadow_nav_at_switch: oldShadow?.nav_usd ?? 10_000,
        v1_30d_return: v1Ret,
        v2_30d_return: v2Ret,
      });
    } catch (err) {
      // Journaling failure must not block the switch itself.
      console.warn(
        "[framework-switch] journal write failed:",
        (err as Error).message,
      );
    }
  }

  return NextResponse.json({ ok: true, framework });
}

/**
 * Approximate trailing 30d return for a framework using its rebalance
 * history. Returns the (last_post_nav − first_pre_nav) / first_pre_nav
 * over the last 30d, or null if fewer than 2 rows exist in the window.
 */
function compute30dReturnFromRebalances(
  indexId: string,
  fw: "v1" | "v2",
): number | null {
  const rebs = IndexFund.listRebalances(indexId, 50)
    .filter(
      (r) =>
        (r.framework_version ?? "v1") === fw &&
        r.rebalanced_at >= Date.now() - 30 * 24 * 3600 * 1000,
    )
    .sort((a, b) => a.rebalanced_at - b.rebalanced_at);
  if (rebs.length < 2) return null;
  const first = rebs[0].pre_nav;
  const last = rebs[rebs.length - 1].post_nav;
  if (first <= 0) return null;
  return Math.round(((last - first) / first) * 1000) / 10;
}

export async function GET() {
  const s = Settings.getSettings();
  return NextResponse.json({ ok: true, framework: s.index_framework_version });
}
