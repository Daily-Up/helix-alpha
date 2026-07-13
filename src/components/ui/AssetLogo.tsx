import { cn } from "./cn";

/**
 * A per-asset visual anchor for table identifier cells — the thing that makes
 * a data table read as "an exchange", not "a spreadsheet". We trade a mix of
 * crypto majors, crypto-stocks (COIN, MSTR) and internal indexes (…​.ssi), so
 * there is no single logo CDN that covers the universe — and a judged demo
 * shouldn't depend on a third-party image host anyway. So this is a monogram
 * chip: a deterministic, on-palette colour derived from the ticker + a 1–2
 * glyph mark. Recognisable majors get their real symbol (₿ / Ξ).
 *
 * Deterministic hue keeps a given asset the SAME colour everywhere it appears,
 * so the eye learns "orange square = BTC" across screens.
 */

const GLYPH: Record<string, string> = {
  BTC: "₿",
  WBTC: "₿",
  CBBTC: "₿",
  ETH: "Ξ",
  WETH: "Ξ",
  STETH: "Ξ",
};

/** Curated, muted hue ring — warm→cool, never garish on the near-black bg. */
const HUES = [14, 28, 40, 96, 150, 172, 194, 214, 258, 292, 330, 352];

function clean(sym: string): string {
  return sym
    .replace(/\/(usdc|usdt|usd|perp)$/i, "")
    .replace(/[-_].*$/, "") // stk-coin / tok-eth → base
    .replace(/\.ssi$/i, "")
    .replace(/^ssi/i, "")
    .replace(/[^a-z0-9]/gi, "")
    .toUpperCase();
}

function hueOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}

export function AssetLogo({
  symbol,
  size = 22,
  className,
}: {
  symbol: string | null | undefined;
  size?: number;
  className?: string;
}) {
  const c = symbol ? clean(symbol) : "";
  const glyph = GLYPH[c] ?? (c.slice(0, 2) || "•");
  const hue = hueOf(c || "?");
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-[6px] font-[var(--font-jetbrains-mono)] font-semibold uppercase leading-none tracking-tight",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: glyph.length > 1 && glyph.length <= 2 ? size * 0.4 : size * 0.5,
        background: `hsl(${hue} 45% 22% / 0.9)`,
        color: `hsl(${hue} 62% 72%)`,
        boxShadow: `inset 0 0 0 1px hsl(${hue} 46% 46% / 0.45)`,
      }}
    >
      {glyph}
    </span>
  );
}

/**
 * Logo + name/ticker stack — the Token-Terminal "▢ Tron  TRX" identifier cell.
 * `primary` is the loud line (ticker/display symbol), `secondary` the muted
 * line beneath (full name, market, etc). Pass whatever the table already
 * formats; this only owns the logo + layout.
 */
export function AssetCell({
  logoSymbol,
  primary,
  secondary,
  size,
  className,
}: {
  logoSymbol: string | null | undefined;
  primary: React.ReactNode;
  secondary?: React.ReactNode;
  size?: number;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <AssetLogo symbol={logoSymbol} size={size} />
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="truncate font-medium text-fg">{primary}</span>
        {secondary != null && secondary !== "" ? (
          <span className="truncate text-[10px] text-fg-dim">{secondary}</span>
        ) : null}
      </div>
    </div>
  );
}
