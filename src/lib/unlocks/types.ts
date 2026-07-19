/**
 * Types for the DefiLlama emissions (token-unlock) data source.
 *
 * Shapes verified live against
 *   https://defillama-datasets.llama.fi/emissions/{slug}
 *   https://coins.llama.fi/prices/current/{tokenId}
 * on 2026-07-19. Only the fields we consume are typed; the feed carries
 * more (documentedData.tokenAllocation, unlockUsdChart, etc.) that we skip.
 */

/** One recipient allocation inside an aggregated unlock event. */
export interface LlamaAllocation {
  recipient: string;
  category: string; // insiders | privateSale | airdrop | publicSale | ...
  unlockType: string; // "cliff" | "linear"
  amount?: number;
}

/** One aggregated unlock event (one object per timestamp). */
export interface LlamaUnlockEvent {
  timestamp: number; // unix SECONDS
  cliffAllocations: LlamaAllocation[];
  linearAllocations: LlamaAllocation[];
  summary?: { totalTokensCliff?: number };
}

/** One cumulative-unlocked series (per allocation tranche). */
export interface LlamaSeries {
  label: string;
  data: Array<{
    timestamp: number; // unix SECONDS
    unlocked?: number;
    rawEmission?: number;
    burned?: number;
  }>;
}

/** Per-protocol emissions detail (only fields we use). */
export interface EmissionsDetail {
  name?: string;
  gecko_id?: string | null;
  metadata?: {
    token?: string; // "coingecko:aptos" | "arbitrum:0x…" → feed to coins API
    unlockEvents?: LlamaUnlockEvent[];
  };
  documentedData?: { data?: LlamaSeries[] };
  categories?: Record<string, string[]>; // { noncirculating:[...], insiders:[...], ... }
  supplyMetrics?: {
    maxSupply?: number;
    adjustedSupply?: number;
  };
}

/** coins.llama.fi price entry. */
export interface LlamaPrice {
  decimals?: number;
  symbol: string;
  price: number;
  timestamp: number;
  confidence: number;
}
