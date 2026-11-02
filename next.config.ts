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
 * connect-src enumerates every origin the browser actually calls:
 *   - SoDEX gateway, REST + WS, mainnet + testnet   (*.sodex.dev)
 *   - SoSoValue open API                            (openapi.sosovalue.com)
 *   - DefiLlama price/flow data                      (*.llama.fi hosts)
 *   - SoDEX chain RPC + explorer                     (*.valuechain.xyz)
 *   - WalletConnect / Reown relay, explorer, pulse, web3modal (used by
 *     RainbowKit's connect modal + WalletConnect QR)
 *   - eth.merkle.io  (viem's default mainnet RPC — wagmi `http()` uses it
 *     for ENS / balance reads after a wallet connects)
 */
const csp = [
  `default-src 'self'`,
  `script-src 'self' 'unsafe-inline'`,
  `style-src 'self' 'unsafe-inline'`,
  `img-src 'self' data: blob: https://explorer-api.walletconnect.com`,
  `font-src 'self'`,
  [
    `connect-src 'self'`,
    `https://*.sodex.dev wss://*.sodex.dev`,
    `https://openapi.sosovalue.com`,
    `https://coins.llama.fi https://defillama-datasets.llama.fi`,
    `https://*.valuechain.xyz`,
    `https://*.walletconnect.com https://*.walletconnect.org`,
    `wss://*.walletconnect.com wss://*.walletconnect.org`,
    `https://*.reown.com https://api.web3modal.org`,
    `https://eth.merkle.io`,
  ].join(" "),
  `frame-src https://verify.walletconnect.com`,
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
};

export default nextConfig;
