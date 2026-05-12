/**
 * Repository — `framework_switches` (Part 3 of v2.1 attribution).
 *
 * Auditable journal of every framework selection event. Every row
 * captures both frameworks' trailing 30d return at switch time so we
 * can later ask "did the user switch right after a bad month?"
 * (I-38).
 */

import { db } from "../client";

export interface FrameworkSwitchRow {
  id: string;
  switched_at: string;
  from_version: string;
  to_version: string;
  user_confirmed_understanding: boolean;
  live_nav_at_switch: number;
  shadow_nav_at_switch: number;
  v1_30d_return: number | null;
  v2_30d_return: number | null;
  notes: string | null;
}

export function recordSwitch(input: {
  id: string;
  from_version: string;
  to_version: string;
  user_confirmed_understanding: boolean;
  live_nav_at_switch: number;
  shadow_nav_at_switch: number;
  v1_30d_return: number | null;
  v2_30d_return: number | null;
  notes?: string | null;
}): void {
  db()
    .prepare(
      `INSERT INTO framework_switches
         (id, switched_at, from_version, to_version,
          user_confirmed_understanding,
          live_nav_at_switch, shadow_nav_at_switch,
          v1_30d_return, v2_30d_return, notes)
       VALUES
         (@id, datetime('now'), @from_version, @to_version,
          @user_confirmed_understanding,
          @live_nav_at_switch, @shadow_nav_at_switch,
          @v1_30d_return, @v2_30d_return, @notes)`,
    )
    .run({
      id: input.id,
      from_version: input.from_version,
      to_version: input.to_version,
      user_confirmed_understanding: input.user_confirmed_understanding ? 1 : 0,
      live_nav_at_switch: input.live_nav_at_switch,
      shadow_nav_at_switch: input.shadow_nav_at_switch,
      v1_30d_return: input.v1_30d_return,
      v2_30d_return: input.v2_30d_return,
      notes: input.notes ?? null,
    });
}

export function listSwitches(limit = 10): FrameworkSwitchRow[] {
  interface Raw {
    id: string;
    switched_at: string;
    from_version: string;
    to_version: string;
    user_confirmed_understanding: number;
    live_nav_at_switch: number;
    shadow_nav_at_switch: number;
    v1_30d_return: number | null;
    v2_30d_return: number | null;
    notes: string | null;
  }
  const rows = db()
    .prepare<[number], Raw>(
      `SELECT * FROM framework_switches
       ORDER BY switched_at DESC
       LIMIT ?`,
    )
    .all(limit);
  return rows.map((r) => ({
    ...r,
    user_confirmed_understanding: r.user_confirmed_understanding === 1,
  }));
}
