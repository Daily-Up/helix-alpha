/**
 * query_base_rate tool.
 *
 * Returns the curated base-rate data for a (catalyst_subtype × asset_class)
 * cell from data/base-rates.json. This is THE calibration table that
 * Helix's risk derivation reads from at signal-fire time — exposing it to
 * the agent lets it set conviction in line with measured historical moves
 * rather than the model's hunch.
 *
 * Why agent wants this:
 *   "treasury_action × crypto_adjacent_equity: 4.3% mean move, n=12" →
 *   "ok, the historical base rate is mid-single-digits; a conviction of
 *   0.85 with a 15% move expectation would be miscalibrated."
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentTool } from "./types";

interface Input {
  catalyst_subtype: string;
  asset_class: string;
}

interface BaseRateCell {
  mean_move_pct: number;
  stdev_move_pct: number;
  horizon_hours: number;
  sample_size: number;
  notes: string;
}

interface Output {
  catalyst_subtype: string;
  asset_class: string;
  found: boolean;
  cell: BaseRateCell | null;
  available_pairs_for_subtype: string[];
  recommendation: string;
}

let _cached: Record<string, Record<string, BaseRateCell>> | null = null;
function loadBaseRates(): Record<string, Record<string, BaseRateCell>> {
  if (_cached) return _cached;
  const raw = readFileSync(
    resolve(process.cwd(), "data/base-rates.json"),
    "utf8",
  );
  const parsed = JSON.parse(raw) as Record<
    string,
    Record<string, BaseRateCell> | { comment?: string }
  >;
  // Strip the _schema doc entry.
  const out: Record<string, Record<string, BaseRateCell>> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (k.startsWith("_")) continue;
    out[k] = v as Record<string, BaseRateCell>;
  }
  _cached = out;
  return out;
}

export const queryBaseRateTool: AgentTool<Input, Output> = {
  spec: {
    name: "query_base_rate",
    description:
      "Look up the curated empirical base rate for a " +
      "(catalyst_subtype, asset_class) cell. Returns mean move %, " +
      "stdev, horizon hours, and sample size from the calibration " +
      "corpus. Use this to set conviction in line with measured " +
      "historical performance — if the historical mean move is 2% with " +
      "stdev 1.5%, an expected 15% move is structurally implausible.",
    input_schema: {
      type: "object",
      required: ["catalyst_subtype", "asset_class"],
      properties: {
        catalyst_subtype: {
          type: "string",
          description:
            "Fine-grained catalyst subtype. Examples: treasury_action, " +
            "etf_flow_reaction, exploit_drain, regulatory_clarity, " +
            "earnings_reaction, listing_announcement, " +
            "transient_operational, partnership_meaningful, " +
            "fundraising_announcement, governance_proposal.",
        },
        asset_class: {
          type: "string",
          description:
            "Asset class. Valid: large_cap_crypto, mid_cap_crypto, " +
            "small_cap_crypto, crypto_adjacent_equity, broad_equity, " +
            "rwa, crypto_index.",
        },
      },
    },
  },
  async handle(input) {
    const table = loadBaseRates();
    const cellsForSubtype = table[input.catalyst_subtype] ?? {};
    const cell = cellsForSubtype[input.asset_class] ?? null;
    const available = Object.keys(cellsForSubtype);
    let recommendation: string;
    if (cell) {
      const lowSample = cell.sample_size < 5;
      recommendation = lowSample
        ? `Small sample (n=${cell.sample_size}). Treat directionally; do not over-weight.`
        : `Solid cell (n=${cell.sample_size}). Calibrate conviction to mean ${cell.mean_move_pct}% ± ${cell.stdev_move_pct}% over ~${Math.round(cell.horizon_hours / 24)}d.`;
    } else if (available.length > 0) {
      recommendation =
        `No cell for asset_class='${input.asset_class}'. Available classes ` +
        `for this subtype: ${available.join(", ")}. Consider falling back ` +
        `to the closest one if appropriate.`;
    } else {
      recommendation =
        `Subtype '${input.catalyst_subtype}' is not in the calibration ` +
        `corpus. Either the subtype is novel or it's mis-named. Without ` +
        `a base rate, use vol-normalized defaults and flag low confidence.`;
    }
    return {
      catalyst_subtype: input.catalyst_subtype,
      asset_class: input.asset_class,
      found: !!cell,
      cell,
      available_pairs_for_subtype: available,
      recommendation,
    };
  },
};
