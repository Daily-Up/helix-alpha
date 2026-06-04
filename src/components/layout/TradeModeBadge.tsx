"use client";

/**
 * Trade-mode badge — shows the user whether they're in DEMO mode
 * (paper trades, no real money) or LIVE mode (SoDEX wallet
 * connected, Execute Live works against mainnet).
 *
 * State derived from the presence of a locally-stored SoDEX trading
 * identity (private key in browser localStorage). When present →
 * LIVE; when absent → DEMO. The badge links to /settings/connect-
 * sodex so the user can flip modes by connecting or disconnecting
 * a wallet.
 *
 * Demo mode is the safe default — first-time visitors and the
 * buildathon judges see DEMO until they explicitly connect.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { readLocalKey } from "@/lib/sodex-onchain/local-keys";

interface ModeInfo {
  mode: "demo" | "live";
  address: string | null;
}

export function TradeModeBadge() {
  const [info, setInfo] = useState<ModeInfo | null>(null);

  useEffect(() => {
    const refresh = () => {
      const key = readLocalKey("mainnet");
      setInfo(
        key
          ? { mode: "live", address: key.address }
          : { mode: "demo", address: null },
      );
    };
    refresh();
    // Re-check on storage events so a connect in another tab updates here.
    window.addEventListener("storage", refresh);
    // Also poll every 5s as a belt-and-suspenders for same-tab changes
    // (storage events don't fire within the same tab).
    const t = setInterval(refresh, 5000);
    return () => {
      window.removeEventListener("storage", refresh);
      clearInterval(t);
    };
  }, []);

  if (!info) {
    // Don't render anything pre-hydration to avoid a flash of the wrong
    // state if the user is connected on reload.
    return <div style={{ width: 110, height: 26 }} aria-hidden />;
  }

  const isLive = info.mode === "live";
  const color = isLive ? "#34c39a" : "#cca15a";
  const label = isLive ? "Live" : "Demo";
  const sublabel = isLive
    ? info.address
      ? `${info.address.slice(0, 6)}…${info.address.slice(-4)}`
      : "wallet"
    : "paper";

  return (
    <Link
      href="/settings/connect-sodex"
      title={
        isLive
          ? "Live trading via SoDEX mainnet. Click to manage keys."
          : "Demo mode — paper trades only. Click to connect SoDEX for live."
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 10px",
        border: `1px solid ${color}40`,
        borderRadius: 999,
        background: `${color}10`,
        textDecoration: "none",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: 9999,
          background: color,
          // tiny pulse on Live
          animation: isLive ? "helix-pulse 1.8s ease-in-out infinite" : undefined,
        }}
      />
      <span
        style={{
          fontFamily: "var(--font-jetbrains-mono)",
          fontSize: 10,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color,
        }}
      >
        {label} <span style={{ opacity: 0.55, marginLeft: 6 }}>·</span>
        <span style={{ opacity: 0.7, marginLeft: 6 }}>{sublabel}</span>
      </span>
      <style>{`
        @keyframes helix-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.55; transform: scale(1.3); }
        }
      `}</style>
    </Link>
  );
}
