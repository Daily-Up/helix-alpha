"use client";

/**
 * HelixStrip — a muted "Traded via Helix" card. SoDEX tags Helix-routed fills
 * with a "helix-" clOrdID prefix; this sums volume, fill count and builder fees
 * paid over 1D / 1W / All for those fills. A "From Event Stream" sub-block then
 * breaks out the slice opened from the Event Stream (a "helix-evt-" prefix — a
 * subset of the totals, never added to them). Small and quiet — it sits at the
 * bottom of the portfolio, a footnote on how much flow went through Helix.
 */

import { compactUsd, money } from "./fmt";
import type {
  HelixStripStats,
  HelixWindow,
  HelixWindowTriple,
} from "@/lib/portfolio/fetch";

const WINDOWS: { key: keyof HelixWindowTriple; label: string }[] = [
  { key: "d1", label: "1D" },
  { key: "w1", label: "1W" },
  { key: "all", label: "All" },
];

const METRICS: { label: string; render: (w: HelixWindow) => string }[] = [
  { label: "Volume", render: (v) => compactUsd(v.volume) },
  { label: "Fills", render: (v) => v.fills.toLocaleString() },
  {
    label: "Builder fees",
    render: (v) => (v.builderFees > 0 ? money(v.builderFees, 4) : "$0"),
  },
];

export function HelixStrip({ helix }: { helix: HelixStripStats | null }) {
  return (
    <div className="trade-terminal flex h-full flex-col rounded-lg border border-line bg-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wider text-fg-dim">
            Traded via Helix
          </span>
          <span className="text-[10px] text-fg-dim">
            fills routed with Helix&apos;s builder code
          </span>
        </div>
      </div>

      <div className="grid grid-cols-[auto_repeat(3,minmax(0,1fr))] gap-x-4 gap-y-1.5 text-[11.5px]">
        {/* header row */}
        <span />
        {WINDOWS.map((w) => (
          <span
            key={w.key}
            className="text-right text-[9px] uppercase tracking-wider text-fg-dim"
          >
            {w.label}
          </span>
        ))}

        {METRICS.map((m) => (
          <Row key={m.label} label={m.label} render={m.render} windows={helix} />
        ))}

        {/* From Event Stream — the helix-evt- subset of the totals above. */}
        <span className="col-span-4 mt-2 border-t border-line pt-2 text-[9px] uppercase tracking-wider text-fg-dim">
          From Event Stream
        </span>
        {METRICS.map((m) => (
          <Row
            key={`evt-${m.label}`}
            label={m.label}
            render={m.render}
            windows={helix?.evt ?? null}
            muted
          />
        ))}
      </div>
    </div>
  );
}

function Row({
  label,
  render,
  windows,
  muted,
}: {
  label: string;
  render: (w: HelixWindow) => string;
  windows: HelixWindowTriple | null;
  muted?: boolean;
}) {
  return (
    <>
      <span className={muted ? "text-fg-dim" : "text-fg-muted"}>{label}</span>
      {WINDOWS.map((w) => (
        <span
          key={w.key}
          className={`text-right font-[var(--font-jetbrains-mono)] tabular-nums ${
            muted ? "text-fg-muted" : "text-fg"
          }`}
        >
          {windows ? render(windows[w.key]) : "—"}
        </span>
      ))}
    </>
  );
}
