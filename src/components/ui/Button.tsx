import { cn } from "./cn";

/**
 * The one primary-CTA style app-wide: outlined Helix orange with a faint orange
 * tint fill and orange text (the dashboard "Connect SoDEX →" look). Use
 * <PrimaryButton> for <button>s; use `primaryButtonClass` on <Link>/<a> or on a
 * third-party render-prop button (e.g. RainbowKit's ConnectButton.Custom).
 */
export const primaryButtonClass =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-accent/50 bg-accent/20 px-4 py-2.5 text-[13px] font-medium text-accent-2 transition-colors hover:bg-accent/30";

export function PrimaryButton({
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={cn(primaryButtonClass, className)} {...rest}>
      {children}
    </button>
  );
}
