/**
 * Part 3 regression — live deployment readiness. Wave 2: async libSQL.
 *
 * Backup tests dropped: in Wave 2 Turso owns persistence; runDatabaseBackup
 * is a no-op stub kept for caller back-compat.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "@/lib/db/client";
import { setupMemoryDb, teardownMemoryDb } from "./db-setup";
import {
  buildSystemHealth,
  evaluateAlerts,
} from "@/lib/system-health";
import { Alerts } from "@/lib/db";

const NOW = Date.UTC(2026, 4, 9, 12, 0, 0);

describe("Part 3 — system health", () => {
  beforeEach(async () => {
    await setupMemoryDb();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    teardownMemoryDb();
    vi.useRealTimers();
  });

  describe("buildSystemHealth", () => {
    it("returns the full set of expected fields with defaults on an empty DB", async () => {
      const h = await buildSystemHealth({ now_ms: NOW });
      expect(h.last_classification_run).toBeNull();
      expect(h.last_signal_gen_run).toBeNull();
      expect(h.last_outcome_resolution_run).toBeNull();
      expect(h.stuck_outcomes).toBe(0);
      expect(h.recent_gate_refusals).toEqual([]);
      expect(h.recent_classifier_errors).toBe(0);
      expect(typeof h.db_size_bytes).toBe("number");
      expect(h.db_size_bytes).toBeGreaterThanOrEqual(0);
    });

    it("counts outcomes stuck in NULL state past expiration", async () => {
      const baseInsert = async (
        signal_id: string,
        outcome: string | null,
        expires_at: number,
      ) => {
        await run(
          `INSERT INTO signal_outcomes (
             signal_id, asset_id, direction, catalyst_subtype, asset_class,
             tier, conviction, generated_at, horizon_hours, expires_at,
             target_pct, stop_pct, outcome, recorded_at
           ) VALUES (?, 'tok-test', 'long', 'test', 'large_cap_crypto',
                     'review', 0.6, ?, 24, ?, 5, 3, ?, ?)`,
          [signal_id, NOW - 48 * 3600 * 1000, expires_at, outcome, NOW],
        );
      };
      await baseInsert("stuck", null, NOW - 1000);
      await baseInsert("resolved", "target_hit", NOW - 1000);
      await baseInsert("future", null, NOW + 24 * 3600 * 1000);

      const h = await buildSystemHealth({ now_ms: NOW });
      expect(h.stuck_outcomes).toBe(1);
    });

    it("groups recent gate refusals by rule", async () => {
      const baseInsert = async (signal_id: string, notes: string) => {
        await run(
          `INSERT INTO signal_outcomes (
             signal_id, asset_id, direction, catalyst_subtype, asset_class,
             tier, conviction, generated_at, horizon_hours, expires_at,
             target_pct, stop_pct, outcome, outcome_at, notes, recorded_at
           ) VALUES (?, 'tok-x', 'long', 't', 'c', 'info', 0.5, ?, 24, ?, 5, 3, 'blocked', ?, ?, ?)`,
          [signal_id, NOW - 3600 * 1000, NOW + 1, NOW, notes, NOW],
        );
      };
      await baseInsert("a", "blocked: target_exceeds_base_rate");
      await baseInsert("b", "blocked: target_exceeds_base_rate");
      await baseInsert("c", "blocked: mechanism_conviction_excess");

      const h = await buildSystemHealth({ now_ms: NOW });
      expect(h.recent_gate_refusals.length).toBeGreaterThan(0);
      const target = h.recent_gate_refusals.find(
        (r) => r.rule === "target_exceeds_base_rate",
      );
      expect(target?.count).toBe(2);
      const mech = h.recent_gate_refusals.find(
        (r) => r.rule === "mechanism_conviction_excess",
      );
      expect(mech?.count).toBe(1);
    });
  });

  describe("evaluateAlerts", () => {
    it("raises 'outcomes_stuck' when > 10 outcomes are stuck", async () => {
      for (let i = 0; i < 11; i++) {
        await run(
          `INSERT INTO signal_outcomes (
             signal_id, asset_id, direction, catalyst_subtype, asset_class,
             tier, conviction, generated_at, horizon_hours, expires_at,
             target_pct, stop_pct, outcome, recorded_at
           ) VALUES (?, 'tok-test', 'long', 'test', 'large_cap_crypto',
                     'review', 0.6, ?, 24, ?, 5, 3, NULL, ?)`,
          [`stuck-${i}`, NOW - 48 * 3600 * 1000, NOW - 1000, NOW],
        );
      }

      const alerts = await evaluateAlerts({ now_ms: NOW });
      expect(alerts.some((a) => a.kind === "outcomes_stuck")).toBe(true);
    });

    it("does NOT raise 'outcomes_stuck' when below threshold", async () => {
      for (let i = 0; i < 3; i++) {
        await run(
          `INSERT INTO signal_outcomes (
             signal_id, asset_id, direction, catalyst_subtype, asset_class,
             tier, conviction, generated_at, horizon_hours, expires_at,
             target_pct, stop_pct, outcome, recorded_at
           ) VALUES (?, 'tok-test', 'long', 'test', 'large_cap_crypto',
                     'review', 0.6, ?, 24, ?, 5, 3, NULL, ?)`,
          [`stuck-${i}`, NOW - 48 * 3600 * 1000, NOW - 1000, NOW],
        );
      }

      const alerts = await evaluateAlerts({ now_ms: NOW });
      expect(alerts.some((a) => a.kind === "outcomes_stuck")).toBe(false);
    });

    it("raises 'job_stale' when a scheduled job hasn't run in > 2× its interval", async () => {
      await run(
        `INSERT INTO cron_runs (job, started_at, finished_at, status, summary)
         VALUES ('compute_patterns', ?, ?, 'ok', 'last run')`,
        [NOW - 6 * 3600 * 1000, NOW - 6 * 3600 * 1000 + 1000],
      );

      const alerts = await evaluateAlerts({ now_ms: NOW });
      expect(alerts.some((a) => a.kind === "job_stale")).toBe(true);
    });

    it("Alerts.raiseAlert is idempotent within 1h", async () => {
      expect(await Alerts.listOpenAlerts()).toHaveLength(0);
      await Alerts.raiseAlert("outcomes_stuck", "warn", "test alert");
      await Alerts.raiseAlert("outcomes_stuck", "warn", "test alert again");
      const open = await Alerts.listOpenAlerts();
      expect(open).toHaveLength(1);
    });
  });
});
