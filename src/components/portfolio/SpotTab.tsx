"use client";

/**
 * SpotTab — the portfolio's Spot view. Four stat cards (Total Spot Equity, 30d
 * Spot Volume, 30d Realized Spot PnL, Current Spot PnL), then Balances / Swap
 * History / Transfers sub-tabs. Balances is a sortable table with a "Hide dust
 * (<$1)" toggle; Swap History maps to spot trade fills (SoDEX has no distinct
 * swap concept); Transfers is an honest empty state (the trading REST API
 * exposes no transfer-history read).
 *
 * The Price column is the current market price; there is no uPnL column —
 * SoDEX spot is plain holdings with no cost basis.
 */

import { useEffect, useState } from "react";
import { cn } from "@/components/ui/cn";
import { AssetLogo } from "@/components/ui/AssetLogo";
import { getAccountTrades } from "@/lib/sodex-onchain/client";
import type { SodexTrade } from "@/lib/sodex-onchain/types";
import {
  fetchSpotHoldings,
  type SpotHolding,
} from "@/lib/portfolio/fetch";
import { StatCard } from "./StatCard";
import { SegmentedTabs } from "./SegmentedTabs";
import { money, compactUsd, fmtPrice } from "./fmt";

const SODEX_WALLET = "https://sodex.com/wallet";
const SUB_TABS = ["Balances", "Swap History", "Transfers"] as const;
type SubTab = (typeof SUB_TABS)[number];

const qtyFmt = (v: number) =>
  v.toLocaleString(undefined, { maximumFractionDigits: 6 });
const two = (n: number) => String(n).padStart(2, "0");
const fmtDateTime = (t: number) =>
  new Date(t < 1e12 ? t * 1000 : t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

export function SpotTab({
  address,
  spotEquity,
  volume30dSpot,
}: {
  address: string | null;
  spotEquity: number | null;
  volume30dSpot: number | null;
}) {
  const [sub, setSub] = useState<SubTab>("Balances");

  return (
    <div className="flex flex-col gap-4">
      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total Spot Equity" value={money(spotEquity)} />
        <StatCard
          label="30d Spot Volume"
          value={volume30dSpot != null ? compactUsd(volume30dSpot) : "—"}
        />
        <StatCard
          label="30d Realized Spot PnL"
          value="—"
          tone="muted"
          sub="No spot cost basis on SoDEX"
        />
        <StatCard
          label="Current Spot PnL"
          value="—"
          tone="muted"
          sub="No spot cost basis on SoDEX"
        />
      </div>

      {/* Sub-tabs */}
      <div className="border-b border-line">
        <SegmentedTabs
          tabs={SUB_TABS}
          value={sub}
          onChange={setSub}
          variant="underline"
        />
      </div>

      {sub === "Balances" ? (
        <BalancesTable address={address} />
      ) : sub === "Swap History" ? (
        <SwapHistory address={address} />
      ) : (
        <TransfersEmpty />
      )}
    </div>
  );
}

// Asset | Total | Settled / Unsettled | Price | Value
const SPOT_COLS =
  "minmax(120px,1.4fr) minmax(0,1fr) minmax(0,1.2fr) minmax(0,0.9fr) minmax(0,1fr)";

function BalancesTable({ address }: { address: string | null }) {
  const [holdings, setHoldings] = useState<SpotHolding[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hideDust, setHideDust] = useState(true);
  const [sortDesc, setSortDesc] = useState(true);

  useEffect(() => {
    if (!address) {
      setHoldings([]);
      return;
    }
    let cancelled = false;
    setHoldings(null);
    fetchSpotHoldings(address)
      .then((r) => {
        if (!cancelled) {
          setHoldings(r.holdings);
          setErr(null);
        }
      })
      .catch((e) => !cancelled && setErr((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [address]);

  if (holdings == null) {
    return <div className="px-1 py-8 text-center text-[12px] text-fg-dim">Loading balances…</div>;
  }
  if (err) {
    return (
      <div className="px-1 py-8 text-center text-[12px] text-negative">
        Couldn’t load balances — {err}
      </div>
    );
  }

  const shown = holdings
    .filter((h) => !hideDust || h.value == null || h.value >= 1)
    .sort((a, b) =>
      sortDesc ? (b.value ?? 0) - (a.value ?? 0) : (a.value ?? 0) - (b.value ?? 0),
    );
  const dustCount = holdings.length - holdings.filter((h) => h.value == null || h.value >= 1).length;

  return (
    <div className="text-[12px]">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] text-fg-dim">
          {shown.length} holding{shown.length === 1 ? "" : "s"}
        </span>
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-fg-muted">
          <input
            type="checkbox"
            checked={hideDust}
            onChange={(e) => setHideDust(e.target.checked)}
            className="h-3 w-3 accent-[color:var(--accent-trade)]"
          />
          Hide dust (&lt;$1){dustCount > 0 ? ` · ${dustCount}` : ""}
        </label>
      </div>

      {shown.length === 0 ? (
        <Empty>No spot balances.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[560px]">
            <div
              className="grid gap-2 border-b border-line px-2 py-1.5 text-[9px] uppercase tracking-wider text-fg-dim"
              style={{ gridTemplateColumns: SPOT_COLS }}
            >
              <span>Asset</span>
              <span className="text-right">Total</span>
              <span className="text-right">Settled / Unsettled</span>
              <span className="text-right" title="Current market price — SoDEX spot has no cost basis">
                Price
              </span>
              <button
                onClick={() => setSortDesc((s) => !s)}
                className="flex items-center justify-end gap-1 text-right uppercase tracking-wider transition-colors hover:text-fg-muted"
                title="Sort by value"
              >
                Value <span aria-hidden>{sortDesc ? "▼" : "▲"}</span>
              </button>
            </div>
            {shown.map((h) => (
              <div
                key={h.coin}
                className="grid items-center gap-2 px-2 py-2 font-[var(--font-jetbrains-mono)] tabular-nums transition-colors hover:bg-surface-2/40"
                style={{ gridTemplateColumns: SPOT_COLS }}
              >
                <span
                  className="flex min-w-0 items-center gap-2"
                  title={h.coin !== h.display ? `Wrapped as ${h.coin} on SoDEX` : undefined}
                >
                  <AssetLogo symbol={h.coin} size={18} />
                  <span className="truncate font-medium text-fg">{h.display}</span>
                </span>
                <span className="text-right text-fg">{qtyFmt(h.total)}</span>
                <span className="text-right text-fg-muted">
                  {qtyFmt(h.settled)}{" "}
                  <span className="text-fg-dim">/ {qtyFmt(h.unsettled)}</span>
                </span>
                <span className="text-right text-fg-dim">
                  {h.price != null ? `$${fmtPrice(h.price)}` : "—"}
                </span>
                <span className="text-right text-fg">
                  {h.value != null ? money(h.value) : "—"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Time | Side | Price | Size | Value | Fee
const SWAP_COLS =
  "minmax(104px,1fr) 48px minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,0.9fr)";

function SwapHistory({ address }: { address: string | null }) {
  const [rows, setRows] = useState<SodexTrade[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!address) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setRows(null);
    getAccountTrades("mainnet", address as `0x${string}`, { limit: 100 }, "spot")
      .then((r) => {
        if (!cancelled) {
          setRows(r);
          setErr(null);
        }
      })
      .catch((e) => !cancelled && setErr((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [address]);

  if (rows == null) {
    return <div className="px-1 py-8 text-center text-[12px] text-fg-dim">Loading swaps…</div>;
  }
  if (err) {
    return (
      <div className="px-1 py-8 text-center text-[12px] text-negative">
        Couldn’t load swap history — {err}
      </div>
    );
  }
  if (rows.length === 0) {
    return <Empty>No spot swaps yet.</Empty>;
  }

  return (
    <div className="overflow-x-auto text-[12px]">
      <div className="min-w-[620px]">
        <div
          className="grid gap-2 border-b border-line px-2 py-1 text-[9px] uppercase tracking-wider text-fg-dim"
          style={{ gridTemplateColumns: SWAP_COLS }}
        >
          <span>Time</span>
          <span>Side</span>
          <span className="text-right">Price</span>
          <span className="text-right">Size</span>
          <span className="text-right">Value</span>
          <span className="text-right">Fee</span>
        </div>
        {rows.map((t) => {
          const buy = (t.side ?? "").toUpperCase() === "BUY";
          const price = Number(t.price);
          const qty = Number(t.quantity);
          return (
            <div
              key={t.tradeID}
              className="grid items-center gap-2 px-2 py-1.5 font-[var(--font-jetbrains-mono)] tabular-nums hover:bg-surface-2/40"
              style={{ gridTemplateColumns: SWAP_COLS }}
            >
              <span className="text-fg-dim">{fmtDateTime(t.time)}</span>
              <span className={buy ? "text-positive" : "text-negative"}>
                {buy ? "Buy" : "Sell"}
              </span>
              <span className="text-right">${fmtPrice(price)}</span>
              <span className="text-right text-fg-muted">{qtyFmt(qty)}</span>
              <span className="text-right text-fg">{money(price * qty)}</span>
              <span className="text-right text-fg-muted">
                {money(Number(t.fee))}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TransfersEmpty() {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-[12px] text-fg-dim">
      <span className="max-w-md">
        SoDEX&apos;s trading API exposes no transfer-history read, so deposits
        and withdrawals aren&apos;t listed here. View them on SoDEX.
      </span>
      <a
        href={SODEX_WALLET}
        target="_blank"
        rel="noopener noreferrer"
        className="rounded-md border border-line px-3 py-1.5 text-[12px] font-medium text-fg-muted transition-colors hover:border-line-2 hover:text-fg"
      >
        Open SoDEX wallet →
      </a>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 py-8 text-center text-[12px] text-fg-dim">{children}</div>
  );
}
