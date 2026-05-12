/**
 * Part 3 regression — live deployment readiness.
 *
 * Three pieces:
 *   - System health snapshot (last successful runs, stuck-outcome count,
 *     gate refusals, classifier errors, DB size).
 *   - Alerts: insertion when a job hasn't run recently or outcomes are
 *     stuck.
 *   - Backup: nightly DB-file copy with timestamp + 30d retention.
 */

import Database from "better-sqlite3";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { existsSync, mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapSchema,
  _setDatabaseForTests,
  db,
} from "@/lib/db/client";
import {
  buildSystemHealth,
  evaluateAlerts,
  runDatabaseBackup,
  pruneOldBackups,
} from "@/lib/system-health";
import { Alerts } from "@/lib/db";

const NOW = Date.UTC(2026, 4, 9, 12, 0, 0);

describe("Part 3 — system health", () => {
  let memDb: Database.Database;
  let backupDir: string;

  beforeEach(() => {
    memDb = new Database(":memory:");
    memDb.pragma("foreign_keys = ON");
    bootstrapSchema(memDb);
    _setDatabaseForTests(memDb);
    backupDir = mkdtempSync(join(tmpdir(), "sosoalpha-bk-"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    _setDatabaseForTests(null);
    memDb.close();
    rmSync(backupDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  // ─────────────────────────────────────────────────────────────────
  // buildSystemHealth — snapshot returns all expected fields
  // ─────────────────────────────────────────────────────────────────

  describe("buildSystemHealth", () => {
    it("returns the full set of expected fields with defaults on an empty DB", () => {
      const h = buildSystemHealth({ now_ms: NOW });
      // Job freshness (null when no runs yet)
      expect(h.last_classification_run).toBeNull();
      expect(h.last_signal_gen_run).toBeNull();
      expect(h.last_outcome_resolution_run).toBeNull();
      // Counts
      expect(h.stuck_outcomes).toBe(0);
      expect(h.recent_gate_refusals).toEqual([]);
      expect(h.recent_classifier_errors).toBe(0);
      // DB size in bytes
      expect(typeof h.db_size_bytes).toBe("number");
      expect(h.db_size_bytes).toBeGreaterThanOrEqual(0);
    });

    it("counts outcomes stuck in NULL state past expiration", () => {
      // Insert 3 outcomes — one expired+null (stuck), one expired+resolved
      // (not stuck), one not-yet-expired+null (not stuck — within horizon).
      const baseInsert = (
        signal_id: string,
        outcome: string | null,
        expires_at: number,
      ) => {
        db()
          .prepare(
            `INSERT INTO signal_outcomes (
               signal_id, asset_id, direction, catalyst_subtype, asset_class,
               tier, conviction, generated_at, horizon_hours, expires_at,
               target_pct, stop_pct, outcome, recorded_at
             ) VALUES (?, 'tok-test', 'long', 'test', 'large_cap_crypto',
                       'review', 0.6, ?, 24, ?, 5, 3, ?, ?)`,
          )
          .run(signal_id, NOW - 48 * 3600 * 1000, expires_at, outcome, NOW);
      };
      baseInsert("stuck", null, NOW - 1000);
      baseInsert("resolved", "target_hit", NOW - 1000);
      baseInsert("future", null, NOW + 24 * 3600 * 1000);

      const h = buildSystemHealth({ now_ms: NOW });
      expect(h.stuck_outcomes).toBe(1);
    });

    it("groups recent gate refusals by rule", () => {
      db()
        .prepare(
          `INSERT INTO signal_outcomes (
             signal_id, asset_id, direction, catalyst_subtype, asset_class,
             tier, conviction, generated_at, horizon_hours, expires_at,
             target_pct, stop_pct, outcome, outcome_at, notes, recorded_at
           ) VALUES
             ('a','tok-x','long','t','c','info',0.5,?,24,?,5,3,'blocked',?,'blocked: target_exceeds_base_rate',?),
             ('b','tok-x','long','t','c','info',0.5,?,24,?,5,3,'blocked',?,'blocked: target_exceeds_base_rate',?),
             ('c','tok-x','long','t','c','info',0.5,?,24,?,5,3,'blocked',?,'blocked: mechanism_conviction_excess',?)`,
        )
        .run(
          NOW - 3600 * 1000, NOW + 1, NOW, NOW,
          NOW - 3600 * 1000, NOW + 1, NOW, NOW,
          NOW - 3600 * 1000, NOW + 1, NOW, NOW,
        );

      const h = buildSystemHealth({ now_ms: NOW });
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

  // ─────────────────────────────────────────────────────────────────
  // evaluateAlerts — raise alerts based on health
  // ─────────────────────────────────────────────────────────────────

  describe("evaluateAlerts", () => {
    it("raises 'outcomes_stuck' when > 10 outcomes are stuck", () => {
      // Seed 11 stuck outcomes
      for (let i = 0; i < 11; i++) {
        db()
          .prepare(
            `INSERT INTO signal_outcomes (
               signal_id, asset_id, direction, catalyst_subtype, asset_class,
               tier, conviction, generated_at, horizon_hours, expires_at,
               target_pct, stop_pct, outcome, recorded_at
             ) VALUES (?, 'tok-test', 'long', 'test', 'large_cap_crypto',
                       'review', 0.6, ?, 24, ?, 5, 3, NULL, ?)`,
          )
          .run(`stuck-${i}`, NOW - 48 * 3600 * 1000, NOW - 1000, NOW);
      }

      const alerts = evaluateAlerts({ now_ms: NOW });
      expect(alerts.some((a) => a.kind === "outcomes_stuck")).toBe(true);
    });

    it("does NOT raise 'outcomes_stuck' when below threshold", () => {
      for (let i = 0; i < 3; i++) {
        db()
          .prepare(
            `INSERT INTO signal_outcomes (
               signal_id, asset_id, direction, catalyst_subtype, asset_class,
               tier, conviction, generated_at, horizon_hours, expires_at,
               target_pct, stop_pct, outcome, recorded_at
             ) VALUES (?, 'tok-test', 'long', 'test', 'large_cap_crypto',
                       'review', 0.6, ?, 24, ?, 5, 3, NULL, ?)`,
          )
          .run(`stuck-${i}`, NOW - 48 * 3600 * 1000, NOW - 1000, NOW);
      }

      const alerts = evaluateAlerts({ now_ms: NOW });
      expect(alerts.some((a) => a.kind === "outcomes_stuck")).toBe(false);
    });

    it("raises 'job_stale' when a scheduled job hasn't run in > 2× its interval", () => {
      // Seed a stale 'compute_patterns' run from 6h ago (interval = 30m,
      // 6h is way past 2×30m).
      db()
        .prepare(
          `INSERT INTO cron_runs (job, started_at, finished_at, status, summary)
           VALUES ('compute_patterns', ?, ?, 'ok', 'last run')`,
        )
        .run(NOW - 6 * 3600 * 1000, NOW - 6 * 3600 * 1000 + 1000);

      const alerts = evaluateAlerts({ now_ms: NOW });
      expect(alerts.some((a) => a.kind === "job_stale")).toBe(true);
    });

    it("inserts alert rows in system_alerts (idempotent — duplicate raises within 1h are coalesced)", () => {
      // Pre-condition: no open alerts
      expect(Alerts.listOpenAlerts()).toHaveLength(0);
      Alerts.raiseAlert("outcomes_stuck", "warn", "test alert");
      Alerts.raiseAlert("outcomes_stuck", "warn", "test alert again");
      const open = Alerts.listOpenAlerts();
      // Same kind + open + recent → second raiseAlert is coalesced.
      expect(open).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Backup
  // ─────────────────────────────────────────────────────────────────

  describe("runDatabaseBackup + pruneOldBackups", () => {
    it("creates a timestamped backup file in the target directory", () => {
      // Provide a sentinel source file so the copy has something to copy.
      const sourcePath = join(backupDir, "src.db");
      writeFileSync(sourcePath, "fake-db-bytes");
      const r = runDatabaseBackup({
        backup_dir: backupDir,
        now_ms: NOW,
        source_path: sourcePath,
      });
      expect(r.ok).toBe(true);
      expect(existsSync(r.path!)).toBe(true);
      // Filename must include the timestamp so retention is straightforward.
      expect(r.path!).toContain("sosoalpha-2026-05-09");
    });

    it("pruneOldBackups deletes files older than 30 days", () => {
      // Manually create 35 fake backup files spanning 60 days back; assert
      // pruning leaves only the most-recent 30 days (we use mtime as proxy
      // since we control file creation in the test).
      for (let i = 0; i < 35; i++) {
        const path = join(backupDir, `sosoalpha-fake-${i}.db`);
        writeFileSync(path, "");
        const mtime = NOW - i * 24 * 3600 * 1000;
        // utimesSync on Windows: use Number() seconds.
        const sec = mtime / 1000;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("node:fs").utimesSync(path, sec, sec);
      }
      const r = pruneOldBackups({ backup_dir: backupDir, now_ms: NOW });
      // Retention rule: keep 30 days. All older files removed.
      expect(r.deleted).toBeGreaterThanOrEqual(4);
      const remaining = readdirSync(backupDir);
      expect(remaining.length).toBeLessThanOrEqual(31);
    });
  });
});
