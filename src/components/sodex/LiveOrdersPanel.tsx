"use client";

/**
 * The connected account's REAL SoDEX orders — mainnet only, scoped to the
 * trading identity in this browser (readLocalKey.address, the same wallet
 * record-trade keys on). Renders on the portfolio page above the paper
 * simulation so a live user sees what THEY actually executed, per account.
 *
 * Different identity (different browser / key) → different address → its own
 * orders. Renders nothing when no key is present (the page falls back to the
 * paper book).
 */

import { useCallback, useEffect, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { DataTable } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Timestamp } from "@/components/ui/Timestamp";
import { Addr } from "@/components/ui/Addr";
import { AssetCell } from "@/components/ui/AssetLogo";
import { fmtSodexSymbol } from "@/lib/format";
import { readLocalKey } from "@/lib/sodex-onchain/local-keys";

interface TradeView {
  id: string;
  network: "mainnet" | "testnet";
  symbol: string;
  side: "buy" | "sell";
  size_usd: number | null;
  filled_price: number | null;
  filled_at: number;
  status: "submitted" | "filled" | "rejected";
}

export function LiveOrdersPanel() {
  const [wallet, setWallet] = useState<`0x${string}` | null>(null);
  const [trades, setTrades] = useState<TradeView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Resolve the connected identity once on mount (localStorage — client only).
  useEffect(() => {
    setWallet(readLocalKey("mainnet")?.address ?? null);
  }, []);

  const refresh = useCallback(async () => {
    if (!wallet) return;
    try {
      const res = await fetch(`/api/sodex/my-trades?wallet=${wallet}&limit=50`);
      const json = (await res.json()) as {
        ok: boolean;
        trades?: TradeView[];
        error?: string;
      };
      if (!json.ok) {
        setErr(json.error ?? "load failed");
        return;
      }
      // Mainnet only — this is the live book, not testnet noise.
      setTrades((json.trades ?? []).filter((t) => t.network === "mainnet"));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [wallet]);

  useEffect(() => {
    if (!wallet) return;
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [wallet, refresh]);

  // No connected identity → the portfolio shows the paper book only.
  if (!wallet) return null;

  return (
    <Card className="border-positive/25">
      <CardHeader>
        <CardTitle>Your live orders · mainnet</CardTitle>
        <span className="flex items-center gap-2 text-[11px] text-fg-dim">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-positive" />
            account
          </span>
          <Addr value={wallet} tail={4} />
        </span>
      </CardHeader>
      <CardBody className="!p-0">
        {err ? (
          <div className="px-4 py-3 text-xs text-negative">{err}</div>
        ) : trades == null ? (
          <div className="px-4 py-3 text-xs text-fg-muted">Loading…</div>
        ) : trades.length === 0 ? (
          <div className="px-4 py-6 text-sm text-fg-dim">
            No live mainnet orders yet — execute a signal, or deploy AlphaIndex
            to SoDEX.
          </div>
        ) : (
          <DataTable<TradeView>
            columns={[
              {
                key: "asset",
                header: "Market",
                role: "identifier",
                render: (t) => (
                  <AssetCell
                    logoSymbol={t.symbol}
                    primary={fmtSodexSymbol(t.symbol)}
                  />
                ),
              },
              {
                key: "side",
                header: "Side",
                role: "context",
                align: "left",
                render: (t) => (
                  <span
                    className="font-mono text-[11px] uppercase"
                    style={{ color: t.side === "buy" ? "#5cc97a" : "#e06c66" }}
                  >
                    {t.side}
                  </span>
                ),
              },
              { key: "size", header: "Size", role: "context", num: (t) => t.size_usd, unit: "$", dp: 0 },
              { key: "px", header: "Fill px", role: "context", num: (t) => t.filled_price, unit: "$" },
              {
                key: "status",
                header: "Status",
                role: "context",
                render: (t) => (
                  <Badge
                    tone={
                      t.status === "filled"
                        ? "positive"
                        : t.status === "rejected"
                          ? "negative"
                          : "neutral"
                    }
                  >
                    {t.status}
                  </Badge>
                ),
              },
              { key: "when", header: "Placed", role: "context", render: (t) => <Timestamp ms={t.filled_at} mode="relative" /> },
            ]}
            rows={trades}
            getKey={(t) => t.id}
            minWidth={560}
          />
        )}
      </CardBody>
    </Card>
  );
}
