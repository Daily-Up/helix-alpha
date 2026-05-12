/**
 * Sector & Spotlight (1.8) — sector dominance & 24h change.
 *
 * Used by the narrative cycle module to detect sector rotation
 * (DeFi → AI → Meme → ... cycles).
 */

import { sosoGet } from "./client";
import type { SectorSpotlight } from "./types";

export function getSectorSpotlight(): Promise<SectorSpotlight> {
  return sosoGet<SectorSpotlight>("/currencies/sector-spotlight");
}
