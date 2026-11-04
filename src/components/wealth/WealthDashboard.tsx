"use client";

/**
 * WealthDashboard — Helix's lens over SoDEX Wealth (replaces AlphaIndex).
 *
 * Three stacked sections:
 *   1. My Wealth — the connected wallet's SoDEX Wealth portfolio (read-only).
 *   2. Suggestions — the "special suggestions" rail: factual, input-grounded
 *      cards (events/news-led, efficiency baseline, risk guardrail).
 *   3. Catalog — the live SoDEX Wealth funds, grouped Stable Earn / Curated
 *      ETF / Specialty. Invest/Subscribe/Redeem link out to SoDEX (v1).
 *
 * All data is read-only from our /api/wealth/* proxy of the public SoDEX
 * Wealth API. No signing, no orders. Numbers come straight from that API.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardBody } from "@/components/ui/Card";
import { PanelSkeleton } from "@/components/ui/Skeleton";
import { cn } from "@/components/ui/cn";
import { fmtUsd, fmtRelative } from "@/lib/format";
import { useSodexAuth } from "@/components/sodex/auth/SodexAuthProvider";
import {
  CATEGORY_LABEL,
  type WealthCategory,
  type WealthFundView,
  type WealthPortfolio,
  type WealthSuggestion,
} from "@/lib/wealth/types";
import { SuggestionCard } from "./SuggestionCard";
import { FundCard } from "./FundCard";

interface CatalogResp {
  ok: boolean;
  funds: WealthFundView[];
  groups: Array<{ category: WealthCategory; funds: WealthFundView[] }>;
}
interface PortfolioResp {
  ok: boolean;
  portfolio: WealthPortfolio;
}
interface SuggestionsResp {
  ok: boolean;
  connected: boolean;
  suggestions: WealthSuggestion[];
}

export function WealthDashboard() {
  const auth = useSodexAuth();
  const router = useRouter();
  const address = auth.address;
  const openFund = (f: WealthFundView) => router.push(`/wealth/${f.fundId}`);

  const [catalog, setCatalog] = useState<CatalogResp | null>(null);
  const [portfolio, setPortfolio] = useState<WealthPortfolio | null>(null);
  const [suggestions, setSuggestions] = useState<WealthSuggestion[] | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [loadingSug, setLoadingSug] = useState(true);

  // Catalog (not wallet-specific) — once on mount.
  useEffect(() => {
    let cancelled = false;
    setLoadingCatalog(true);
    fetch("/api/wealth/catalog")
      .then((r) => r.json())
      .then((j: CatalogResp) => !cancelled && setCatalog(j.ok ? j : null))
      .catch(() => !cancelled && setCatalog(null))
      .finally(() => !cancelled && setLoadingCatalog(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Portfolio — when a wallet is connected.
  useEffect(() => {
    if (!address) {
      setPortfolio(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/wealth/portfolio?address=${address}`)
      .then((r) => r.json())
      .then((j: PortfolioResp) => !cancelled && setPortfolio(j.ok ? j.portfolio : null))
      .catch(() => !cancelled && setPortfolio(null));
    return () => {
      cancelled = true;
    };
  }, [address]);

  // Suggestions — depend on the connected address (idle USDC + concentration).
  const loadSuggestions = useCallback(() => {
    let cancelled = false;
    setLoadingSug(true);
    const q = address ? `?address=${address}` : "";
    fetch(`/api/wealth/suggestions${q}`)
      .then((r) => r.json())
      .then((j: SuggestionsResp) => !cancelled && setSuggestions(j.ok ? j.suggestions : []))
      .catch(() => !cancelled && setSuggestions([]))
      .finally(() => !cancelled && setLoadingSug(false));
    return () => {
      cancelled = true;
    };
  }, [address]);
  useEffect(() => loadSuggestions(), [loadSuggestions]);

  const fundById = useMemo(() => {
    const m = new Map<string, WealthFundView>();
    (catalog?.funds ?? []).forEach((f) => m.set(f.fundId, f));
    return m;
  }, [catalog]);

  // fundIds that currently have a suggestion → badge on the catalog card.
  const flaggedFunds = useMemo(
    () => new Set((suggestions ?? []).map((s) => s.fundId).filter(Boolean) as string[]),
    [suggestions],
  );

  return (
    <div className="dash-page-enter flex flex-col gap-6">
      <MyWealth
        address={address}
        portfolio={portfolio}
        fundById={fundById}
        onConnect={() => auth.openSetup()}
      />

      {/* ── Suggestions ────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="font-[var(--font-fraunces)] text-[18px] font-light text-fg">
            Suggestions for you
          </h2>
          <span className="text-[11px] text-fg-dim">
            Observations from live SoDEX data + Helix events · not financial advice
          </span>
        </div>
        {loadingSug ? (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <PanelSkeleton height="h-36" />
            <PanelSkeleton height="h-36" />
          </div>
        ) : suggestions && suggestions.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {suggestions.map((s) => (
              <SuggestionCard
                key={s.id}
                suggestion={s}
                fund={s.fundId ? fundById.get(s.fundId) ?? null : null}
                onOpenFund={openFund}
              />
            ))}
          </div>
        ) : (
          <Card>
            <CardBody>
              <p className="text-[13px] text-fg-muted">
                No suggestions right now — nothing in the live data crosses the
                threshold for a factual observation.{" "}
                {!address && (
                  <button
                    onClick={() => auth.openSetup()}
                    className="text-accent-2 hover:underline"
                  >
                    Connect your wallet
                  </button>
                )}
                {!address && " to include idle-cash and concentration checks."}
              </p>
            </CardBody>
          </Card>
        )}
      </section>

      {/* ── Catalog ────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-5">
        <div className="flex items-baseline justify-between">
          <h2 className="font-[var(--font-fraunces)] text-[18px] font-light text-fg">
            Wealth catalog
          </h2>
          {catalog?.funds && (
            <span className="flex items-center gap-2 text-[11px] text-fg-dim">
              {flaggedFunds.size > 0 && (
                <span className="flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                  has a live suggestion
                  <span className="px-1">·</span>
                </span>
              )}
              {catalog.funds.length} live products · SoDEX Wealth
            </span>
          )}
        </div>
        {loadingCatalog ? (
          <PanelSkeleton height="h-64" />
        ) : catalog?.groups?.length ? (
          catalog.groups.map((g) => (
            <CatalogSection
              key={g.category}
              category={g.category}
              funds={g.funds}
              flagged={flaggedFunds}
              onSelect={openFund}
            />
          ))
        ) : (
          <Card>
            <CardBody>
              <p className="text-[13px] text-fg-muted">
                Couldn&apos;t load the SoDEX Wealth catalog right now. Try again
                shortly.
              </p>
            </CardBody>
          </Card>
        )}
      </section>

    </div>
  );
}

// ── My Wealth strip ─────────────────────────────────────────────────────

function MyWealth({
  address,
  portfolio,
  fundById,
  onConnect,
}: {
  address: string | null;
  portfolio: WealthPortfolio | null;
  fundById: Map<string, WealthFundView>;
  onConnect: () => void;
}) {
  if (!address) {
    return (
      <Card>
        <CardBody>
          <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
            <div>
              <div className="font-[var(--font-jetbrains-mono)] text-[10px] uppercase tracking-[0.2em] text-fg-dim">
                My Wealth
              </div>
              <p className="mt-1 text-[13px] text-fg-muted">
                Connect your wallet to see your SoDEX Wealth holdings, PnL and
                personalised suggestions.
              </p>
            </div>
            <button
              onClick={onConnect}
              className="shrink-0 rounded-md border border-accent/50 bg-accent/15 px-4 py-2 text-[13px] font-medium text-accent-2 transition-colors hover:bg-accent/25"
            >
              Connect wallet →
            </button>
          </div>
        </CardBody>
      </Card>
    );
  }

  const held = (portfolio?.positions ?? []).filter((p) => (p.marketValue ?? 0) > 0.0001);

  return (
    <Card>
      <CardBody>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <div className="font-[var(--font-jetbrains-mono)] text-[10px] uppercase tracking-[0.2em] text-fg-dim">
                My Wealth
              </div>
              <div className="mt-0.5 font-[var(--font-jetbrains-mono)] text-[26px] font-semibold tabular-nums text-fg">
                {portfolio ? fmtUsd(portfolio.totalWealth) : "…"}
              </div>
            </div>
            <PnlStat label="24h PnL" value={portfolio?.totalPnl24h ?? null} />
            <PnlStat
              label="All-time PnL"
              value={portfolio?.totalPnl ?? null}
              title="Realised (incl. redeemed positions) + unrealised on current holdings"
            />
            <PnlStat
              label="Realised"
              value={portfolio?.totalRealizedPnl ?? null}
              title="Locked in from closed / redeemed positions"
            />
            <PnlStat
              label="Unrealised"
              value={portfolio?.totalUnrealizedPnl ?? null}
              title="On current open positions (SoDEX cost basis is airdrop-adjusted)"
            />
          </div>
          <a
            href="https://sodex.com/wealth"
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 self-start rounded-md border border-line px-3 py-1.5 text-[12px] text-fg-muted transition-colors hover:border-line-2 hover:text-fg lg:self-auto"
          >
            Manage on SoDEX ↗
          </a>
        </div>

        {held.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-3">
            {held.map((p) => {
              const f = fundById.get(p.fundId);
              const up = (p.pnl24h ?? 0) >= 0;
              return (
                <div
                  key={p.fundId}
                  className="flex items-center gap-2 rounded-md border border-line bg-surface-2/40 px-2.5 py-1.5"
                >
                  <span className="text-[12px] font-medium text-fg">
                    {f?.displayName ?? p.fundId}
                  </span>
                  <span className="font-[var(--font-jetbrains-mono)] text-[12px] tabular-nums text-fg-muted">
                    {fmtUsd(p.marketValue)}
                  </span>
                  {p.pnl24h != null && (
                    <span
                      className={cn(
                        "font-[var(--font-jetbrains-mono)] text-[10.5px] tabular-nums",
                        up ? "text-positive" : "text-negative",
                      )}
                    >
                      {up ? "+" : "−"}
                      {fmtUsd(Math.abs(p.pnl24h)).replace("$", "$")}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function PnlStat({
  label,
  value,
  title,
}: {
  label: string;
  value: number | null;
  title?: string;
}) {
  const up = (value ?? 0) >= 0;
  return (
    <div title={title}>
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-fg-dim">
        {label}
        {title && <span className="cursor-help text-fg-dim/70">ⓘ</span>}
      </div>
      <div
        className={cn(
          "mt-0.5 font-[var(--font-jetbrains-mono)] text-[15px] font-medium tabular-nums",
          value == null ? "text-fg-dim" : up ? "text-positive" : "text-negative",
        )}
      >
        {value == null ? "—" : `${up ? "+" : "−"}${fmtUsd(Math.abs(value)).replace("$", "$")}`}
      </div>
    </div>
  );
}

// ── Catalog section ─────────────────────────────────────────────────────

const CATEGORY_BLURB: Record<WealthCategory, string> = {
  stable_earn: "Variable yield · redeemable",
  curated_etf: "Tokenised US ETFs · long-term beta",
  specialty: "Thematic growth vaults",
};

function CatalogSection({
  category,
  funds,
  flagged,
  onSelect,
}: {
  category: WealthCategory;
  funds: WealthFundView[];
  flagged: Set<string>;
  onSelect: (f: WealthFundView) => void;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2.5">
        <h3 className="text-[14px] font-medium text-fg">{CATEGORY_LABEL[category]}</h3>
        <span className="text-[11px] text-fg-dim">{CATEGORY_BLURB[category]}</span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {funds.map((f) => (
          <FundCard
            key={f.fundId}
            fund={f}
            flagged={flagged.has(f.fundId)}
            onSelect={() => onSelect(f)}
          />
        ))}
      </div>
    </div>
  );
}

export { fmtRelative };
