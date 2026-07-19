"use client";

/**
 * The connected account's OPEN perps positions on SoDEX, with a one-click
 * Close (a reduce-only MARKET order for the full size). Positions come from
 * the LIVE perps account state (getPerpsAccountState.P) — the real on-exchange
 * position, not Helix's order log. Scoped to the SoDEX account owner (the
 * master wallet), which is where positions live.
 */

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { DataTable } from "@/components/ui/DataTable";
import { Action } from "@/components/ui/Action";
import { Addr } from "@/components/ui/Addr";
import { AssetCell } from "@/components/ui/AssetLogo";
import { fmtSodexSymbol } from "@/lib/format";
import { readLocalKey } from "@/lib/sodex-onchain/local-keys";
import type { SodexNetwork } from "@/lib/sodex-onchain/chains";
import {
  getPerpsAccountState,
  getTicker,
  resolveSymbol,
  placeOrderBatch,
} from "@/lib/sodex-onchain/client";
import {
  SodexOrderType,
  SodexSide,
  SodexTimeInForce,
} from "@/lib/sodex-onchain/types";

interface PosRow {
  i: number;
  symbol: string;
  side: "long" | "short";
  sizeAbs: number;
  entry: number;
  mark: number;
  notional: number;
  uPnl: number;
}

export function LivePositionsPanel() {
  const network: SodexNetwork = "mainnet";
  const { address: connectedMaster } = useAccount();
  const [master, setMaster] = useState<`0x${string}` | null>(null);
  const [aid, setAid] = useState(0);
  const [rows, setRows] = useState<PosRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [closing, setClosing] = useState<number | null>(null);

  useEffect(() => {
    const key = readLocalKey(network);
    setMaster(key?.masterAddress ?? connectedMaster ?? key?.address ?? null);
  }, [connectedMaster]);

  const refresh = useCallback(async () => {
    if (!master) return;
    try {
      const state = await getPerpsAccountState(network, master);
      setAid(state.aid);
      const open = (state.P ?? []).filter((p) => Number(p.sz) !== 0);
      const out: PosRow[] = [];
      for (const p of open) {
        const sz = Number(p.sz);
        const ep = Number(p.ep);
        const t = await getTicker(network, p.s, "futures");
        const mark = Number(t?.markPrice ?? t?.lastPx ?? ep) || ep;
        const sizeAbs = Math.abs(sz);
        out.push({
          i: p.i,
          symbol: p.s,
          side: sz >= 0 ? "long" : "short",
          sizeAbs,
          entry: ep,
          mark,
          notional: sizeAbs * mark,
          uPnl: (mark - ep) * sz,
        });
      }
      setRows(out);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [master]);

  useEffect(() => {
    if (!master) return;
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [master, refresh]);

  const closePosition = useCallback(
    async (row: PosRow) => {
      const key = readLocalKey(network);
      if (!key || !master) return;
      setClosing(row.i);
      setErr(null);
      try {
        const resolved = await resolveSymbol(network, row.symbol);
        if (!resolved) throw new Error(`Symbol ${row.symbol} not resolvable.`);
        const qty = row.sizeAbs.toFixed(resolved.quantityPrecision ?? 4);
        const clid = `helix-cl${Date.now().toString(36)}${Math.random()
          .toString(36)
          .slice(2, 4)}`.slice(0, 36);
        // Close = a reduce-only MARKET order on the OPPOSITE side for |size|.
        await placeOrderBatch({
          network,
          apiKeyName: key.name || undefined,
          privateKey: key.privateKey,
          market: "futures",
          batch: {
            accountID: aid,
            orders: [
              {
                symbolID: resolved.id,
                clOrdID: clid,
                side: row.side === "long" ? SodexSide.SELL : SodexSide.BUY,
                type: SodexOrderType.MARKET,
                timeInForce: SodexTimeInForce.IOC,
                quantity: qty,
                reduceOnly: true,
                positionSide: 1,
              },
            ],
          },
        });
        await refresh();
      } catch (e) {
        setErr(`Close failed: ${(e as Error).message}`);
      } finally {
        setClosing(null);
      }
    },
    [master, aid, refresh],
  );

  if (!master) return null;

  return (
    <Card className="border-accent/20">
      <CardHeader>
        <CardTitle>Open positions · perps</CardTitle>
        <span className="text-[11px] text-fg-dim">
          <Addr value={master} tail={4} />
        </span>
      </CardHeader>
      <CardBody className="!p-0">
        {err ? (
          <div className="px-4 py-3 text-xs text-negative">{err}</div>
        ) : rows == null ? (
          <div className="px-4 py-3 text-xs text-fg-muted">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-6 text-sm text-fg-dim">
            No open positions.
          </div>
        ) : (
          <DataTable<PosRow>
            columns={[
              {
                key: "asset",
                header: "Market",
                role: "identifier",
                render: (r) => (
                  <AssetCell
                    logoSymbol={r.symbol}
                    primary={fmtSodexSymbol(r.symbol)}
                    secondary={
                      <span
                        className={
                          r.side === "long" ? "text-positive" : "text-negative"
                        }
                      >
                        {r.side.toUpperCase()}
                      </span>
                    }
                  />
                ),
              },
              { key: "size", header: "Size", role: "context", num: (r) => r.notional, unit: "$", compact: true },
              { key: "entry", header: "Entry", role: "context", num: (r) => r.entry, unit: "$" },
              { key: "mark", header: "Mark", role: "context", num: (r) => r.mark, unit: "$" },
              { key: "pnl", header: "uPnL", role: "magnitude", num: (r) => r.uPnl, unit: "$", sign: true, tone: "auto" },
              {
                key: "close",
                header: "",
                role: "action",
                render: (r) => (
                  <Action
                    enabled={closing !== r.i}
                    tone="danger"
                    onClick={() => closePosition(r)}
                  >
                    {closing === r.i ? "Closing…" : "Close"}
                  </Action>
                ),
              },
            ]}
            rows={rows}
            getKey={(r) => String(r.i)}
            minWidth={640}
          />
        )}
      </CardBody>
    </Card>
  );
}
