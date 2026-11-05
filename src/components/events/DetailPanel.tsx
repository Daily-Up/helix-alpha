"use client";

/**
 * DetailPanel — a right slide-over for one event: full AI analysis, each
 * tradable asset's price chart with an event-time marker and the move since
 * publish, Long/Short buttons per asset, source link, and related (clustered)
 * events. Esc or the backdrop closes it.
 */

import { useEffect } from "react";
import { X } from "lucide-react";
import { fmtRelative } from "@/lib/format";
import { safeHref } from "@/lib/safe-url";
import { cn } from "@/components/ui/cn";
import { AssetLogo } from "@/components/ui/AssetLogo";
import { NotFinancialAdvice } from "@/components/ui/NotFinancialAdvice";
import { perpDisplay } from "@/lib/events/market-map";
import { priceMove, type StreamEvent } from "@/lib/events/use-stream";
import type { SodexCandle } from "@/lib/sodex/types";
import { AssetPill } from "./AssetPill";
import { Sparkline } from "./Sparkline";

const sentimentCls: Record<string, string> = {
  positive: "text-positive",
  negative: "text-negative",
  neutral: "text-fg-dim",
};

export function DetailPanel({
  ev,
  klines,
  onClose,
  onOpen,
}: {
  ev: StreamEvent | null;
  klines: Map<string, SodexCandle[]>;
  onClose: () => void;
  onOpen: (ev: StreamEvent) => void;
}) {
  useEffect(() => {
    if (!ev) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ev, onClose]);

  if (!ev) return null;

  return (
    <div className="trade-terminal fixed inset-0 z-[80]">
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-[1px]"
        onClick={onClose}
      />
      <div className="absolute right-0 top-0 flex h-full w-[460px] max-w-[94vw] flex-col overflow-y-auto border-l border-line bg-surface shadow-2xl shadow-black/50">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-line bg-surface px-4 py-3">
          <div className="flex flex-wrap items-center gap-1.5 text-[9px] font-medium uppercase tracking-wider">
            {ev.event_type ? (
              <span className="rounded bg-[color:var(--accent-trade)]/12 px-1.5 py-px text-[color:var(--accent-trade)]">
                {ev.event_type}
              </span>
            ) : null}
            {ev.sentiment ? (
              <span className={sentimentCls[ev.sentiment]}>{ev.sentiment}</span>
            ) : null}
            {ev.severity ? (
              <span className="rounded border border-line px-1.5 py-px font-semibold text-fg">
                {ev.severity}
              </span>
            ) : null}
            {ev.confidence != null ? (
              <span className="font-[var(--font-jetbrains-mono)] text-fg-muted">
                {Math.round(ev.confidence * 100)}% conf
              </span>
            ) : null}
            <span className="font-[var(--font-jetbrains-mono)] normal-case text-fg-dim">
              · {fmtRelative(ev.release_time)}
            </span>
          </div>
          <button
            onClick={onClose}
            className="grid h-6 w-6 shrink-0 place-items-center rounded text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex flex-col gap-4 p-4">
          <h2 className="text-[18px] font-semibold leading-snug text-fg">
            {ev.title}
          </h2>

          {ev.reasoning ? (
            <p className="text-[13px] leading-relaxed text-fg-muted">
              {ev.reasoning}
            </p>
          ) : (
            <p className="text-[13px] italic text-fg-dim">
              Not yet classified — analysis pending.
            </p>
          )}

          {ev.source_link ? (
            <a
              href={safeHref(ev.source_link)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[12px] text-[color:var(--accent-trade)] hover:underline"
            >
              Open source{ev.author ? ` · ${ev.author}` : ""} →
            </a>
          ) : null}

          {/* Affected assets with charts + trade buttons */}
          {ev.tradable.length > 0 ? (
            <div className="flex flex-col gap-3 border-t border-line pt-3">
              <span className="text-[11px] font-medium uppercase tracking-wider text-fg-dim">
                Affected markets
              </span>
              {ev.tradable.map((a) => {
                const candles = a.sodexSymbol
                  ? klines.get(a.sodexSymbol)
                  : undefined;
                const move = candles
                  ? priceMove(candles, ev.release_time)
                  : null;
                const pct = move?.pct ?? null;
                const asset = { ...a, move };
                return (
                  <div
                    key={a.id}
                    className="rounded-lg border border-line bg-surface-2/30 p-3"
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <AssetLogo symbol={a.ticker} size={22} />
                      <div className="flex flex-col leading-tight">
                        <span className="text-[13px] font-medium text-fg">
                          {a.ticker}
                        </span>
                        <span className="text-[9px] uppercase tracking-wider text-fg-dim">
                          {a.sodexSymbol ? perpDisplay(a.sodexSymbol) : ""}
                        </span>
                      </div>
                      {pct != null ? (
                        <span
                          className={cn(
                            "ml-auto font-[var(--font-jetbrains-mono)] text-[12px] tabular-nums",
                            pct >= 0 ? "text-positive" : "text-negative",
                          )}
                          title="Move since the event was published"
                        >
                          {pct >= 0 ? "+" : "−"}
                          {Math.abs(pct).toFixed(2)}% since
                        </span>
                      ) : null}
                    </div>
                    {candles && candles.length > 1 ? (
                      <div className="h-[110px] w-full">
                        <Sparkline
                          candles={candles}
                          eventMs={ev.release_time}
                          className="h-full w-full"
                        />
                      </div>
                    ) : (
                      <div className="grid h-[70px] place-items-center text-[10px] text-fg-dim">
                        No recent price data
                      </div>
                    )}
                    <div className="mt-2 flex">
                      <AssetPill
                        asset={asset}
                        sentiment={ev.sentiment}
                        publishMs={ev.release_time}
                        both
                        star
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

          {/* Related events */}
          {ev.related.length > 0 ? (
            <div className="flex flex-col gap-2 border-t border-line pt-3">
              <span className="text-[11px] font-medium uppercase tracking-wider text-fg-dim">
                Related ({ev.related.length})
              </span>
              {ev.related.map((r) => (
                <button
                  key={r.id}
                  onClick={() =>
                    onOpen({
                      ...ev,
                      ...r,
                      related: [],
                    } as StreamEvent)
                  }
                  className="text-left text-[12px] leading-snug text-fg-muted hover:text-fg"
                >
                  {r.title}{" "}
                  <span className="text-fg-dim">· {fmtRelative(r.release_time)}</span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="border-t border-line pt-3">
            <NotFinancialAdvice />
          </div>
        </div>
      </div>
    </div>
  );
}
