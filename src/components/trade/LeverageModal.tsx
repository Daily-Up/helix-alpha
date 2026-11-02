"use client";

/**
 * LeverageModal — leverage picker for the order ticket. Slider + preset
 * chips (1/2/5/10/20/max, clamped to the symbol's max leverage). Confirm
 * commits; Cancel discards. Rendered as a fixed centered overlay.
 */

import { useEffect, useState } from "react";
import { cn } from "@/components/ui/cn";

const LONG = "#0ecb81";

export function LeverageModal({
  open,
  value,
  max,
  onConfirm,
  onClose,
}: {
  open: boolean;
  value: number;
  max: number;
  onConfirm: (lev: number) => void;
  onClose: () => void;
}) {
  const [lev, setLev] = useState(value);
  useEffect(() => {
    if (open) setLev(value);
  }, [open, value]);

  if (!open) return null;

  const presets = [1, 2, 5, 10, 20, max].filter(
    (v, i, a) => v >= 1 && v <= max && a.indexOf(v) === i,
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Adjust leverage"
    >
      <div
        className="w-full max-w-[300px] rounded-lg border border-line bg-surface p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-[13px] font-medium text-fg">
          Adjust Leverage
        </div>
        <div
          className="mb-3 text-center font-[var(--font-jetbrains-mono)] text-3xl font-semibold tabular-nums"
          style={{ color: LONG }}
        >
          {lev}
          <span className="text-xl">×</span>
        </div>
        <input
          type="range"
          min={1}
          max={max}
          step={1}
          value={lev}
          onChange={(e) => setLev(Number(e.target.value))}
          className="mb-1 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-2"
          style={{ accentColor: LONG }}
          aria-label="Leverage"
        />
        <div className="mb-4 flex justify-between text-[9px] text-fg-dim">
          <span>1×</span>
          <span>{max}×</span>
        </div>
        <div className="mb-4 grid grid-cols-6 gap-1">
          {presets.map((p) => (
            <button
              key={p}
              onClick={() => setLev(p)}
              className={cn(
                "rounded border py-1 text-[11px] tabular-nums transition-colors",
                lev === p
                  ? "border-transparent text-[#0b0e11]"
                  : "border-line text-fg-muted hover:text-fg",
              )}
              style={lev === p ? { backgroundColor: LONG } : undefined}
            >
              {p === max ? `${p}×` : `${p}×`}
            </button>
          ))}
        </div>
        <p className="mb-3 text-[10px] leading-relaxed text-fg-dim">
          Higher leverage raises liquidation risk. Max {max}× for this market;
          the maintenance-margin tier tightens as position size grows.
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => onConfirm(lev)}
            className="flex-1 rounded py-2 text-[13px] font-semibold text-[#0b0e11]"
            style={{ backgroundColor: LONG }}
          >
            Confirm
          </button>
          <button
            onClick={onClose}
            className="flex-1 rounded border border-line py-2 text-[13px] text-fg-muted hover:text-fg"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
