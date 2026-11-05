"use client";

/**
 * AccountPanel — read-only perps account summary from /state, shown below the
 * order ticket to fill the full-height ticket column. Equity / Available /
 * Margin used / Unrealized PnL / Margin ratio, all derived from the shared
 * account state. Shows a Connect CTA until the browser trading key is live.
 */

import { memo } from "react";
import { cn } from "@/components/ui/cn";
import { buttonClass } from "@/components/ui/Button";
import type { SodexPerpsAccountState } from "@/lib/sodex-onchain/types";
import { useSodexAuth } from "@/components/sodex/auth/SodexAuthProvider";

const money = (v: number | null | undefined, d = 2) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : `$${v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const signedMoney = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : `${v >= 0 ? "+" : "−"}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function AccountPanelImpl({
  account,
  ready,
}: {
  account: SodexPerpsAccountState | null;
  ready: boolean;
}) {
  const auth = useSodexAuth();
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
  // Health colour: comfortable → caution → danger.
  const ratioColor =
    marginRatio == null
      ? "#5f6b7a"
      : marginRatio < 50
        ? "#0ecb81"
        : marginRatio < 80
          ? "#e0a53f"
          : "#f6465d";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto border-t border-line p-3">
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
          <button
            onClick={() => auth.openSetup()}
            className={buttonClass("primary", "px-4 py-2 text-[12px] font-semibold")}
          >
            {auth.step === "wallet" ? "Connect SoDEX" : "Finish setup"}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {/* Equity — the headline figure. */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-fg-dim">
              Equity
            </div>
            <div className="font-[var(--font-jetbrains-mono)] text-[22px] font-semibold leading-tight tabular-nums text-fg">
              {money(equity)}
            </div>
          </div>
          {/* The rest, two columns. */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
            <ARow label="Available" value={money(available)} />
            <ARow label="Margin used" value={money(used)} />
            <ARow
              label="Unrealized PnL"
              value={signedMoney(upnl)}
              tone={upnl == null || upnl === 0 ? "default" : upnl > 0 ? "positive" : "negative"}
              className="col-span-2"
            />
          </div>
          {/* Margin ratio — progress bar, green → amber → red. */}
          <div>
            <div className="mb-1 flex items-center justify-between text-[10px]">
              <span className="uppercase tracking-wider text-fg-dim">
                Margin ratio
              </span>
              <span
                className="font-[var(--font-jetbrains-mono)] tabular-nums"
                style={{ color: ratioColor }}
              >
                {marginRatio != null ? `${marginRatio.toFixed(2)}%` : "—"}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface">
              <div
                className="h-full rounded-full transition-all duration-300 ease-out"
                style={{
                  width: `${Math.min(100, Math.max(marginRatio ?? 0, marginRatio ? 2 : 0))}%`,
                  backgroundColor: ratioColor,
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Memoized: re-renders only when `account` (5s poll) or `ready` changes, not on
// the terminal's 1s clock tick.
export const AccountPanel = memo(AccountPanelImpl);

function ARow({
  label,
  value,
  tone = "default",
  className,
}: {
  label: string;
  value: string;
  tone?: "default" | "positive" | "negative";
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-2", className)}>
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
