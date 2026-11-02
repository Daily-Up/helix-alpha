"use client";

/**
 * Live-execution button for a signal.
 *
 * Renders ONLY when the user has:
 *   1. A Helix-scoped SoDEX API key for mainnet (localStorage).
 *   2. Accepted the safety-limits disclaimer.
 *
 * Click flow (TWO explicit steps — this places a REAL mainnet order):
 *   click "Execute live" → inline confirm shows the exact side / USD /
 *   symbol / "real funds" → click "Confirm" → browser builds order params
 *   → signs with the local private key → POSTs to the SoDEX gateway
 *   directly → records the public outcome to /api/sodex/record-trade.
 *
 * Sizing: the live order size IS the user's per-trade max (`maxPositionUsd`)
 * — the single size knob on the Connect page. The button, the confirm
 * panel, and the result toast ALL show this same number, so what's shown
 * is what's charged. Helix's server is never on the critical path.
 */

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import {
  SODEX_NETWORKS,
  type SodexNetwork,
} from "@/lib/sodex-onchain/chains";
import {
  readLocalKey,
  readSafetyLimits,
  writeLocalKey,
  readTradesToday,
} from "@/lib/sodex-onchain/local-keys";
import { placeLiveOrder } from "@/lib/sodex-onchain/placeLiveOrder";
import { fmtSodexSymbol } from "@/lib/format";
import { cn } from "@/components/ui/cn";

export interface ExecuteLiveSignal {
  signal_id: string;
  /** SoDEX textual symbol like "BTC-USDC". */
  symbol: string;
  /** Optional SoDEX numeric symbolID — resolved at runtime if absent. */
  symbol_id?: number;
  side: "buy" | "sell";
  /** Suggested size in USD — pre-fills the editable size field. */
  suggested_size_usd: number;
  /** Suggested stop-loss / take-profit %, pre-fill the SL/TP fields. */
  stop_pct?: number | null;
  target_pct?: number | null;
  /** Current market price used for the optimistic display. */
  price_usd: number;
}

interface Props {
  signal: ExecuteLiveSignal;
}

export function ExecuteLiveButton({ signal }: Props) {
  // Mainnet only — testnet was scoped out.
  const network: SodexNetwork = "mainnet";

  const { address: connectedMaster } = useAccount();

  // ── Readiness + live params ──
  const [ready, setReady] = useState(false);
  const [identityAddress, setIdentityAddress] = useState<
    `0x${string}` | null
  >(null);
  const [maxDaily, setMaxDaily] = useState(3);
  const [tradesToday, setTradesToday] = useState(0);
  // Editable order params — pre-filled from the signal, then user-adjustable
  // in the confirm panel. Strings so the inputs can be cleared/typed freely.
  const [sizeInput, setSizeInput] = useState("");
  const [stopInput, setStopInput] = useState(
    signal.stop_pct != null ? String(signal.stop_pct) : "",
  );
  const [targetInput, setTargetInput] = useState(
    signal.target_pct != null ? String(signal.target_pct) : "",
  );

  const refreshState = useCallback(() => {
    const key = readLocalKey(network);
    if (key && !key.masterAddress && connectedMaster) {
      writeLocalKey(network, { ...key, masterAddress: connectedMaster });
    }
    const limits = readSafetyLimits(network);
    setReady(!!key && limits.acceptedDisclaimer);
    setIdentityAddress(key?.address ?? null);
    // Seed size from the signal's suggestion, falling back to the per-trade
    // safety size. Only when empty so we don't clobber the user's edit.
    setSizeInput((prev) =>
      prev !== ""
        ? prev
        : String(signal.suggested_size_usd || limits.maxPositionUsd || 11),
    );
    setMaxDaily(limits.maxDailyTrades);
    setTradesToday(readTradesToday(network));
  }, [network, connectedMaster, signal.suggested_size_usd]);

  useEffect(() => {
    refreshState();
  }, [refreshState]);

  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Step 1 — validate limits, then reveal the confirm panel. No signing
  // or network call happens here.
  const requestExecute = useCallback(() => {
    const limits = readSafetyLimits(network);
    const used = readTradesToday(network);
    if (used >= limits.maxDailyTrades) {
      setMsg(
        `✗ Daily live-trade limit reached (${used}/${limits.maxDailyTrades}). Resets 00:00 UTC — or raise it on /settings/connect-sodex.`,
      );
      return;
    }
    setMsg(null);
    setConfirming(true);
  }, [network]);

  // Step 2 — the real thing. Delegates to the extracted placeLiveOrder
  // (commit 3a). Args are read here when Confirm is clicked (same deps as
  // before), so size / stop / target are the current values, not render-time.
  const execute = useCallback(async () => {
    await placeLiveOrder({
      network,
      signal,
      identityAddress,
      connectedMaster,
      sizeInput,
      stopInput,
      targetInput,
      setMsg,
      setBusy,
      setConfirming,
      setTradesToday,
    });
  }, [
    network,
    signal,
    identityAddress,
    connectedMaster,
    sizeInput,
    stopInput,
    targetInput,
  ]);

  if (!ready) {
    const hasKey = identityAddress != null;
    return (
      <a
        href="/settings/connect-sodex"
        className="inline-flex items-center gap-2 rounded border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs text-accent-2 transition-colors hover:border-accent/60 hover:bg-accent/20"
        title={
          hasKey
            ? "You have a key but haven't accepted the safety-limits disclaimer yet — click to finish setup."
            : "Connect your wallet on SoDEX mainnet and generate a Helix-scoped API key. Your master wallet signs once; the trading key lives only in this browser."
        }
      >
        {hasKey
          ? "Accept disclaimer to execute live →"
          : "→ Create SoDEX API key to execute live"}
      </a>
    );
  }

  const sideLabel = signal.side.toUpperCase();
  const symLabel = fmtSodexSymbol(signal.symbol);

  return (
    <div className="flex flex-col gap-1.5">
      {confirming ? (
        // ── Explicit confirmation — a REAL order is one click away ──
        <div className="rounded border border-accent/40 bg-accent/10 p-2.5 text-xs">
          <div className="text-fg-muted">
            Real{" "}
            <span
              className={cn(
                "font-medium",
                signal.side === "buy" ? "text-positive" : "text-negative",
              )}
            >
              {sideLabel}
            </span>{" "}
            on {symLabel} — <span className="text-fg">real funds</span> on{" "}
            {SODEX_NETWORKS[network].label}. Stop / target become reduce-only
            brackets on perps.
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {(
              [
                ["Size $", sizeInput, setSizeInput, "text-fg", undefined],
                ["Stop %", stopInput, setStopInput, "text-negative", "off"],
                ["Target %", targetInput, setTargetInput, "text-positive", "off"],
              ] as const
            ).map(([label, val, setter, color, ph]) => (
              <label key={label} className="flex flex-col gap-0.5">
                <span className="font-[var(--font-jetbrains-mono)] text-[9px] uppercase tracking-wider text-fg-dim">
                  {label}
                </span>
                <input
                  value={val}
                  onChange={(e) => setter(e.target.value)}
                  inputMode="decimal"
                  placeholder={ph}
                  disabled={busy}
                  className={cn(
                    "w-full rounded border border-line bg-surface px-1.5 py-1 text-xs tabular-nums outline-none focus:border-accent/50",
                    color,
                  )}
                />
              </label>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={execute}
              disabled={busy}
              className={cn(
                "rounded border px-2.5 py-1 text-xs font-medium transition-colors",
                busy
                  ? "cursor-wait border-line bg-surface-2 text-fg-dim"
                  : "border-accent bg-accent text-[#0b0b0e] hover:bg-accent-2",
              )}
            >
              {busy ? "Signing…" : `Confirm · $${sizeInput}`}
            </button>
            <button
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="rounded border border-line px-2.5 py-1 text-xs text-fg-muted transition-colors hover:border-line-2 hover:text-fg"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={requestExecute}
          disabled={busy}
          className={cn(
            "inline-flex items-center gap-2 rounded border px-2.5 py-1 text-xs font-medium transition-colors",
            "border-accent/40 bg-accent/15 text-accent-2 hover:bg-accent/25",
          )}
          title={`${SODEX_NETWORKS[network].label} · ${sideLabel} ${symLabel} — set size, stop & target on confirm`}
        >
          {`▶ Execute live · $${sizeInput}`}
        </button>
      )}
      {msg ? (
        <span
          className="text-[11px]"
          style={{ color: msg.startsWith("✗") ? "#e06c66" : "#5cc97a" }}
        >
          {msg}
        </span>
      ) : null}
      {!confirming && tradesToday > 0 ? (
        <span className="text-[10px] text-fg-dim">
          {tradesToday}/{maxDaily} live trades today
        </span>
      ) : null}
    </div>
  );
}
