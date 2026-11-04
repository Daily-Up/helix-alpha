"use client";

/**
 * One-click LIVE execution of the AlphaIndex basket on SoDEX.
 *
 * The index computes its target weights autonomously (paper). This button
 * deploys those weights with REAL funds in a single signed batch: it reads
 * the user's available spot USDC, splits it across the index's tradable
 * weights, and submits every leg as one MARKET-buy batch.
 *
 * No per-order wallet popup: the batch is signed by the Helix-scoped SoDEX
 * API key created once on /settings/connect-sodex (the master wallet signs
 * `addAPIKey` a single time; the trading key then lives only in this browser
 * and signs every subsequent order). So "authorize once, then one click" —
 * exactly the signal execution model, generalised to a basket.
 *
 * Safe by construction: it can only ever spend AVAILABLE spot USDC (market
 * buys sized in `funds`), it is a two-step confirm, and Helix's server is
 * never on the critical path — orders go browser → SoDEX gateway directly.
 */

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { SODEX_NETWORKS, type SodexNetwork } from "@/lib/sodex-onchain/chains";
import {
  placeOrderBatch,
  getAccountState,
  getSymbolId,
} from "@/lib/sodex-onchain/client";
import {
  readLocalKey,
  writeLocalKey,
  SODEX_MIN_NOTIONAL_USD,
} from "@/lib/sodex-onchain/local-keys";
import { useSodexAuth } from "@/components/sodex/auth/SodexAuthProvider";
import { fmtSodexSymbol } from "@/lib/format";
import {
  SodexOrderType,
  SodexSide,
  SodexTimeInForce,
  type SodexNewOrderEntry,
} from "@/lib/sodex-onchain/types";
import { cn } from "@/components/ui/cn";

/** One tradable constituent of the live index. */
export interface IndexLeg {
  /** SoDEX textual symbol, e.g. "BTC-USDC". */
  sodex_symbol: string;
  /** Display ticker, e.g. "BTC". */
  symbol: string;
  /** Target portfolio weight in [0,1]. */
  target_weight: number;
}

function usdcAvailable(
  balances: Array<{ a: string; t: string; l: string }>,
): number {
  const row =
    balances.find((b) => b.a === "USDC") ??
    balances.find((b) => b.a === "vUSDC");
  if (!row) return 0;
  const total = Number(row.t);
  const locked = Number(row.l);
  if (!Number.isFinite(total)) return 0;
  return Math.max(0, total - (Number.isFinite(locked) ? locked : 0));
}

export function ExecuteIndexButton({ legs }: { legs: IndexLeg[] }) {
  const network: SodexNetwork = "mainnet"; // mainnet only

  const { address: connectedMaster } = useAccount();
  const auth = useSodexAuth();

  const [budget, setBudget] = useState<number | null>(null);
  const [deployInput, setDeployInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Self-heal the stored key's master address (the SodexAuth provider owns
  // readiness; here we only keep the key usable for the batch signing).
  useEffect(() => {
    const key = readLocalKey(network);
    if (key && !key.masterAddress && connectedMaster) {
      writeLocalKey(network, { ...key, masterAddress: connectedMaster });
    }
  }, [network, connectedMaster]);

  // Assets that carry a meaningful weight — used for the confirm summary.
  const weighted = legs
    .filter((l) => l.target_weight > 0 && l.sodex_symbol)
    .sort((a, b) => b.target_weight - a.target_weight);

  // Step 1 — read live USDC, show the confirm panel. No signing yet.
  const requestExecute = useCallback(async () => {
    setMsg(null);
    setBusy(true);
    try {
      const key = readLocalKey(network);
      if (!key) throw new Error("Set up a SoDEX key on /settings/connect-sodex first.");
      const lookup = key.masterAddress ?? connectedMaster ?? key.address;
      const state = await getAccountState(network, lookup);
      if (!state.aid) {
        throw new Error(
          "SoDEX account not found for this wallet — connect the master wallet you used on /settings/connect-sodex, then try again.",
        );
      }
      const avail = usdcAvailable(state.B ?? []);
      if (avail < SODEX_MIN_NOTIONAL_USD) {
        throw new Error(
          `Only $${avail.toFixed(2)} spot USDC available — below SoDEX's ~$${SODEX_MIN_NOTIONAL_USD} minimum. Deposit USDC on SoDEX first.`,
        );
      }
      setBudget(avail);
      setDeployInput(String(Math.floor(avail)));
      setConfirming(true);
    } catch (err) {
      setMsg(`✗ ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [network, connectedMaster]);

  // Step 2 — build the basket + submit as ONE signed batch.
  const execute = useCallback(async () => {
    const key = readLocalKey(network);
    if (!key || budget == null) {
      setConfirming(false);
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const lookup = key.masterAddress ?? connectedMaster ?? key.address;
      const state = await getAccountState(network, lookup);
      if (!state.aid) throw new Error("SoDEX account not found for this wallet.");

      // Deploy the user-chosen amount, never more than what's actually
      // available (re-read so we never over-spend a stale figure).
      const avail = usdcAvailable(state.B ?? []);
      const want = Number(deployInput) || 0;
      const deployable = Math.min(want > 0 ? want : budget, avail);

      // Resolve symbolIDs in parallel, then keep only legs whose slice clears
      // the exchange minimum — accept the small tracking error on tiny weights.
      const resolved = await Promise.all(
        weighted.map(async (l) => {
          const targetUsd = l.target_weight * deployable;
          if (targetUsd < SODEX_MIN_NOTIONAL_USD) return null;
          const symbolID = await getSymbolId(network, l.sodex_symbol).catch(
            () => null,
          );
          if (symbolID == null) return null;
          return { leg: l, symbolID, targetUsd };
        }),
      );
      const fills = resolved.filter(
        (r): r is NonNullable<typeof r> => r != null,
      );
      if (fills.length === 0) {
        throw new Error(
          "No index leg cleared the ~$10 SoDEX minimum at your current balance. Deposit more USDC.",
        );
      }

      const tsB36 = Date.now().toString(36);
      const orders: SodexNewOrderEntry[] = fills.map((f, i) => ({
        symbolID: f.symbolID,
        clOrdID: `helix-idx${i}-${tsB36}${Math.random()
          .toString(36)
          .slice(2, 6)}`.slice(0, 36),
        side: SodexSide.BUY,
        type: SodexOrderType.MARKET,
        timeInForce: SodexTimeInForce.IOC,
        funds: f.targetUsd.toFixed(2),
      }));

      await placeOrderBatch({
        network,
        apiKeyName: key.name || undefined,
        privateKey: key.privateKey,
        batch: { accountID: state.aid, orders },
      });

      const deployed = fills.reduce((s, f) => s + f.targetUsd, 0);
      // Best-effort audit trail (never blocks the toast).
      fetch("/api/sodex/record-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_wallet: key.address,
          signal_id: "alphaindex-deploy",
          network,
          symbol: "ALPHAINDEX",
          side: "buy",
          size_usd: deployed,
          status: "submitted",
          note: `basket ${fills.length} legs`,
        }),
      }).catch(() => {});

      setMsg(
        `✓ Deployed $${deployed.toFixed(0)} across ${fills.length} AlphaIndex legs on ${SODEX_NETWORKS[network].label}`,
      );
    } catch (err) {
      setMsg(`✗ ${(err as Error).message}`);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }, [network, budget, deployInput, weighted, connectedMaster]);

  if (!auth.ready) {
    return (
      <button
        onClick={() => auth.openSetup()}
        className="inline-flex items-center gap-2 rounded border border-[color:var(--accent-trade)]/40 bg-[color:var(--accent-trade)]/15 px-2.5 py-1 text-xs font-medium text-[color:var(--accent-trade)] transition-colors hover:bg-[color:var(--accent-trade)]/25"
        title="Set up SoDEX to deploy the index live"
      >
        {auth.step === "wallet" ? "Connect to deploy" : "Finish setup"}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {confirming && budget != null ? (
        <div className="rounded border border-[color:var(--accent-trade)]/40 bg-[color:var(--accent-trade)]/10 p-2.5 text-xs">
          <div className="font-medium text-fg">Deploy AlphaIndex live?</div>
          <div className="mt-1 text-fg-muted">
            Splits the amount you choose across the live index weights —{" "}
            <span className="text-fg">real funds</span> on{" "}
            {SODEX_NETWORKS[network].label}. One signed batch, no wallet popup.
          </div>
          <label className="mt-2 flex items-center gap-2">
            <span className="font-[var(--font-jetbrains-mono)] text-[9px] uppercase tracking-wider text-fg-dim">
              Deploy $
            </span>
            <input
              value={deployInput}
              onChange={(e) =>
                setDeployInput(e.target.value.replace(/[^0-9.]/g, ""))
              }
              inputMode="decimal"
              disabled={busy}
              className="w-24 rounded border border-line bg-surface px-1.5 py-1 text-xs tabular-nums text-fg outline-none focus:border-[color:var(--accent-trade)]/50"
            />
            <button
              type="button"
              onClick={() => setDeployInput(String(Math.floor(budget)))}
              className="text-[10px] text-fg-dim hover:text-fg"
            >
              max ${budget.toFixed(0)}
            </button>
          </label>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={execute}
              disabled={busy || !(Number(deployInput) > 0)}
              className={cn(
                "rounded border px-2.5 py-1 text-xs font-medium transition-colors",
                busy || !(Number(deployInput) > 0)
                  ? "cursor-not-allowed border-line bg-surface-2 text-fg-dim"
                  : "border-[color:var(--accent-trade)] bg-[color:var(--accent-trade)] text-[#0b0e11] hover:brightness-110",
              )}
            >
              {busy ? "Signing…" : `Confirm · $${(Number(deployInput) || 0).toFixed(0)}`}
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
            busy
              ? "cursor-wait border-line bg-surface-2 text-fg-dim"
              : "border-accent/40 bg-accent/15 text-accent-2 hover:bg-accent/25",
          )}
          title={`Deploy the AlphaIndex weights to SoDEX (${SODEX_NETWORKS[network].label}) in one signed batch`}
        >
          {busy ? "Reading balance…" : "▶ Deploy to SoDEX"}
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
    </div>
  );
}
