import { cn } from "./cn";

/**
 * An action that REFUSES to render when it's impossible. Pass `enabled`
 * (the possibility check) — if false, nothing renders. No more walls of
 * identical Transfer / Deposit / Withdraw links on empty rows.
 */
export function Action({
  enabled,
  children,
  onClick,
  href,
  tone = "default",
  title,
  disabled,
  className,
}: {
  /** The possibility check. When false, the action does not render at all. */
  enabled: boolean;
  children: React.ReactNode;
  onClick?: () => void;
  href?: string;
  tone?: "default" | "primary" | "danger";
  title?: string;
  /** Possible-but-temporarily-unavailable (renders muted, not hidden). */
  disabled?: boolean;
  className?: string;
}) {
  if (!enabled) return null;

  const base = "inline-flex items-center gap-1 text-xs transition-colors";
  const toneClass =
    tone === "danger"
      ? "text-negative/80 hover:text-negative"
      : tone === "primary"
        ? "text-accent-2 hover:text-accent"
        : "text-fg-muted hover:text-fg";

  if (href) {
    const external = /^https?:\/\//.test(href);
    return (
      <a
        href={href}
        title={title}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        className={cn(base, toneClass, className)}
      >
        {children}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(base, toneClass, disabled && "cursor-not-allowed opacity-40", className)}
    >
      {children}
    </button>
  );
}
