/**
 * /settings/connect-sodex — Helix's "Connect SoDEX" wizard.
 *
 * Lets a user connect their MetaMask-style wallet, mint a fresh
 * Helix-scoped API key (signed by the master wallet via SoDEX's
 * addAPIKey action), list / revoke existing keys, and set safety
 * limits — all without Helix's server ever seeing the API key
 * private key.
 */

import { Shell } from "@/components/layout/Shell";
import { ConnectSodexPage } from "@/components/sodex/ConnectSodexPage";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <Shell>
      <ConnectSodexPage />
    </Shell>
  );
}
