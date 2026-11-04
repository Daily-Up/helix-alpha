/**
 * /settings/sodex — "Manage keys". The standing SoDEX management surface
 * (key list + revoke, generate, builder-fee status). Setup itself runs in the
 * global SodexAuth modal, opened from the header.
 */

import { Shell } from "@/components/layout/Shell";
import { SodexSettingsPage } from "@/components/sodex/SodexSettingsPage";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <Shell>
      <SodexSettingsPage />
    </Shell>
  );
}
