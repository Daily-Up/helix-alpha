/**
 * Repository — `user_settings` (single-row KV store for now).
 * Wave 2: async (libSQL/Turso).
 */

import { all, run, batch } from "../client";

export interface SettingsSnapshot {
  auto_trade_enabled: boolean;
  auto_trade_min_confidence: number;
  review_min_confidence: number;
  info_min_confidence: number;
  default_position_size_usd: number;
  max_concurrent_positions: number;
  max_daily_trades: number;
  default_stop_loss_pct: number;
  default_take_profit_pct: number;
  paper_starting_balance_usd: number;
  index_auto_rebalance: boolean;
  index_min_position_pct: number;
  index_max_position_pct: number;
  index_cash_reserve_pct: number;
  index_rebalance_threshold_pct: number;
  index_review_with_claude: boolean;
  index_framework_version: "v1" | "v2";
  /** Minimum hours between autonomous rebalances (cadence guard). */
  index_rebalance_interval_hours: number;
}

const SETTING_KEYS: ReadonlyArray<keyof SettingsSnapshot> = [
  "auto_trade_enabled",
  "auto_trade_min_confidence",
  "review_min_confidence",
  "info_min_confidence",
  "default_position_size_usd",
  "max_concurrent_positions",
  "max_daily_trades",
  "default_stop_loss_pct",
  "default_take_profit_pct",
  "paper_starting_balance_usd",
  "index_auto_rebalance",
  "index_min_position_pct",
  "index_max_position_pct",
  "index_cash_reserve_pct",
  "index_rebalance_threshold_pct",
  "index_review_with_claude",
  "index_framework_version",
  "index_rebalance_interval_hours",
];

const BOOLEAN_KEYS = new Set<keyof SettingsSnapshot>([
  "auto_trade_enabled",
  "index_auto_rebalance",
  "index_review_with_claude",
]);
const STRING_KEYS = new Set<keyof SettingsSnapshot>([
  "index_framework_version",
]);

interface RawRow {
  key: string;
  value: string;
}

function parseValue(
  key: keyof SettingsSnapshot,
  raw: string,
): SettingsSnapshot[keyof SettingsSnapshot] {
  if (BOOLEAN_KEYS.has(key)) return raw === "true" || raw === "1";
  if (STRING_KEYS.has(key)) return raw as SettingsSnapshot[keyof SettingsSnapshot];
  return Number(raw);
}

const DEFAULTS: SettingsSnapshot = {
  auto_trade_enabled: false,
  auto_trade_min_confidence: 0.75,
  review_min_confidence: 0.5,
  info_min_confidence: 0.3,
  default_position_size_usd: 500,
  max_concurrent_positions: 5,
  max_daily_trades: 10,
  default_stop_loss_pct: 8,
  default_take_profit_pct: 18,
  paper_starting_balance_usd: 10000,
  // AlphaIndex rebalances itself once per day on the tick. Paper only —
  // simulated fills at live SoDEX prices; see rebalance.ts.
  index_auto_rebalance: true,
  index_min_position_pct: 2,
  index_max_position_pct: 25,
  index_cash_reserve_pct: 5,
  index_rebalance_threshold_pct: 1,
  index_review_with_claude: true,
  index_framework_version: "v2",
  index_rebalance_interval_hours: 24,
};

/** Read all settings as a typed snapshot, falling back to defaults. */
export async function getSettings(): Promise<SettingsSnapshot> {
  const rows = await all<RawRow>("SELECT key, value FROM user_settings");
  const out: { [key: string]: unknown } = { ...DEFAULTS };
  for (const r of rows) {
    if (SETTING_KEYS.includes(r.key as keyof SettingsSnapshot)) {
      const k = r.key as keyof SettingsSnapshot;
      out[k] = parseValue(k, r.value);
    }
  }
  return out as unknown as SettingsSnapshot;
}

function settingArgs<K extends keyof SettingsSnapshot>(
  key: K,
  value: SettingsSnapshot[K],
): [string, string] {
  const raw =
    typeof value === "boolean"
      ? value
        ? "true"
        : "false"
      : typeof value === "string"
        ? value
        : String(value);
  return [key, raw];
}

const UPSERT_SQL = `INSERT INTO user_settings (key, value, updated_at)
 VALUES (?, ?, unixepoch() * 1000)
 ON CONFLICT(key) DO UPDATE SET
   value = excluded.value,
   updated_at = excluded.updated_at`;

/** Set a single setting. */
export async function setSetting<K extends keyof SettingsSnapshot>(
  key: K,
  value: SettingsSnapshot[K],
): Promise<void> {
  await run(UPSERT_SQL, settingArgs(key, value));
}

/** Bulk update — handy for the settings form. */
export async function setSettings(
  patch: Partial<SettingsSnapshot>,
): Promise<void> {
  const stmts: Array<{ sql: string; args: (string | number)[] }> = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    stmts.push({
      sql: UPSERT_SQL,
      args: settingArgs(k as keyof SettingsSnapshot, v as never),
    });
  }
  if (stmts.length > 0) await batch(stmts);
}
