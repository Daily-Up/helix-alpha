"use client";

/**
 * TradeTerminal (Phase 1) — pick a SoDEX-tradable asset, run a Setup.
 *
 * The Setup is the centerpiece: POST /api/setup pulls the asset's SoSoValue
 * news + price and returns Claude's grounded call. Phase 2 will wrap a live
 * chart, order book and a Buy/Long–Sell/Short order panel (with the builder
 * code) around this same column.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { cn } from "@/components/ui/cn";
import { SetupCard, type SetupResponse } from "./SetupCard";

export interface TerminalAsset {
  id: string;
  symbol: string;
  name: string;
  kind: string;
  sodex_symbol: string | null;
  market: "spot" | "perp" | null;
}

const GROUPS: Array<{ label: string; kinds: string[] }> = [
  { label: "Crypto", kinds: ["token", "rwa"] },
  { label: "Equities", kinds: ["stock"] },
  { label: "Indices", kinds: ["index"] },
  { label: "Other", kinds: ["treasury", "macro"] },
];

export function TradeTerminal({ assets }: { assets: TerminalAsset[] }) {
  const [assetId, setAssetId] = useState<string>(
    () => assets.find((a) => a.id === "tok-btc")?.id ?? assets[0]?.id ?? "",
  );
  const [result, setResult] = useState<SetupResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = assets.find((a) => a.id === assetId) ?? null;

  const grouped = useMemo(
    () =>
      GROUPS.map((g) => ({
        label: g.label,
        items: assets.filter((a) => g.kinds.includes(a.kind)),
      })).filter((g) => g.items.length > 0),
    [assets],
  );

  async function runSetup() {
    if (!assetId) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assetId }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? `Setup failed (${res.status})`);
      }
      setResult(json as SetupResponse);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Asset picker + run */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface p-4">
        <label className="flex flex-col gap-1">
          <span className="font-[var(--font-jetbrains-mono)] text-[10px] uppercase tracking-wider text-fg-dim">
            Asset
          </span>
          <select
            value={assetId}
            onChange={(e) => {
              setAssetId(e.target.value);
              setResult(null);
              setError(null);
            }}
            className="min-w-[220px] rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-accent/50"
          >
            {grouped.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.items.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.symbol} · {a.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        {selected ? (
          <div className="flex flex-col gap-1 text-[11px] text-fg-dim">
            <span className="font-[var(--font-jetbrains-mono)] uppercase tracking-wider">
              SoDEX
            </span>
            <span className="text-fg-muted">
              {selected.sodex_symbol ?? "—"}
              {selected.market ? (
                <span className="ml-1.5 uppercase text-fg-dim">{selected.market}</span>
              ) : null}
            </span>
          </div>
        ) : null}

        <button
          onClick={runSetup}
          disabled={loading || !assetId}
          className={cn(
            "dash-btn-primary ml-auto inline-flex items-center gap-1.5 rounded-md border px-4 py-2 text-[13px] font-medium transition-colors",
            loading
              ? "cursor-wait border-line bg-surface-2 text-fg-dim"
              : "border-accent/50 bg-accent/20 text-accent-2 hover:bg-accent/30",
          )}
        >
          {loading ? "Reading the tape…" : "⚡ Run Setup"}
        </button>
      </div>

      {error ? (
        <div className="rounded-lg border border-negative/30 bg-negative/10 px-4 py-3 text-sm text-negative">
          {error}
        </div>
      ) : null}

      {!result && !loading && !error ? (
        <div className="rounded-xl border border-dashed border-line px-5 py-10 text-center text-sm text-fg-muted">
          Pick an asset and run a Setup — Helix will read the latest SoSoValue
          news and price action and call the bias, levels, and reasoning.
        </div>
      ) : null}

      {loading ? (
        <div className="rounded-xl border border-line bg-surface px-5 py-10 text-center text-sm text-fg-dim">
          Pulling {selected?.symbol} news + price, thinking through the setup…
        </div>
      ) : null}

      {result ? (
        <>
          <SetupCard data={result} />
          {/* Phase 1 trade hand-off — Phase 2 replaces this with an inline
              Buy/Long–Sell/Short order panel that routes with the builder code. */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-accent/30 bg-gradient-to-br from-accent/10 via-surface to-surface px-5 py-4">
            <div className="text-[12.5px] text-fg-muted">
              Like this setup?{" "}
              <span className="text-fg">
                Trade {result.asset.symbol} live on SoDEX
              </span>{" "}
              — one signature, your keys never leave the browser.
            </div>
            <Link
              href="/settings/connect-sodex"
              className="dash-btn-primary inline-flex shrink-0 items-center gap-1.5 rounded-md border border-accent/50 bg-accent/20 px-4 py-2 text-[13px] font-medium text-accent-2 transition-colors hover:bg-accent/30"
            >
              Connect SoDEX →
            </Link>
          </div>
        </>
      ) : null}
    </div>
  );
}
