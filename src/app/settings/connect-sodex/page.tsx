/**
 * Legacy route — the Connect SoDEX wizard moved to /settings/sodex and setup
 * now runs in the global SodexAuth modal. Redirect so old links keep working.
 */

import { redirect } from "next/navigation";

export default function Page() {
  redirect("/settings/sodex");
}
