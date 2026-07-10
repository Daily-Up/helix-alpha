"use client";

/**
 * Trade-mode badge — shows the user whether they're in DEMO mode
 * (paper trades, no real money) or LIVE mode (SoDEX key set up and
 * disclaimer accepted, Execute Live works against mainnet).
 *
 * State comes from the shared `useTradeMode` hook so this badge and the
 * /signals connect panel can never disagree. The badge links to
 * /settings/connect-sodex to manage keys.
 *
 * Demo mode is the safe default — first-time visitors and the
 * buildathon judges see DEMO until they explicitly connect + accept.
 */
import Link from "next/link";
import { useTradeMode } from "@/lib/sodex-onchain/useTradeMode";

export function TradeModeBadge() {
  const tm = useTradeMode("mainnet");

  if (tm.loading) {
    // Don't render anything pre-hydration to avoid a flash of the wrong
    // state if the user is connected on reload.
    return <div style={{ width: 110, height: 26 }} aria-hidden />;
  }

  const isLive = tm.ready;
  const color = isLive ? "#34c39a" : "#cca15a";
  const label = isLive ? "Live" : "Demo";
  const sublabel = isLive
    ? tm.address
      ? `${tm.address.slice(0, 6)}…${tm.address.slice(-4)}`
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
