"use client";

/**
 * AccountButton — the single top-right entry point. Not ready → "Connect" or
 * "Finish setup" opens the setup modal. Ready → an address pill that opens the
 * account menu (key expiry + renew, builder-fee status, links, disconnect).
 * Replaces the old TradeModeBadge; reads only from SodexAuthProvider.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { cn } from "@/components/ui/cn";
import { formatExpiry } from "@/lib/sodex-onchain/local-keys";
import { getBuilderCode } from "@/lib/sodex-onchain/chains";
import { useSodexAuth } from "./SodexAuthProvider";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const DAY = 24 * 60 * 60 * 1000;

export function AccountButton() {
  const a = useSodexAuth();

  if (a.loading) {
    return <div style={{ width: 96, height: 28 }} aria-hidden />;
  }

  if (!a.ready) {
    const label = a.step === "wallet" ? "Connect" : "Finish setup";
    return (
      <button
        onClick={() => a.openSetup()}
        className="rounded-full bg-[color:var(--accent-trade)] px-3.5 py-1.5 text-[12px] font-semibold text-[#0b0e11] transition-all hover:brightness-110"
      >
        {label}
      </button>
    );
  }

  return <ReadyPill />;
}

function ReadyPill() {
  const a = useSodexAuth();
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close the menu on outside click.
  useEffect(() => {
    if (!a.menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        a.setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [a]);

  return (
    <div ref={wrapRef} className="trade-terminal relative">
      <button
        onClick={() => a.setMenuOpen(!a.menuOpen)}
        className="flex items-center gap-2 rounded-full border border-line bg-surface-2/50 py-1 pl-1.5 pr-3 transition-colors hover:border-line-2"
      >
        <span className="grid h-6 w-6 place-items-center rounded-full bg-[color:var(--accent-trade)]/20 text-[10px] text-[color:var(--accent-trade)]">
          ◆
        </span>
        <span className="font-[var(--font-jetbrains-mono)] text-[11px] text-fg">
          {a.address ? short(a.address) : "wallet"}
        </span>
        <span className="h-1.5 w-1.5 rounded-full bg-positive" aria-hidden />
      </button>
      {a.menuOpen ? <Menu /> : null}
    </div>
  );
}

function Menu() {
  const a = useSodexAuth();
  const [copied, setCopied] = useState(false);
  const fee = getBuilderCode("mainnet")?.fee ?? 10;
  const expLabel = a.keyExpiry ? formatExpiry(a.keyExpiry) : "";
  const needsRenew =
    a.keyExpiry?.msLeft != null && a.keyExpiry.msLeft < DAY;

  const copy = async () => {
    if (!a.address) return;
    try {
      await navigator.clipboard.writeText(a.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-[272px] rounded-lg border border-line bg-surface p-3 text-[12px] shadow-2xl">
      {/* address */}
      <div className="flex items-center justify-between">
        <span className="font-[var(--font-jetbrains-mono)] text-[12px] text-fg">
          {a.address ? short(a.address) : "—"}
        </span>
        <button onClick={copy} className="text-[10px] text-fg-dim hover:text-fg">
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <div className="mt-1 flex items-center justify-between text-[10.5px] text-fg-dim">
        <span>SoDEX Mainnet · ValueChain</span>
        <span>acct #{a.accountID ?? "—"}</span>
      </div>

      <div className="my-2.5 border-t border-line" />

      {/* trading key */}
      <Row label="Trading key">
        <span className="text-fg-muted">{a.key?.name || "—"}</span>
      </Row>
      <div className="flex items-center justify-between">
        <span
          className={cn(
            "text-[10.5px]",
            needsRenew ? "text-[#e0a53f]" : "text-fg-dim",
          )}
        >
          {expLabel || "no expiry"}
        </span>
        {needsRenew ? (
          <button
            onClick={a.generateKey}
            disabled={a.busy === "key"}
            className="rounded border border-[#e0a53f]/50 bg-[#e0a53f]/10 px-2 py-0.5 text-[10px] font-medium text-[#e0a53f] hover:bg-[#e0a53f]/20"
          >
            {a.busy === "key" ? "Renewing…" : "Renew"}
          </button>
        ) : null}
      </div>

      <div className="my-2.5 border-t border-line" />

      {/* builder fee */}
      <div className="flex items-center justify-between">
        <span className="text-fg-muted">Builder fee</span>
        {a.builderApproved ? (
          <span className="text-positive">
            ✓ Approved ({(fee / 1000).toFixed(2)}%)
          </span>
        ) : (
          <button
            onClick={a.approveBuilder}
            disabled={a.busy === "builder"}
            className="rounded border border-[color:var(--accent-trade)]/50 bg-[color:var(--accent-trade)]/10 px-2 py-0.5 text-[10px] font-medium text-[color:var(--accent-trade)]"
          >
            {a.busy === "builder" ? "Approving…" : "Approve"}
          </button>
        )}
      </div>
      {a.builderApproved ? (
        <button
          onClick={a.approveBuilder}
          disabled={a.busy === "builder"}
          className="mt-1 text-[10px] text-fg-dim hover:text-fg-muted"
        >
          Re-approve builder fee
        </button>
      ) : null}

      <div className="my-2.5 border-t border-line" />

      {/* links */}
      <div className="flex flex-col gap-1">
        <MenuLink href="/portfolio" onNav={() => a.setMenuOpen(false)}>
          Portfolio
        </MenuLink>
        <MenuLink href="/settings/sodex" onNav={() => a.setMenuOpen(false)}>
          Manage keys
        </MenuLink>
      </div>

      <div className="my-2.5 border-t border-line" />

      <div className="flex flex-col gap-1">
        <button
          onClick={() => a.disconnect(false)}
          className="rounded px-1 py-1 text-left text-[12px] text-fg-muted hover:bg-surface-2/60 hover:text-fg"
        >
          Disconnect
        </button>
        <button
          onClick={() => a.disconnect(true)}
          className="rounded px-1 py-1 text-left text-[11px] text-negative/80 hover:bg-negative/10 hover:text-negative"
        >
          Disconnect &amp; revoke key on SoDEX
        </button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-fg-muted">{label}</span>
      {children}
    </div>
  );
}

function MenuLink({
  href,
  onNav,
  children,
}: {
  href: string;
  onNav: () => void;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={onNav}
      className="rounded px-1 py-1 text-fg-muted hover:bg-surface-2/60 hover:text-fg"
    >
      {children}
    </Link>
  );
}
