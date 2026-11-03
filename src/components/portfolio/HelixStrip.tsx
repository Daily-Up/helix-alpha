"use client";

/**
 * HelixStrip — a muted "Traded via Helix" card. SoDEX tags Helix-routed fills
 * with a "helix-" clOrdID prefix; this sums volume, fill count and builder fees
 * paid over 1D / 1W / All for those fills. Small and quiet — it sits at the
 * bottom of the portfolio, a footnote on how much flow went through Helix.
 */

import { compactUsd, money } from "./fmt";
import type { HelixStripStats, HelixWindow } from "@/lib/portfolio/fetch";

const WINDOWS: { key: keyof HelixStripStats; label: string }[] = [
  { key: "d1", label: "1D" },
  { key: "w1", label: "1W" },
  { key: "all", label: "All" },
];

export function HelixStrip({ helix }: { helix: HelixStripStats | null }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2/30 px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
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

        <Row label="Volume" render={(v) => compactUsd(v.volume)} helix={helix} />
        <Row
          label="Fills"
          render={(v) => v.fills.toLocaleString()}
          helix={helix}
        />
        <Row
          label="Builder fees"
          render={(v) => (v.builderFees > 0 ? money(v.builderFees, 4) : "$0")}
          helix={helix}
        />
      </div>
    </div>
  );
}

function Row({
  label,
  render,
  helix,
}: {
  label: string;
  render: (w: HelixWindow) => string;
  helix: HelixStripStats | null;
}) {
  return (
    <>
      <span className="text-fg-muted">{label}</span>
      {WINDOWS.map((w) => (
        <span
          key={w.key}
          className="text-right font-[var(--font-jetbrains-mono)] tabular-nums text-fg"
        >
          {helix ? render(helix[w.key]) : "—"}
        </span>
      ))}
    </>
  );
}
