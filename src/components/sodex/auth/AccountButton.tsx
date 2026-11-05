"use client";

/**
 * AccountButton — the single top-right entry point, rendered on every page via
 * the shared Topbar. Renders in ALL states: loading → skeleton pill, not ready
 * → "Connect" / "Finish setup" (opens the setup modal), ready → address pill +
 * account menu. The menu is portaled to <body> on a top z-index layer with a
 * solid background, so no page's stacking context (e.g. the ticket's sliding
 * Buy/Sell pill transform) can ever draw over it.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { cn } from "@/components/ui/cn";
import { formatExpiry } from "@/lib/sodex-onchain/local-keys";
import { getBuilderCode } from "@/lib/sodex-onchain/chains";
import { useSodexAuth } from "./SodexAuthProvider";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const DAY = 24 * 60 * 60 * 1000;
const MENU_BG = "#171c23";

export function AccountButton() {
  const a = useSodexAuth();

  // Scope to .trade-terminal so --accent-trade (and the rest of the terminal
  // palette the menu/modal use) resolves here too. The global Topbar sits
  // OUTSIDE .trade-terminal, where --accent-trade is undefined — without this
  // the button's background collapses to transparent and it renders invisible
  // on the dark header (the "empty header" bug). .trade-terminal only sets CSS
  // vars + font, so it's safe as a wrapper.
  return (
    <div className="trade-terminal flex items-center">
      {a.loading ? (
        <div
          className="h-7 w-24 animate-pulse rounded-full bg-surface-2"
          aria-hidden
        />
      ) : !a.ready ? (
        <button
          onClick={() => a.openSetup()}
          className="rounded-md border border-[color:var(--accent-trade)]/50 bg-[color:var(--accent-trade)]/20 px-3.5 py-1.5 text-[12px] font-semibold text-[color:var(--accent-trade)] transition-colors hover:bg-[color:var(--accent-trade)]/30"
        >
          {a.step === "wallet" ? "Connect" : "Finish setup"}
        </button>
      ) : (
        <ReadyPill />
      )}
    </div>
  );
}

function ReadyPill() {
  const a = useSodexAuth();
  const btnRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={btnRef}
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
      {a.menuOpen ? <Menu anchor={btnRef} /> : null}
    </>
  );
}

function Menu({ anchor }: { anchor: React.RefObject<HTMLButtonElement | null> }) {
  const a = useSodexAuth();
  const [copied, setCopied] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const fee = getBuilderCode("mainnet")?.fee ?? 10;
  const expLabel = a.keyExpiry ? formatExpiry(a.keyExpiry) : "";
  const needsRenew = a.keyExpiry?.msLeft != null && a.keyExpiry.msLeft < DAY;

  // Position the portaled menu under the anchor (fixed coords → escapes any
  // transformed ancestor's stacking context).
  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
  }, [anchor]);

  // Close on outside click / Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        !anchor.current?.contains(e.target as Node)
      ) {
        a.setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && a.setMenuOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [a, anchor]);

  if (typeof document === "undefined" || !pos) return null;

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

  return createPortal(
    <div
      ref={menuRef}
      className="trade-terminal fixed z-[1000] w-[272px] rounded-lg border border-line p-3 text-[12px] shadow-2xl"
      style={{ top: pos.top, right: pos.right, background: MENU_BG }}
    >
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
      <div className="flex items-center justify-between">
        <span className="text-fg-muted">Trading key</span>
        <span className="font-[var(--font-jetbrains-mono)] text-fg-muted">
          {a.key?.name || "—"}
        </span>
      </div>
      <div className="mt-0.5 flex items-center justify-between">
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
    </div>,
    document.body,
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
