import { cn } from "./cn";

/**
 * The one button system app-wide — exactly four variants, nothing else:
 *
 *   • primary — outlined Helix orange + faint orange tint + orange text (the
 *     dashboard "Connect SoDEX →" look). EVERY non-directional primary action.
 *   • long    — outlined green + faint tint + green text. Directional
 *     "buy / long" actions (e.g. "▶ Trade LONG").
 *   • short   — outlined red + faint tint + red text. Directional
 *     "sell / short" actions.
 *   • ghost   — no border/fill, muted text, subtle hover. Low-emphasis /
 *     secondary actions (Cancel, dismiss, "how it works").
 *
 * Directional color is SEMANTIC (long=green, short=red) and matches the
 * order-ticket side toggle + the reference terminals, so it stays distinct
 * from the orange primary CTA. (The order-ticket Buy/Sell segmented control and
 * the high-emphasis solid submit button are their own directional controls and
 * intentionally do not use these outlined variants.)
 *
 * Use <Button variant=…> for <button>s; use buttonClass(variant, …) on a
 * <Link>/<a> or a third-party render-prop (e.g. RainbowKit's
 * ConnectButton.Custom). The canonical size lives in the base; override padding
 * / text-size via className — cn() is twMerge, so later utilities win.
 */
export type ButtonVariant = "primary" | "long" | "short" | "ghost";

const buttonBase =
  "inline-flex items-center justify-center gap-1.5 rounded-md border px-4 py-2.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "border-accent/50 bg-accent/20 text-accent-2 hover:bg-accent/30",
  long: "border-positive/40 bg-positive/15 text-positive hover:bg-positive/25",
  short: "border-negative/40 bg-negative/15 text-negative hover:bg-negative/25",
  ghost:
    "border-transparent bg-transparent text-fg-muted hover:bg-surface-2 hover:text-fg",
};

/** Variant class string — for <Link>/<a> or render-prop buttons. */
export function buttonClass(
  variant: ButtonVariant = "primary",
  className?: string,
): string {
  return cn(buttonBase, buttonVariants[variant], className);
}

export function Button({
  variant = "primary",
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
}) {
  return (
    <button className={buttonClass(variant, className)} {...rest}>
      {children}
    </button>
  );
}
