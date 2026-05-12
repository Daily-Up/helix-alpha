/**
 * Adversarial fixtures — 10 synthetic news items that exercise every
 * bug class. Each fixture is realistic but deliberately chosen to
 * trigger the failure mode the bug class names.
 *
 * The companion test (adversarial-fixtures.test.ts) runs each fixture
 * through the relevant pipeline stages and asserts the bad output
 * does NOT occur.
 *
 * If a future change regresses a bug class, the adversarial test fails
 * BEFORE any signals get fired into the live system.
 */

export interface Fixture {
  id: string;
  bug_class: number;
  description: string;
  /** Raw shape simulating what comes out of the SoSoValue API. */
  raw: {
    title: string;
    content: string;
    author: string;
    is_blue_verified: boolean;
    release_time: number; // ms epoch
  };
  /** Classifier output that the test treats as ground truth. */
  classification: {
    event_type: string;
    sentiment: "positive" | "negative" | "neutral";
    severity: "high" | "medium" | "low";
    confidence: number;
    affected_asset_ids: string[];
    reasoning: string;
  };
  /** What we expect the pipeline NOT to produce. */
  must_not: {
    /** Signal must not fire on these asset_ids. */
    fire_on?: string[];
    /** Signal must not exit ingestion at all. */
    pass_ingestion?: boolean;
    /** Must not pass digest gate. */
    pass_digest_gate?: boolean;
    /** Must not exceed this tier. */
    tier_at_most?: "auto" | "review" | "info";
  };
}

const T = (h: number) => Date.now() - h * 3600 * 1000;

export const FIXTURES: Fixture[] = [
  {
    id: "F01_pharos_listing_proxy",
    bug_class: 1,
    description: "Bug 1 — Upbit lists PROS, classifier proxies to BTC",
    raw: {
      title:
        "Upbit will list Pharos (PROS) for spot trading on May 8th at 20:30 in KRW, BTC, and USDT trading pairs.",
      content: "PROS is the native token of Pharos Network.",
      author: "panews",
      is_blue_verified: false,
      release_time: T(2),
    },
    classification: {
      event_type: "listing",
      sentiment: "positive",
      severity: "medium",
      confidence: 0.85,
      affected_asset_ids: ["tok-btc", "idx-ssirwa"],
      reasoning:
        "PROS not in tradable universe; using tok-btc as broad proxy.",
    },
    must_not: { fire_on: ["tok-btc"] },
  },
  {
    id: "F02_layerzero_security_proxy",
    bug_class: 1,
    description: "Bug 1 — LayerZero vuln, classifier proxies to BTC/ETH",
    raw: {
      title:
        "LayerZero default library contract has critical security vulnerability — $178M at risk",
      content:
        "ZRO not tradable. Using L1 proxies for routing.",
      author: "ChainCatcher",
      is_blue_verified: false,
      release_time: T(3),
    },
    classification: {
      event_type: "security",
      sentiment: "negative",
      severity: "high",
      confidence: 0.9,
      affected_asset_ids: ["tok-btc", "tok-eth"],
      reasoning:
        "ZRO token isn't tradable on SoDEX so using BTC and ETH as Layer-1 proxies.",
    },
    must_not: { fire_on: ["tok-btc", "tok-eth"] },
  },
  {
    id: "F03_mstr_bsketed_to_mag7",
    bug_class: 1,
    description: "Bug 1 — Strategy/MSTR catalyst routed to MAG7 basket",
    raw: {
      title: "Strategy added 145,834 BTC to its treasury, JPMorgan estimates $30B impact",
      content: "MicroStrategy continues accumulation.",
      author: "Bloomberg",
      is_blue_verified: true,
      release_time: T(4),
    },
    classification: {
      event_type: "treasury",
      sentiment: "positive",
      severity: "high",
      confidence: 0.92,
      affected_asset_ids: ["trs-mstr", "tok-btc", "idx-ssimag7"],
      reasoning: "MSTR treasury news; included MAG7 as institutional proxy.",
    },
    must_not: { fire_on: ["idx-ssimag7"] },
  },
  {
    id: "F04_seed_round_too_small",
    bug_class: 2,
    description: "Bug 2 — $12M seed on $5B-cap chain shouldn't be REVIEW",
    raw: {
      title: "Balcony Completes $12.70M Seed Round, Led by Blockchange Ventures",
      content: "Avalanche-based RWA infra protocol Balcony closed seed.",
      author: "TheBlock",
      is_blue_verified: false,
      release_time: T(2),
    },
    classification: {
      event_type: "fundraising",
      sentiment: "positive",
      severity: "medium",
      confidence: 0.8,
      affected_asset_ids: ["tok-avax"],
      reasoning: "Seed round may benefit AVAX ecosystem.",
    },
    must_not: { tier_at_most: "info" },
  },
  {
    id: "F05_aws_outage_short_horizon",
    bug_class: 2,
    description: "Bug 2 — Resolved AWS outage given multi-day horizon",
    raw: {
      title: "Coinbase outage extends past 5 hours due to AWS issues",
      content: "Service is being restored.",
      author: "PANews",
      is_blue_verified: false,
      release_time: T(2),
    },
    classification: {
      event_type: "security",
      sentiment: "negative",
      severity: "medium",
      confidence: 0.7,
      affected_asset_ids: ["stk-coin"],
      reasoning: "Operational outage on COIN.",
    },
    must_not: {},
  },
  {
    id: "F06_msrt_uncorroborated_rumor",
    bug_class: 3,
    description:
      "Bug 3 — single-source UBS rumor that needs corroboration deadline",
    raw: {
      title:
        "Switzerland's largest bank dropped a $1.12 billion bet on Strategy",
      content: "Article cites unnamed source.",
      author: "anonymous_kol",
      is_blue_verified: false,
      release_time: T(20),
    },
    classification: {
      event_type: "treasury",
      sentiment: "negative",
      severity: "high",
      confidence: 0.85,
      affected_asset_ids: ["trs-mstr"],
      reasoning: "UBS exit would be material if confirmed.",
    },
    must_not: {},
  },
  {
    id: "F07_wlfi_fraud_then_techupdate",
    bug_class: 4,
    description:
      "Bug 4 — WLFI tech-update LONG generated while fraud allegations sit on chain history",
    raw: {
      title: "WLFI stablecoin USD1 natively issued on Tempo Mainnet",
      content: "Integration goes live.",
      author: "Decrypt",
      is_blue_verified: false,
      release_time: T(3),
    },
    classification: {
      event_type: "tech_update",
      sentiment: "positive",
      severity: "medium",
      confidence: 0.7,
      affected_asset_ids: ["tok-wlfi"],
      reasoning: "Technical milestone for WLFI.",
    },
    must_not: {},
  },
  {
    id: "F08_layerzero_arb_incidental",
    bug_class: 5,
    description:
      "Bug 5 — LayerZero vuln (subject) shouldn't conflict with ARB-specific governance",
    raw: {
      title:
        "LayerZero default library contract has critical security vulnerability",
      content: "Stargate, Ethena, EtherFi exposed.",
      author: "ChainCatcher",
      is_blue_verified: false,
      release_time: T(5),
    },
    classification: {
      event_type: "security",
      sentiment: "negative",
      severity: "high",
      confidence: 0.85,
      affected_asset_ids: ["tok-arb"], // incidental
      reasoning: "ARB uses LayerZero — included as affected.",
    },
    must_not: {},
  },
  {
    id: "F09_crypto_one_liners_digest",
    bug_class: 6,
    description: "Bug 6 — Crypto One Liners bundles 5 events",
    raw: {
      title:
        "Crypto One Liners... DIVERSIFIED CRYPTO GLXY — Galaxy Digital 1W: +24.2%, Strong Q1 beat: adjusted EPS loss of $0.49 vs $0.95 exp",
      content:
        "Multiple Q1 earnings beats from crypto-adjacent companies. Circle earnings May 11. BitGo May 13. COIN job cuts and MARA M&A add tradable catalysts.",
      author: "PANews",
      is_blue_verified: false,
      release_time: T(2),
    },
    classification: {
      event_type: "earnings",
      sentiment: "positive",
      severity: "medium",
      confidence: 0.75,
      affected_asset_ids: ["stk-crcl"],
      reasoning: "Bundled positive earnings news touches CRCL.",
    },
    must_not: { pass_digest_gate: true },
  },
  {
    id: "F10_promotional_shill",
    bug_class: 8,
    description:
      "Bug 8 — Hyperbolic CT shill on SUI shouldn't reach REVIEW",
    raw: {
      title: "🚀🚀 Hands down the BIGGEST announcement from SUI 🔥🔥",
      content: "Trust me, this is unstoppable. Don't miss it!!!",
      author: "anon_kol_42",
      is_blue_verified: false,
      release_time: T(2),
    },
    classification: {
      event_type: "tech_update",
      sentiment: "positive",
      severity: "medium",
      confidence: 0.65,
      affected_asset_ids: ["tok-sui"],
      reasoning: "Tech catalyst for SUI.",
    },
    must_not: { tier_at_most: "info" },
  },
  // ── Bug 7: parser-prefix leak from upstream feed.
  // The sanitizer strips HTML cleanly; the harder case is a title where
  // the upstream parser leaked body content + an "original text:" prefix.
  // validateTitle catches this even after sanitization.
  {
    id: "F11_parser_prefix_leak",
    bug_class: 7,
    description:
      "Bug 7 — 'original text:' prefix leak from upstream feed adapter",
    raw: {
      title:
        "original text: Now there are several reasons Bloomberg won't disclose...",
      content: "Body.",
      author: "panews",
      is_blue_verified: false,
      release_time: T(1),
    },
    classification: {
      event_type: "regulatory",
      sentiment: "negative",
      severity: "medium",
      confidence: 0.7,
      affected_asset_ids: ["tok-wlfi"],
      reasoning: "(would have run if title had been clean)",
    },
    must_not: { pass_ingestion: true },
  },

  // ── Dimension 1: semantic freshness ──
  // Two outlets covering the same catalyst with overlapping entity tokens
  // should be recognized as duplicate coverage and not produce two signals.
  {
    id: "D1_dup_coinbase_outage_second_outlet",
    bug_class: 1, // re-use the asset-routing bug class slot for fixture indexing
    description:
      "Dim 1 — second outlet covering the same Coinbase outage; freshness gate must mark this duplicate, not produce a fresh signal",
    raw: {
      title:
        "Coinbase exchange experiences AWS-related outage exceeding 5 hours; restoration of service in progress",
      content: "Coinbase services affected by AWS infrastructure issues.",
      author: "ChainCatcher",
      is_blue_verified: false,
      release_time: T(1),
    },
    classification: {
      event_type: "security",
      sentiment: "negative",
      severity: "medium",
      confidence: 0.7,
      affected_asset_ids: ["stk-coin"],
      reasoning:
        "Operational outage on COIN — second outlet, same event as a prior coverage 1h earlier.",
    },
    must_not: {},
  },

  // ── Dimension 2: price-already-moved ──
  // Coinbase Q1 miss after the stock has already absorbed the move.
  // Gate must downgrade or drop with `move_largely_realized`.
  {
    id: "D2_price_already_moved_coinbase_q1",
    bug_class: 2,
    description:
      "Dim 2 — Coinbase Q1 miss SHORT signal where COIN is already down 9%; alpha is mostly priced in",
    raw: {
      title:
        "Coinbase missed Q1 revenue estimates as crypto trading slides; shares already down 9%",
      content: "Earnings miss; market reaction completed within minutes.",
      author: "PANews",
      is_blue_verified: false,
      release_time: T(2),
    },
    classification: {
      event_type: "earnings",
      sentiment: "negative",
      severity: "high",
      confidence: 0.85,
      affected_asset_ids: ["stk-coin"],
      reasoning:
        "Q1 miss — but the stock already moved 9% against the predicted direction; realized_fraction > 0.6.",
    },
    must_not: {},
  },

  // ── Dimension 3: reasoning-enriched (long mechanism chain) ──
  // AXS minor spending news — 3+ steps from event to a price move; the
  // classifier must produce mechanism_length ≥ 3 and the gate caps tier.
  {
    id: "D3_reasoning_long_chain_axs",
    bug_class: 8,
    description:
      "Dim 3 — AXS $100k spending news; 3+ step mechanism chain; conviction must cap at INFO",
    raw: {
      title:
        "Axie Infinity team announces $100k allocation to community grants program",
      content:
        "Speculative chain: grants → community engagement → user growth → token demand.",
      author: "PANews",
      is_blue_verified: false,
      release_time: T(2),
    },
    classification: {
      event_type: "treasury",
      sentiment: "positive",
      severity: "low",
      confidence: 0.6,
      affected_asset_ids: ["tok-axs"],
      reasoning:
        "Tiny treasury allocation; 3 hops from event to price impact.",
    },
    must_not: { tier_at_most: "info" },
  },

  // ── Dimension 4: mechanism cap (deterministic gate) ──
  // SEC chair direct statement — mechanism_length=1 (direct). Used to
  // demonstrate the cap does NOT fire on direct catalysts.
  {
    id: "D4_short_chain_sec_atkins",
    bug_class: 8,
    description:
      "Dim 4 — SEC chair direct statement; mechanism_length=1; conviction cap does NOT fire",
    raw: {
      title:
        "SEC's new chairman Paul Atkins announces 'cryptocurrency era has arrived' in policy speech",
      content:
        "Direct regulatory statement from named SEC chair; no intermediate hops to crypto price.",
      author: "Bloomberg",
      is_blue_verified: true,
      release_time: T(2),
    },
    classification: {
      event_type: "regulatory",
      sentiment: "positive",
      severity: "high",
      confidence: 0.9,
      affected_asset_ids: ["tok-btc"],
      reasoning:
        "Direct, named, on-the-record SEC statement — mechanism_length=1, no cap.",
    },
    must_not: {},
  },

  // ── Dimension 5: base rate target ceiling ──
  // Earnings reaction on a broad-equity stock (AMZN). The default
  // riskProfileForSubtype would give +18% target; base rate calibrates
  // to ~6%. Gate must refuse upstream targets > 2× (mean+stdev).
  {
    id: "D5_base_rate_amzn_earnings",
    bug_class: 2,
    description:
      "Dim 5 — AMZN earnings reaction; base rate calibrates target to ~6%, NOT +18%",
    raw: {
      title: "Amazon beats Q1 EPS estimates; AWS revenue grows 19% YoY",
      content: "Strong cloud growth, beat across the board.",
      author: "Bloomberg",
      is_blue_verified: true,
      release_time: T(3),
    },
    classification: {
      event_type: "earnings",
      sentiment: "positive",
      severity: "high",
      confidence: 0.85,
      affected_asset_ids: ["stk-amzn"],
      reasoning:
        "Concrete earnings beat — base rate for earnings × broad_equity is mean=4%, stdev=5%.",
    },
    must_not: {},
  },
];
