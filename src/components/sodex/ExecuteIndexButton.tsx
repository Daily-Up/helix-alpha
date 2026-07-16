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
  readSafetyLimits,
  writeLocalKey,
  SODEX_MIN_NOTIONAL_USD,
} from "@/lib/sodex-onchain/local-keys";
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

  const [ready, setReady] = useState(false);
  const [identityAddress, setIdentityAddress] = useState<
    `0x${string}` | null
  >(null);
  const [budget, setBudget] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const key = readLocalKey(network);
    if (key && !key.masterAddress && connectedMaster) {
      writeLocalKey(network, { ...key, masterAddress: connectedMaster });
    }
    const limits = readSafetyLimits(network);
    setReady(!!key && limits.acceptedDisclaimer);
    setIdentityAddress(key?.address ?? null);
  }, [network, connectedMaster]);

  useEffect(() => {
    refresh();
  }, [refresh]);

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

      // Deploy AVAILABLE usdc (re-read so we never over-spend a stale figure).
      const avail = usdcAvailable(state.B ?? []);
      const deployable = Math.min(budget, avail);

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
  }, [network, budget, weighted, connectedMaster]);

  if (!ready) {
    const hasKey = identityAddress != null;
    return (
      <a
        href="/settings/connect-sodex"
        className="inline-flex items-center gap-2 rounded border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs text-accent-2 transition-colors hover:border-accent/60 hover:bg-accent/20"
        title={
          hasKey
            ? "You have a key but haven't accepted the safety-limits disclaimer — click to finish."
            : "Connect your wallet on SoDEX and create a Helix-scoped API key (one signature). Then deploy the index in one click."
        }
      >
        {hasKey
          ? "Accept disclaimer to deploy live →"
          : "→ Connect SoDEX to deploy the index live"}
      </a>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {confirming && budget != null ? (
        <div className="rounded border border-accent/40 bg-accent/10 p-2.5 text-xs">
          <div className="font-medium text-fg">Deploy AlphaIndex live?</div>
          <div className="mt-1 text-fg-muted">
            Splits <span className="font-medium text-fg">${budget.toFixed(0)}</span>{" "}
            available USDC across the live index weights —{" "}
            <span className="text-fg">real funds</span> on{" "}
            {SODEX_NETWORKS[network].label}. One signed batch, no wallet popup.
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
              {busy ? "Signing…" : `Confirm · $${budget.toFixed(0)}`}
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
