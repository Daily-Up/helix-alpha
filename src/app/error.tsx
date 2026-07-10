"use client";

import { useEffect } from "react";

/**
 * Route-level error boundary. Catches render/fetch errors in any page
 * under the root layout so a bad data shape or undefined field renders
 * an on-brand, recoverable fallback instead of a raw crash overlay.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface to the console for debugging; no PII in these errors.
    console.error("[route-error]", error);
  }, [error]);

  return (
    <main
      style={{
        minHeight: "70dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 18,
        padding: 24,
        textAlign: "center",
        color: "var(--fg)",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          letterSpacing: "0.22em",
          textTransform: "uppercase",
          color: "var(--negative)",
        }}
      >
        Something went wrong
      </div>
      <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "var(--fg-brand)" }}>
        This section hit a snag
      </h1>
      <p style={{ maxWidth: 420, margin: 0, color: "var(--fg-muted)", lineHeight: 1.6 }}>
        The data didn&apos;t load cleanly. This is usually temporary — try
        again.
      </p>
      <button
        onClick={reset}
        style={{
          borderRadius: 8,
          padding: "10px 18px",
          fontSize: 14,
          fontWeight: 600,
          color: "#0b0b0e",
          background: "var(--accent)",
          border: "none",
          cursor: "pointer",
        }}
      >
        Try again
      </button>
    </main>
  );
}
