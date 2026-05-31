/**
 * Repository — `framework_switches`. Wave 2: async.
 */

import { all, run } from "../client";

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

export async function recordSwitch(input: {
  id: string;
  from_version: string;
  to_version: string;
  user_confirmed_understanding: boolean;
  live_nav_at_switch: number;
  shadow_nav_at_switch: number;
  v1_30d_return: number | null;
  v2_30d_return: number | null;
  notes?: string | null;
}): Promise<void> {
  await run(
    `INSERT INTO framework_switches
       (id, switched_at, from_version, to_version,
        user_confirmed_understanding,
        live_nav_at_switch, shadow_nav_at_switch,
        v1_30d_return, v2_30d_return, notes)
     VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.from_version,
      input.to_version,
      input.user_confirmed_understanding ? 1 : 0,
      input.live_nav_at_switch,
      input.shadow_nav_at_switch,
      input.v1_30d_return,
      input.v2_30d_return,
      input.notes ?? null,
    ],
  );
}

export async function listSwitches(
  limit = 10,
): Promise<FrameworkSwitchRow[]> {
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
  const rows = await all<Raw>(
    `SELECT * FROM framework_switches
     ORDER BY switched_at DESC
     LIMIT ?`,
    [limit],
  );
  return rows.map((r) => ({
    ...r,
    user_confirmed_understanding: r.user_confirmed_understanding === 1,
  }));
}
