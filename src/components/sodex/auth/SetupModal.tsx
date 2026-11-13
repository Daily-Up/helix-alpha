"use client";

/**
 * SetupModal — the single resumable sign-in stepper. Reads everything from
 * SodexAuthProvider and auto-starts at the first incomplete step; completed
 * steps show a check. Every action reuses the existing signing functions.
 * Wallet rejections surface as a friendly retry, never a broken state.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/components/ui/cn";
import { getBuilderCode } from "@/lib/sodex-onchain/chains";
import { useSodexAuth, type AuthStep } from "./SodexAuthProvider";

const STEPS: { key: AuthStep; label: string }[] = [
  { key: "wallet", label: "Wallet" },
  { key: "network", label: "Network" },
  { key: "key", label: "Trading key" },
  { key: "builder", label: "Builder fee" },
  { key: "done", label: "Done" },
];
const ORDER: AuthStep[] = ["wallet", "network", "key", "builder", "done"];

export function SetupModal() {
  const a = useSodexAuth();
  if (!a.modalOpen) return null;
  return <ModalInner />;
}

function ModalInner() {
  const a = useSodexAuth();
  const curIdx = ORDER.indexOf(a.step);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") a.closeModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [a]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="trade-terminal fixed inset-0 z-[1000] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(2px)" }}
      onClick={a.closeModal}
    >
      <div
        className="relative w-full max-w-[440px] rounded-xl border border-line p-5 shadow-2xl"
        style={{ background: "#171c23" }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={a.closeModal}
          className="absolute right-3 top-3 text-fg-dim hover:text-fg"
          aria-label="Close"
        >
          ✕
        </button>

        <h2 className="text-[16px] font-semibold text-fg">Connect to SoDEX</h2>
        <p className="mb-4 mt-0.5 text-[12px] text-fg-muted">
          One-time setup to trade live with your own wallet and funds.
        </p>

        {/* Stepper */}
        <div className="mb-5 flex items-center gap-1.5">
          {STEPS.map((s, i) => {
            const done = i < curIdx;
            const active = i === curIdx;
            return (
              <div key={s.key} className="flex flex-1 flex-col items-center gap-1">
                <div
                  className={cn(
                    "flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold",
                    done && "bg-positive/20 text-positive",
                    active && "bg-[color:var(--accent-trade)] text-[#0b0e11]",
                    !done && !active && "bg-surface-2 text-fg-dim",
                  )}
                >
                  {done ? "✓" : i + 1}
                </div>
                <span
                  className={cn(
                    "text-[8.5px] uppercase tracking-wider",
                    active ? "text-fg" : "text-fg-dim",
                  )}
                >
                  {s.label}
                </span>
              </div>
            );
          })}
        </div>

        {a.error ? (
          <div className="mb-3 rounded-md border border-negative/40 bg-negative/10 px-3 py-2 text-[11.5px] text-negative">
            {a.error}
          </div>
        ) : null}

        <div className="min-h-[150px]">
          {a.step === "wallet" ? (
            <WalletStep />
          ) : a.step === "network" ? (
            <NetworkStep />
          ) : a.step === "key" ? (
            <KeyStep />
          ) : a.step === "builder" ? (
            <BuilderStep />
          ) : (
            <DoneStep />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Primary({
  onClick,
  busy,
  children,
  disabled,
}: {
  onClick: () => void;
  busy?: boolean;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      className={cn(
        "w-full rounded-md py-2.5 text-[13px] font-semibold transition-all",
        busy || disabled
          ? "cursor-not-allowed bg-surface-2 text-fg-dim"
          : "bg-[color:var(--accent-trade)] text-[#0b0e11] hover:brightness-110",
      )}
    >
      {busy ? "Working…" : children}
    </button>
  );
}

function WalletStep() {
  const a = useSodexAuth();
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] text-fg-muted">
        Connect a browser wallet. Helix only asks it to sign setup — it never
        holds your funds or seed phrase.
      </p>
      {a.connectors.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {a.connectors.map((c) => (
            <button
              key={c.uid}
              onClick={() => a.connectWith(c)}
              disabled={a.busy === "wallet"}
              className="flex items-center gap-2.5 rounded-md border border-line bg-surface-2/40 px-3 py-2.5 text-left text-[13px] text-fg transition-colors hover:border-line-2 hover:bg-surface-2/70 disabled:opacity-60"
            >
              {c.icon ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.icon} alt="" className="h-5 w-5 rounded" />
              ) : (
                <span className="grid h-5 w-5 place-items-center rounded bg-surface text-[11px]">
                  ◆
                </span>
              )}
              <span className="font-medium">{c.name}</span>
              {a.busy === "wallet" ? (
                <span className="ml-auto text-[10px] text-fg-dim">…</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      <p className="mt-1 text-[11px] text-fg-dim">
        No wallet?{" "}
        <a
          href="https://metamask.io/download/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[color:var(--accent-trade)] hover:underline"
        >
          Install MetaMask
        </a>{" "}
        or{" "}
        <a
          href="https://rabby.io/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[color:var(--accent-trade)] hover:underline"
        >
          Rabby
        </a>
        .
      </p>
    </div>
  );
}

function NetworkStep() {
  const a = useSodexAuth();
  // On ValueChain but no SoDEX account → deposit sub-state.
  if (a.onChain && !a.hasAccount) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[12px] text-fg-muted">
          Your wallet is on ValueChain, but it doesn&apos;t have a SoDEX account
          yet. Deposit any amount on SoDEX (it auto-creates your account), then
          check again.
        </p>
        <a
          href="https://sodex.com/trade/futures/BTC-USD"
          target="_blank"
          rel="noopener noreferrer"
          className="w-full rounded-md border border-line bg-surface-2/50 py-2.5 text-center text-[13px] font-medium text-fg hover:bg-surface-2"
        >
          Deposit on SoDEX ↗
        </a>
        <Primary onClick={a.refresh} busy={a.loading}>
          Check again
        </Primary>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-fg-muted">
        Switch your wallet to <span className="text-fg">ValueChain</span> (SoDEX&apos;s
        network). Helix adds it automatically if your wallet doesn&apos;t have it
        yet. SoDEX trades are off-chain signatures — no gas.
      </p>
      <Primary onClick={a.switchChain} busy={a.busy === "network"}>
        Switch to ValueChain
      </Primary>
    </div>
  );
}

function KeyStep() {
  const a = useSodexAuth();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-fg-muted">
        Create a trading-only key, stored in this browser. It can place and
        cancel orders, <span className="text-fg">can&apos;t withdraw</span>, and
        expires in 7 days. Your master wallet signs once.
      </p>
      <Primary onClick={a.generateKey} busy={a.busy === "key"}>
        Create trading key
      </Primary>
      <p className="text-[10.5px] text-fg-dim">
        SoDEX allows up to 5 keys per account. If you hit the cap, revoke an old
        key under the account menu → Manage keys, then retry.
      </p>
    </div>
  );
}

function BuilderStep() {
  const a = useSodexAuth();
  const fee = getBuilderCode("mainnet")?.fee ?? 30;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-fg-muted">
        Approve Helix&apos;s{" "}
        <span className="text-fg">{(fee / 1000).toFixed(2)}% builder fee</span>.
        One signature, applies to every trade you place through Helix (on top of
        SoDEX&apos;s own fee).
      </p>
      <Primary onClick={a.approveBuilder} busy={a.busy === "builder"}>
        Approve builder fee
      </Primary>
    </div>
  );
}

function DoneStep() {
  const a = useSodexAuth();
  const [agreed, setAgreed] = useState(a.disclaimerAccepted);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-fg-muted">
        One last thing before you trade for real.
      </p>
      <label className="flex cursor-pointer items-start gap-2 rounded-md border border-line bg-surface-2/40 p-3 text-[12px] text-fg">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="mt-0.5 h-3.5 w-3.5 accent-[color:var(--accent-trade)]"
        />
        <span>
          I understand Helix places <span className="font-semibold">real trades</span>{" "}
          on my SoDEX account and I may lose money.
        </span>
      </label>
      <Primary onClick={a.acceptDisclaimer} disabled={!agreed}>
        You&apos;re ready to trade
      </Primary>
    </div>
  );
}
