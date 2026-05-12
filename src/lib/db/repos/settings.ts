/**
 * Repository — `user_settings` (single-row KV store for now).
 *
 * Build-a-thon scope: one user, one config. Easy to expand later by adding
 * a `user_id` column.
 */

import { db } from "../client";

export interface SettingsSnapshot {
  auto_trade_enabled: boolean;
  auto_trade_min_confidence: number; // 0..1
  review_min_confidence: number;
  info_min_confidence: number;
  default_position_size_usd: number;
  max_concurrent_positions: number;
  max_daily_trades: number;
  default_stop_loss_pct: number; // e.g. 8 = 8%
  default_take_profit_pct: number;
  paper_starting_balance_usd: number;
  // ── AlphaIndex ──
  /** When true, scheduled rebalances actually execute trades. */
  index_auto_rebalance: boolean;
  /** Drop assets below this weight (in %). */
  index_min_position_pct: number;
  /** Cap any single asset at this weight (in %). */
  index_max_position_pct: number;
  /** Always hold this much in USDC for liquidity (in %). */
  index_cash_reserve_pct: number;
  /** Skip rebalance trades smaller than this weight delta (in %). */
  index_rebalance_threshold_pct: number;
  /** Whether to send candidate weights to Claude for review. */
  index_review_with_claude: boolean;
  /** Allocation framework selector. v1 = legacy anchor+momentum;
   *  v2 = drawdown-controlled (graduated, see FRAMEWORK_NOTES.md). */
  index_framework_version: "v1" | "v2";
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
];

/** Settings whose value is a boolean. All others are numbers (default)
 *  unless listed in STRING_KEYS. */
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
  index_auto_rebalance: false,
  index_min_position_pct: 2,
  index_max_position_pct: 25,
  index_cash_reserve_pct: 5,
  index_rebalance_threshold_pct: 1,
  index_review_with_claude: true,
  index_framework_version: "v1",
};

/** Read all settings as a typed snapshot, falling back to defaults. */
export function getSettings(): SettingsSnapshot {
  const rows = db()
    .prepare<[], RawRow>("SELECT key, value FROM user_settings")
    .all();
  // Build an indexable bag, then cast back to the typed snapshot.
  const out: { [key: string]: unknown } = { ...DEFAULTS };
  for (const r of rows) {
    if (SETTING_KEYS.includes(r.key as keyof SettingsSnapshot)) {
      const k = r.key as keyof SettingsSnapshot;
      out[k] = parseValue(k, r.value);
    }
  }
  return out as unknown as SettingsSnapshot;
}

/** Set a single setting. */
export function setSetting<K extends keyof SettingsSnapshot>(
  key: K,
  value: SettingsSnapshot[K],
): void {
  const raw =
    typeof value === "boolean"
      ? value
        ? "true"
        : "false"
      : typeof value === "string"
        ? value
        : String(value);
  db()
    .prepare(
      `INSERT INTO user_settings (key, value, updated_at)
       VALUES (?, ?, unixepoch() * 1000)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .run(key, raw);
}

/** Bulk update — handy for the settings form. */
export function setSettings(patch: Partial<SettingsSnapshot>): void {
  const tx = db().transaction((p: Partial<SettingsSnapshot>) => {
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) continue;
      setSetting(k as keyof SettingsSnapshot, v as never);
    }
  });
  tx(patch);
}
