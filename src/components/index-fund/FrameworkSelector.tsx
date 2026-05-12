"use client";

/**
 * Framework selector + confirmation modal (I-36).
 *
 * Lives in the AlphaIndex live tab header. Default is v1; switching to
 * v2.1 requires explicit user acknowledgement of the documented
 * trade-offs and any marginal-pass criteria via a checkbox in a
 * confirmation modal. Switching back to v1 is one-click.
 *
 * The modal fetches /api/data/alphaindex/v2-status to render the latest
 * acceptance criteria and any marginal notes — it must show the
 * up-to-date status, not a hardcoded snapshot.
 */

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/components/ui/cn";

type Framework = "v1" | "v2";

interface CriterionRow {
  key: string;
  label: string;
  status: "pass" | "marginal" | "fail";
  observed: number;
  threshold: number;
  detail: string;
  marginal_note?: string;
}

interface AcceptanceData {
  passed: boolean;
  criteria: CriterionRow[];
}

export function FrameworkSelector({ onChange }: { onChange?: (fw: Framework) => void }) {
  const [current, setCurrent] = useState<Framework>("v1");
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [ack, setAck] = useState(false);
  const [acceptance, setAcceptance] = useState<AcceptanceData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initial load: current setting
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/settings/framework");
        const j = await r.json();
        if (!cancelled && j.ok) setCurrent(j.framework);
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Lazily fetch acceptance status when the modal opens.
  const openV2Modal = useCallback(async () => {
    setShowModal(true);
    setAck(false);
    setError(null);
    if (!acceptance) {
      try {
        const r = await fetch("/api/data/alphaindex/v2-status");
        const j = await r.json();
        if (j.ok && j.acceptance) setAcceptance(j.acceptance);
      } catch (err) {
        setError(`failed to load acceptance status: ${(err as Error).message}`);
      }
    }
  }, [acceptance]);

  const applyV2 = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/settings/framework", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ framework: "v2", confirmed: true }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? "failed to set framework");
      setCurrent("v2");
      setShowModal(false);
      onChange?.("v2");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [onChange]);

  const revertToV1 = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/settings/framework", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ framework: "v1" }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? "failed");
      setCurrent("v1");
      onChange?.("v1");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [onChange]);

  if (loading) return null;

  return (
    <>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-fg-dim">Framework:</span>
        <button
          onClick={() => current !== "v1" && revertToV1()}
          disabled={busy}
          className={cn(
            "rounded border px-2 py-1 transition-colors",
            current === "v1"
              ? "border-accent bg-accent/15 text-accent-2"
              : "border-line text-fg-muted hover:border-line-2",
          )}
        >
          v1
        </button>
        <button
          onClick={() => current !== "v2" && openV2Modal()}
          disabled={busy}
          className={cn(
            "rounded border px-2 py-1 transition-colors",
            current === "v2"
              ? "border-warning bg-warning/15 text-warning"
              : "border-line text-fg-muted hover:border-line-2",
          )}
        >
          v2.1
        </button>
      </div>

      {showModal ? (
        <ConfirmationModal
          acceptance={acceptance}
          ack={ack}
          setAck={setAck}
          onCancel={() => setShowModal(false)}
          onApply={applyV2}
          busy={busy}
          error={error}
        />
      ) : null}
    </>
  );
}

function ConfirmationModal({
  acceptance,
  ack,
  setAck,
  onCancel,
  onApply,
  busy,
  error,
}: {
  acceptance: AcceptanceData | null;
  ack: boolean;
  setAck: (v: boolean) => void;
  onCancel: () => void;
  onApply: () => void;
  busy: boolean;
  error: string | null;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-line bg-surface p-5 shadow-xl">
        <h3 className="mb-2 text-base font-semibold text-fg">
          Switch live portfolio to v2.1?
        </h3>
        <p className="mb-3 text-xs text-fg-muted">
          v2.1 is a drawdown-controlled long-only allocation framework.
          It is graduated, but its design trade-offs are real and you
          should understand them before applying it to the live
          portfolio. v1 (the current default) and v2.1 produce
          different portfolios.
        </p>

        {/* Acceptance criteria summary */}
        {acceptance ? (
          <div className="mb-3 flex flex-col gap-1.5">
            {acceptance.criteria.map((c) => {
              const cls =
                c.status === "pass"
                  ? "border-positive/40 bg-positive/5 text-positive"
                  : c.status === "marginal"
                    ? "border-warning/50 bg-warning/10 text-warning"
                    : "border-negative/40 bg-negative/5 text-negative";
              return (
                <div
                  key={c.key}
                  className={cn(
                    "rounded border px-2.5 py-1.5 text-[11px]",
                    cls,
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{c.label}</span>
                    <span className="uppercase tracking-wider text-[10px]">
                      {c.status === "marginal" ? "marginal pass" : c.status}
                    </span>
                  </div>
                  <div className="mt-0.5 text-fg-muted">
                    observed {c.observed} · threshold {c.threshold}
                  </div>
                  {c.marginal_note ? (
                    <div className="mt-0.5">{c.marginal_note}</div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="mb-3 text-xs text-fg-dim">
            Loading acceptance status…
          </div>
        )}

        {/* Why v2.1? — plain-language summary (Part 4 polish) */}
        <div className="mb-3 rounded border border-info/30 bg-info/5 px-3 py-2 text-[11px] text-fg">
          <div className="mb-1 text-xs font-semibold text-info">Why v2.1?</div>
          <p className="text-fg-muted">
            v2.1 trades upside for downside protection. In the worst BTC
            bear we&apos;ve measured (-35% over 60 days), v2.1 contained
            the loss to -19%. In trending markets, v2.1 captures roughly
            80% of BTC&apos;s upside. In sideways markets, v2.1 stays
            within ±3% absolute return.
          </p>
          <p className="mt-1 text-fg-muted">
            Choose v2.1 if your goal is to participate in crypto with
            bounded downside. Choose v1 if your goal is maximum upside
            capture and you can tolerate larger drawdowns.
          </p>
        </div>

        {/* Trade-off summary */}
        <div className="mb-3 rounded border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] text-fg-muted">
          <strong className="text-warning">Documented trade-offs.</strong>{" "}
          v2.1 will likely deliver lower upside-capture in trending
          markets and lower absolute Sharpe than v1 or BTC buy-and-hold.
          In return it mechanically bounds drawdown via a circuit
          breaker (-12% NAV → satellites zeroed) and enforces a
          BTC-anchor band [40%, 70%]. Marginal-pass criteria (yellow
          above) indicate observations within 5% of threshold — the gap
          is real and surfaced for transparency. See FRAMEWORK_NOTES.md
          for full details.
        </div>

        {error ? (
          <div className="mb-3 rounded border border-negative/40 bg-negative/10 px-2 py-1 text-[11px] text-negative">
            {error}
          </div>
        ) : null}

        {/* Mandatory acknowledgement */}
        <label className="mb-3 flex items-start gap-2 text-xs text-fg">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            I understand the trade-offs, including any marginal-pass
            criteria above, and want to apply v2.1 to the live portfolio.
            Future rebalances will use the v2.1 framework until I switch
            back to v1.
          </span>
        </label>

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded border border-line bg-surface-2 px-3 py-1.5 text-xs text-fg-muted hover:border-line-2"
          >
            Cancel
          </button>
          <button
            onClick={onApply}
            disabled={!ack || busy}
            className={cn(
              "rounded border px-3 py-1.5 text-xs font-medium transition-colors",
              !ack || busy
                ? "cursor-not-allowed border-line bg-surface-2 text-fg-dim"
                : "border-warning/40 bg-warning/15 text-warning hover:bg-warning/25",
            )}
          >
            {busy ? "Applying…" : "Apply v2.1"}
          </button>
        </div>
      </div>
    </div>
  );
}
