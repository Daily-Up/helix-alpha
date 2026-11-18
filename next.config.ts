import type { NextConfig } from "next";

/**
 * Content-Security-Policy — PRODUCTION ONLY.
 *
 * Applied via `headers()` only when NODE_ENV === "production" (i.e. on
 * `next build`/`next start` and on Vercel). Dev stays relaxed because
 * Next's HMR / React Refresh needs 'unsafe-eval' and inline scripts a
 * strict CSP would block.
 *
 * script-src uses 'unsafe-inline' (no 'unsafe-eval'): a header-based CSP
 * can't carry a per-request nonce, and Next's inline hydration/bootstrap
 * scripts need either a nonce or 'unsafe-inline'. 'unsafe-eval' is
 * intentionally omitted — the production bundle (viem/@noble, wagmi,
 * lightweight-charts, WalletConnect) is eval-free. The CSP still blocks
 * external script origins, eval, <object>/<embed>, framing of the app,
 * and cross-origin form posts.
 *
 * POST-RACE FOLLOW-UP: replace 'unsafe-inline' scripts with a nonce-based
 * CSP generated in `middleware.ts` (Next auto-applies the nonce to its own
 * scripts). That opts every route into dynamic rendering, so it's deferred
 * past the buildathon rather than shipped here.
 *
 * Wallets are INJECTED-ONLY (desktop extensions via EIP-6963), so there are
 * no WalletConnect/Reown origins to allow — the wallet talks to the page
 * through window.ethereum, not the network.
 *
 * connect-src enumerates every origin the browser actually calls:
 *   - SoDEX gateway, REST + WS, mainnet + testnet   (*.sodex.dev)
 *   - SoSoValue open API                            (openapi.sosovalue.com)
 *   - DefiLlama price/flow data                      (*.llama.fi hosts)
 *   - SoDEX chain RPC + explorer                     (*.valuechain.xyz)
 *   - eth.merkle.io  (viem's default mainnet RPC — wagmi `http()` uses it
 *     for ENS / balance reads after a wallet connects)
 */
const csp = [
  `default-src 'self'`,
  `script-src 'self' 'unsafe-inline'`,
  `style-src 'self' 'unsafe-inline'`,
  // Unsplash hero photos are hotlinked from images.unsplash.com per their
  // API guidelines (we never rehost). The Unsplash API itself is called
  // server-side, so it needs no connect-src entry.
  `img-src 'self' data: blob: https://images.unsplash.com`,
  `font-src 'self'`,
  [
    // Injected wallets only (desktop) — no WalletConnect/Reown origins.
    `connect-src 'self'`,
    `https://*.sodex.dev wss://*.sodex.dev`,
    `https://openapi.sosovalue.com`,
    `https://coins.llama.fi https://defillama-datasets.llama.fi`,
    `https://*.valuechain.xyz`,
    `https://eth.merkle.io`,
  ].join(" "),
  `frame-src 'none'`,
  `object-src 'none'`,
  `base-uri 'self'`,
  `frame-ancestors 'none'`,
  `form-action 'self'`,
  `upgrade-insecure-requests`,
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  experimental: {
    viewTransition: true,
  },
  async headers() {
    // Dev stays relaxed (HMR needs eval + inline); CSP is prod-only.
    if (process.env.NODE_ENV !== "production") return [];
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  async redirects() {
    // Canonical host is the apex helixalpha.xyz. Every other host THIS project
    // serves — the www subdomain, the Vercel-generated production domain, and
    // the stable production alias — 308-redirects to it, preserving path +
    // query string. Preview deployments (helix-alpha-git-*, helix-alpha-<hash>-*)
    // are deliberately NOT listed, so branch previews keep working on their own
    // URLs.
    //
    // NB: helix-alpha.vercel.app is a DIFFERENT Vercel account's app (a Create
    // Next App starter), not ours — which is exactly why this project's
    // generated domain is the doubled helix-alpha-helix-alpha.vercel.app. We
    // can't (and don't) redirect a host we don't own, so it's not listed.
    const CANONICAL_HOST = "helixalpha.xyz";
    const NON_CANONICAL_HOSTS = [
      "www.helixalpha.xyz",
      "helix-alpha-helix-alpha.vercel.app", // Vercel-generated production domain
      "helix-alpha-kappa.vercel.app", // stable production alias
    ];
    const hostRedirects = NON_CANONICAL_HOSTS.map((host) => ({
      source: "/:path*",
      has: [{ type: "host" as const, value: host }],
      destination: `https://${CANONICAL_HOST}/:path*`,
      permanent: true,
    }));

    // AlphaIndex is archived — its page and any legacy /alphaindex links go to
    // the Wealth Index. (The live-deploy code path is hard-disabled too.)
    return [
      ...hostRedirects,
      { source: "/index-fund", destination: "/wealth-index", permanent: true },
      { source: "/index-fund/:path*", destination: "/wealth-index", permanent: true },
      { source: "/alphaindex", destination: "/wealth-index", permanent: true },
      { source: "/alphaindex/:path*", destination: "/wealth-index", permanent: true },
    ];
  },
};

export default nextConfig;
