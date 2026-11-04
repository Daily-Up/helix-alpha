# Wealth Index — in-app investing plan (v2)

**Status: research + plan. No code beyond the read-only per-fund page has been written for investing. Phases 3–4 wait for your explicit OK. Real money is gated: research → plan → DRY_RUN → testnet (chain 138565) → your OK → one min-size mainnet test → enable.**

Two independent tracks, because the fund types use two different rails:

| Track | Funds (fundType) | Rail | Builder fee earned on |
|---|---|---|---|
| **A. Spot** | Curated ETFs + vBOXX + vSTRC (`clob`) | SoDEX spot order book (off-chain signed, like perps) | **Sells only** |
| **B. Vaults** | CXMT, Unitree (`escrow_vault`); USDC Earn (`bridged_vault`) | On-chain ValueChain contract txs (master wallet) | **Redemptions** |

Across both, **the builder fee is earned on exits, not entries** (buys/deposits earn nothing — see §A2). So the fee-bearing work is routing sells/redemptions through Helix's builder code.

---

## Builder config (constants to add)

```
WEALTH_BUILDER_ADDRESS = <YOUR PAYOUT ADDRESS>   # ⚠ you must supply this — left blank on purpose
WEALTH_BUILDER_ID      = 8409                     # Helix's existing SoDEX builder id (same as perps)
WEALTH_FEE_RATE        = 10                        # 0.01% on redeems/sells (precision 100_000 → 10/100000)
WEALTH_MAX_FEE_RATE    = 10                        # approval cap; spot/vault hard cap is 2000 (2%)
```

`feeRate`/`maxFeeRate` use **precision 100_000** (so 10 = 0.01%, 2000 = 2%). The hard cap is **2000 (2%)** on both spot and the wealth vaults (matches Helix's existing note: spot ≤ 2000, perps ≤ 200).

---

## A. Curated ETFs via SoDEX spot orders

### A1. Endpoint, payload, signing
- These funds are **CLOB spot pairs**, quote `vUSDC` (6 dp), share token 8 dp. Symbol IDs (from `GET /wealth/funds`):

  | Fund | Pair | symbolId | share token | dp |
  |---|---|---|---|---|
  | US 500 (vVOO) | vVOO_vUSDC | 39 | 0x9bd2…042b | 8 |
  | US Tech 100 (vQQQ) | vQQQ_vUSDC | 41 | 0x09e0…1ee5 | 8 |
  | US Broad Tech (vVGT) | vVGT_vUSDC | 42 | 0xd484…9fbd | 8 |
  | US Selected Dividend (vSCHD) | vSCHD_vUSDC | 37 | 0x58d8…6d1b | 8 |
  | US Broad Dividend (vVYM) | vVYM_vUSDC | 38 | 0x6b3d…6623 | 8 |
  | US Semis 25 (vSMH) | vSMH_vUSDC | 40 | 0x8921…d6d9 | 8 |
  | Strategy Preferred (vSTRC) | vSTRC_vUSDC | 43 | 0x7c6d…b799 | 8 |
  | US Cash Yield (vBOXX) | vBOXX_vUSDC | 36 | 0x9066…c1ab | 8 |

- **Order shape** is exactly what Helix already builds for spot today (`SodexNewOrderEntry`): `{ symbolID, clOrdID, side: BUY|SELL, type: MARKET|LIMIT, timeInForce, …}` where **BUY passes `funds` (vUSDC), SELL passes `quantity` (share units)** — spot MARKET accepts exactly one of the two. This goes through `placeOrderBatch`, which **already injects the builder code type-agnostically**.
- **Signing:** the existing **Helix trading key signs spot orders** — Helix already routes spot via `resolveSymbol` + `placeOrderBatch`; no new key or master-wallet signature is needed for the order itself.
- **Sizing rules** (min size / tick / step) come from the spot markets rules Helix already reads (`pricePrecision`, `stepSize`, `minQuantity`, `minNotional`); min notional ≈ $10 (`SODEX_MIN_NOTIONAL_USD`). The invest panel must round size to `stepSize` and reject below `minNotional`.
- **Where funds must sit:** in the **SoDEX spot account** (vUSDC balance on the spot appchain), same place spot trades already draw from. If the user's USDC is in their ValueChain wallet instead, it must be deposited to the SoDEX spot account first (same deposit the terminal assumes today).

### A2. Does the spot builder fee apply to BUYS or only SELLS?
- **Very likely sells only.** SoDEX's spot/perps run on separate appchains and builder approvals are tracked per engine (`GET /user/{addr}/builders` → `{ spot:[…], perps:[…] }`). SoDEX is Hyperliquid-derived, and Hyperliquid's rule is explicit: **"builder codes do not apply to the buying side of spot trades."** So Helix would earn the fee only when a user **sells** an ETF back to vUSDC.
- **OPEN Q (confirm vs SoDEX's own spot docs/SDK — not web-indexed):** verify the buy-side exclusion verbatim before relying on it.

### A3. Separate spot builder approval?
- The `/builders` response splits `spot` and `perps`, and the approval POST (`/user/{addr}/builders`, body `{accountID, builderID, maxFeeRate}`) is **per account**. Perps and spot have distinct account ids per appchain, so **a separate spot approval is almost certainly required** — Helix's existing `approveBuilderFee` can be reused, called with the **spot accountID** and `maxFeeRate = WEALTH_MAX_FEE_RATE`.
- **OPEN Q:** confirm whether one approval covers both engines or the spot accountID is needed (expected: separate).

---

## B. Vaults / Stable Earn via ValueChain contracts

These are **on-chain contract interactions signed by the master wallet** (gas in SOSO) — a different path from Helix's off-chain order signing.

### B1. Fund → contract map (to resolve from the Fund Information API + Wealth Contracts page)
Share tokens are known from `GET /wealth/funds`; the **deposit/redeem vault contract** and **underlying token** per fund must be pulled from SoDEX's Fund Information API / Wealth Contracts page (I don't have those addresses yet):

| Fund | fundType | share token (known) | dp | needs: vault contract, underlying, min deposit |
|---|---|---|---|---|
| CXMT | escrow_vault | aCXMT 0x9876…0629 | 18 | ← Fund Information API |
| Unitree | escrow_vault | aUNITREE 0x6753…ecbe | 18 | ← Fund Information API |
| USDC Earn | bridged_vault | vsoUSDC 0xdb40…eefc | 18 | Morpho-backed (api.morpho.org) + bridge |

### B2. Tx sequences
- **Escrow vault deposit:** `ERC20.approve(underlying, vault, assets)` → `vault.requestDeposit(assets, builderFeeData, referral)` → async settlement → `vault.claim()` when shares are mintable.
- **Escrow vault redeem:** `vault.requestRedeem(shares, builderFeeData)` → async settlement → `vault.claim()` to receive the underlying. **The builder fee (up to 2%) is charged here, on redemption.**
- **USDC Earn (bridged_vault):** Morpho-backed via a bridge — deposit USDC → vsoUSDC, redeem vsoUSDC → USDC. **OPEN Q:** confirm whether it uses the same `requestDeposit/requestRedeem` interface or a Morpho/bridge-specific path.
- **Settlement is NOT instant** — the UI must show step state (requested → settling → claimable) from the user's fund history (`claimable`, `delayedPending`), and that gas is paid in SOSO.

### B3. `builderFeeData` packing
Single `uint256`, little-endian bit fields:
```
bits   0–159  builder address (160 bits)
bits 160–175  feeRate       (16 bits, precision 100_000)
bits 176–191  maxFeeRate    (16 bits, precision 100_000, cap 2000)

builderFeeData = (maxFeeRate << 176) | (feeRate << 160) | uint160(WEALTH_BUILDER_ADDRESS)
```
With the config above: `feeRate = 10` (0.01%), `maxFeeRate = 10`, builder = `WEALTH_BUILDER_ADDRESS`.

### B4. `approveBuilder` on BuilderRegistry
- Contract: **`0x638c784760FD1eE465F1bDaF721268ACA24D5A22`**.
- It's an **on-chain, per-user** approval: the master wallet calls `approveBuilder(builder, maxFeeRate)` (signed via `eth_sendTransaction`, gas in SOSO), authorising the builder up to a max rate before any `requestDeposit/requestRedeem` with a `builderFeeData` naming that builder will be honoured.
- **OPEN Q:** confirm the exact function signature + whether it's one approval for all wealth vaults or per-vault.

### B5. Where funds must sit
- Escrow-vault deposits pull the **underlying ERC-20 from the ValueChain wallet** (after `approve`), **not** the SoDEX spot account. So vault investing needs the underlying token in the wallet; if it's in the spot account, a withdraw-to-wallet step is required first. **OPEN Q:** confirm the spot-account ↔ wallet transfer mechanism and whether a bridge step applies.

### B6. Testnet
- End-to-end on **ValueChain testnet (chain 138565)** first: approve → requestDeposit → settle → claim → requestRedeem (with builderFeeData) → claim, verifying the builder fee lands at `WEALTH_BUILDER_ADDRESS`. **OPEN Q:** confirm testnet has the wealth vaults deployed + a faucet.

---

## Open questions to close before building (the gating list)
1. Spot builder fee — buy-side excluded? (high-confidence yes; confirm in SoDEX spot docs).
2. One builder approval for both engines, or a separate **spot** approval (spot accountID)?
3. Vault **contract addresses + ABI** (`requestDeposit`/`requestRedeem`/`claim` signatures) per fund — from the Fund Information API / Wealth Contracts page.
4. **USDC Earn (bridged_vault)** deposit/redeem path — Morpho vault + bridge specifics.
5. `approveBuilder` exact signature; one-time vs per-vault.
6. Per-vault **min deposit** + settlement timing.
7. Whether funds must move **spot account ↔ ValueChain wallet**, and how.
8. **Testnet (138565)** wealth-vault availability + faucet.

## Phased build (each after your OK)
- **Phase A — ETF buy/sell inside Helix.** Invest panel on ETF fund pages (Buy/Sell tabs, amount in USDC or units, est. units/price/fees, min-size check). A **new spot order path, separate from `placeLiveOrder` (perps code untouched)**, with the same per-order error handling + toasts + re-fetch. Spot builder approval (spot accountID). DRY_RUN payloads + byte-identical proof for any shared/perps code; one min-size test by you before enable.
- **Phase B — vault deposit/redeem inside Helix.** Invest panel on vault / Stable Earn pages (Deposit / Redeem / Claim, step list, live status from fund history). On-chain tx path via the master wallet (approve → request → settlement → claim) with `builderFeeData` = `WEALTH_BUILDER_ADDRESS`. Clear copy on non-instant settlement, SOSO gas, and the redemption builder fee. **Testnet end-to-end first**, then a min-size mainnet test by you.

## Rules
- Never send a real transaction or place a real order autonomously — **DRY_RUN / testnet only**; mainnet min-size tests are done by you.
- Perps signing code (`placeLiveOrder`, order/cancel signing) stays untouched; the spot path is additive and separate.
- `tsc` + build green per commit; ship Phase 1 (read-only) now, Phases A/B each wait for your OK.
