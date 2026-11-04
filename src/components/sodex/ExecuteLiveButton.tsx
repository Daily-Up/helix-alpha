"use client";

/**
 * ExecuteLiveButton — a signal's "trade it" action. It no longer executes a
 * stored-size order inline; instead it opens the trade terminal pre-filled with
 * the signal's market + side (the user picks size and confirms there — the same
 * place every other trade is sized). When the browser isn't set up to trade, it
 * opens the global SodexAuth setup modal and, once ready, continues to the
 * terminal. No order signing happens here.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@/components/ui/cn";
import { fmtSodexSymbol } from "@/lib/format";
import { useSodexAuth } from "@/components/sodex/auth/SodexAuthProvider";

export interface ExecuteLiveSignal {
  signal_id: string;
  /** SoDEX textual symbol like "BTC-USDC". */
  symbol: string;
  /** Optional SoDEX numeric symbolID — resolved at runtime if absent. */
  symbol_id?: number;
  side: "buy" | "sell";
  /** Suggested size in USD (unused now — size is set in the terminal). */
  suggested_size_usd: number;
  stop_pct?: number | null;
  target_pct?: number | null;
  price_usd: number;
}

function tradeUrl(symbol: string, side: "buy" | "sell"): string {
  const q = new URLSearchParams({
    market: symbol.toUpperCase(),
    side: side === "buy" ? "long" : "short",
  });
  return `/trade?${q.toString()}`;
}

export function ExecuteLiveButton({ signal }: { signal: ExecuteLiveSignal }) {
  const auth = useSodexAuth();
  const router = useRouter();
  const side = signal.side === "buy" ? "long" : "short";
  const symLabel = fmtSodexSymbol(signal.symbol);
  const href = tradeUrl(signal.symbol, signal.side);

  const base =
    "inline-flex items-center gap-2 rounded border px-2.5 py-1 text-xs font-medium transition-colors";

  if (!auth.ready) {
    return (
      <button
        onClick={() => auth.openSetup(() => router.push(href))}
        className={cn(
          base,
          "border-[color:var(--accent-trade)]/40 bg-[color:var(--accent-trade)]/15 text-[color:var(--accent-trade)] hover:bg-[color:var(--accent-trade)]/25",
        )}
        title="Set up SoDEX to trade, then continue to the terminal"
      >
        {auth.step === "wallet" ? "Connect to trade" : "Finish setup"}
      </button>
    );
  }

  return (
    <Link
      href={href}
      className={cn(
        base,
        side === "long"
          ? "border-positive/40 bg-positive/15 text-positive hover:bg-positive/25"
          : "border-negative/40 bg-negative/15 text-negative hover:bg-negative/25",
      )}
      title={`Open ${symLabel} in the terminal, ${side} preset — set your size there`}
    >
      ▶ Trade {side.toUpperCase()} {symLabel} →
    </Link>
  );
}
