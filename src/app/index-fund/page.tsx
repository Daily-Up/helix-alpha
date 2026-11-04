import { redirect } from "next/navigation";

/**
 * AlphaIndex has been replaced by the Wealth Index. The old AI-managed
 * crypto-basket engine is archived (still on disk under
 * src/lib/index-fund, src/lib/alphaindex and src/components/index-fund), but
 * this route now points at the new feature.
 */
export default function IndexFundPage() {
  redirect("/wealth-index");
}
