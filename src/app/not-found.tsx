import Link from "next/link";

/**
 * Themed 404. Deliberately self-contained — it must NOT depend on the
 * dashboard Shell or the Web3 providers, because it renders for any
 * unmatched path (including ones outside the app group). Styling uses
 * the global design tokens so it stays on-brand instead of falling back
 * to Next.js's default white page.
 */
export default function NotFound() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 20,
        padding: 24,
        textAlign: "center",
        background: "var(--bg)",
        color: "var(--fg)",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          letterSpacing: "0.22em",
          textTransform: "uppercase",
          color: "var(--accent-2)",
        }}
      >
        Helix · 404
      </div>
      <h1 style={{ fontSize: 28, fontWeight: 600, margin: 0, color: "var(--fg-brand)" }}>
        This page doesn&apos;t exist
      </h1>
      <p style={{ maxWidth: 420, margin: 0, color: "var(--fg-muted)", lineHeight: 1.6 }}>
        The link may be old or mistyped. Everything Helix does lives on the
        dashboard.
      </p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
        <Link
          href="/app"
          style={{
            borderRadius: 8,
            padding: "10px 18px",
            fontSize: 14,
            fontWeight: 600,
            color: "#0b0b0e",
            background: "var(--accent)",
            textDecoration: "none",
          }}
        >
          Go to dashboard →
        </Link>
        <Link
          href="/signals"
          style={{
            borderRadius: 8,
            padding: "10px 18px",
            fontSize: 14,
            fontWeight: 500,
            color: "var(--fg)",
            border: "1px solid var(--line-2)",
            textDecoration: "none",
          }}
        >
          View live signals
        </Link>
      </div>
    </main>
  );
}
