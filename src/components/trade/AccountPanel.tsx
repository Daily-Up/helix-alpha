"use client";

/**
 * AccountPanel — read-only perps account summary from /state, shown below the
 * order ticket to fill the full-height ticket column. Equity / Available /
 * Margin used / Unrealized PnL / Margin ratio, all derived from the shared
 * account state. Shows a Connect CTA until the browser trading key is live.
 */

import Link from "next/link";
import { cn } from "@/components/ui/cn";
import type { SodexPerpsAccountState } from "@/lib/sodex-onchain/types";

const money = (v: number | null | undefined, d = 2) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : `$${v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const signedMoney = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : `${v >= 0 ? "+" : "−"}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function AccountPanel({
  account,
  ready,
}: {
  account: SodexPerpsAccountState | null;
  ready: boolean;
}) {
  // av = account value (collateral + uPnL) = equity; am = free collateral.
  const equity = account ? Number(account.av) : null;
  const available = account ? Number(account.am) : null;
  const used =
    equity != null && available != null && Number.isFinite(equity) && Number.isFinite(available)
      ? Math.max(0, equity - available)
      : null;
  const upnl = account?.P
    ? account.P.reduce((s, p) => s + (p.ur != null ? Number(p.ur) || 0 : 0), 0)
    : null;
  const marginRatio =
    equity != null && equity > 0 && used != null ? (used / equity) * 100 : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto border-t border-line p-4">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wider text-fg-dim">
          Account
        </span>
        <span className="text-[9px] uppercase tracking-wider text-fg-dim">
          Perps · USDC
        </span>
      </div>

      {!ready ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-4">
          <p className="text-center text-[11px] text-fg-dim">
            Connect to see your balances.
          </p>
          <Link
            href="/settings/connect-sodex"
            className="rounded-md border border-accent/50 bg-accent/15 px-4 py-2 text-[12px] font-semibold text-accent-2 transition-colors hover:bg-accent/25"
          >
            Connect SoDEX
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 text-[11.5px]">
          <ARow label="Equity" value={money(equity)} />
          <ARow label="Available" value={money(available)} />
          <ARow label="Margin used" value={money(used)} />
          <ARow
            label="Unrealized PnL"
            value={signedMoney(upnl)}
            tone={upnl == null || upnl === 0 ? "default" : upnl > 0 ? "positive" : "negative"}
          />
          <ARow
            label="Margin ratio"
            value={marginRatio != null ? `${marginRatio.toFixed(2)}%` : "—"}
          />
        </div>
      )}
    </div>
  );
}

function ARow({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "positive" | "negative";
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-fg-dim">{label}</span>
      <span
        className={cn(
          "font-[var(--font-jetbrains-mono)] tabular-nums",
          tone === "positive" && "text-positive",
          tone === "negative" && "text-negative",
          tone === "default" && "text-fg",
        )}
      >
        {value}
      </span>
    </div>
  );
}
