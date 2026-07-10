"use client";

/**
 * Global error boundary — catches failures in the root layout itself.
 * It replaces the entire document, so it must render its own <html>/<body>
 * and cannot rely on globals.css tokens being present. Colors are
 * hard-coded to the brand's dark palette so even a total root failure
 * stays on-brand.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 18,
          padding: 24,
          textAlign: "center",
          background: "#0b0b0e",
          color: "#e6e9ef",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        }}
      >
        <div
          style={{
            fontSize: 12,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            color: "#e89373",
          }}
        >
          Helix
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "#ede4d3" }}>
          Something went wrong
        </h1>
        <p style={{ maxWidth: 420, margin: 0, color: "#8a93a6", lineHeight: 1.6 }}>
          The app failed to load. This is usually temporary — please try again.
        </p>
        <button
          onClick={reset}
          style={{
            borderRadius: 8,
            padding: "10px 18px",
            fontSize: 14,
            fontWeight: 600,
            color: "#0b0b0e",
            background: "#d97757",
            border: "none",
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
