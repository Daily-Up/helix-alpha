import { cn } from "./cn";

/**
 * A per-asset visual anchor for table identifier cells — the thing that makes
 * a data table read as "an exchange", not "a spreadsheet".
 *
 * For crypto majors we ship the REAL brand mark: CC0 SVGs from the
 * cryptocurrency-icons set, bundled under /public/asset-logos and served
 * same-origin (no third-party image host at runtime — matters for a judged
 * demo behind a strict CSP). The long tail — crypto-stocks (COIN, MSTR),
 * internal indexes (…​.ssi), coins we don't have a mark for — falls back to a
 * deterministic monogram chip: a muted, on-palette colour derived from the
 * ticker so a given asset is the SAME colour everywhere it appears.
 */

/** Lowercase tickers we have a real bundled SVG for (see /public/asset-logos). */
const REAL_LOGOS = new Set([
  "1inch", "aave", "ada", "algo", "atom", "avax", "bat", "bch", "bnb", "btc",
  "chz", "comp", "crv", "dai", "dash", "doge", "dot", "enj", "eos", "etc",
  "eth", "fil", "grt", "icp", "link", "ltc", "mana", "matic", "mkr", "qnt",
  "sand", "snx", "sol", "trx", "tusd", "uni", "usdc", "usdt", "vet", "wbtc",
  "xlm", "xmr", "xrp", "xtz", "yfi", "zec", "zil",
]);

/** Symbols that should borrow another asset's mark (wrapped / renamed / staked). */
const ALIAS: Record<string, string> = {
  pol: "matic",
  weth: "eth",
  steth: "eth",
  wsteth: "eth",
  reth: "eth",
  cbbtc: "btc",
  tbtc: "btc",
  wbeth: "eth",
  usdce: "usdc",
};

/** Curated, muted hue ring for monograms — warm→cool, never garish on near-black. */
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

function logoFile(clean: string): string | null {
  const lc = clean.toLowerCase();
  if (REAL_LOGOS.has(lc)) return lc;
  const a = ALIAS[lc];
  if (a && REAL_LOGOS.has(a)) return a;
  return null;
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
  const file = c ? logoFile(c) : null;

  if (file) {
    // Real brand mark — the CC0 SVGs already carry their own coloured circle.
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/asset-logos/${file}.svg`}
        alt=""
        aria-hidden
        width={size}
        height={size}
        loading="lazy"
        className={cn("shrink-0 rounded-full", className)}
        style={{ width: size, height: size }}
      />
    );
  }

  // Monogram fallback — deterministic, on-palette chip.
  const glyph = c.slice(0, 2) || "•";
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
        fontSize: size * 0.4,
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
