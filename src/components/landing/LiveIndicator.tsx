export function LiveIndicator() {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="live-pulse-dot" aria-hidden />
      <span
        className="font-[var(--font-jetbrains-mono)] uppercase"
        style={{
          fontSize: "10px",
          color: "#8a857a",
          letterSpacing: "0.1em",
        }}
      >
        live
      </span>
    </span>
  );
}
