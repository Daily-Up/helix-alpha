# Wealth Index — in-app investing plan (v2)

**Status: research + plan, now reconciled against the official SoDEX Wealth docs (docs.sodex.com). No investing code written. Phases A/B wait for your OK. Real money gated: research → plan → DRY_RUN → testnet (138565) → your OK → one min-size mainnet test → enable.**

## Fund → rail (corrected)

| Fund(s) | fundType | Rail | Builder fee earned on |
|---|---|---|---|
| vQQQ, vVOO, vVGT, vSCHD, vVYM, **vSMH**, **vSTRC**, **vBOXX** (US Cash Yield) | `clob` | **CLOB spot order book** (API-key signed) | **sells only** |
| CXMT, Unitree | `escrow_vault` | **on-chain vault txs** (master wallet) — channel `subscription` / `rfq` / `batch` | **redeems/sells only** |
| USDC Earn (Morpho-Earn) | `bridged_vault` | **none — link out to SoDEX** | n/a |

**Changes from the first draft (per your corrections, all confirmed in the docs):**
- **USDC Earn removed from the on-chain rail.** Quickstart: *"bridged_vault: The bridge isn't ready, so no action is possible."* Its Invest button stays **"on SoDEX ↗"**.
- **Only `escrow_vault` uses `requestDeposit`/`requestRedeem`.** The Wealth overview says for `clob`: *"Do not call `requestDeposit` / `requestRedeem`."* ETFs trade on the order book only.
- **ETFs do NOT use RFQ.** RFQ (TigrisRFQ) is a route for **escrow vaults** when their channel is `rfq`; the docs never apply it to `clob` funds (quickstart: *"clob, live: Place an order on the order book"*).

---

## Builder config (constants)

```
WEALTH_BUILDER_ADDRESS = <YOUR PAYOUT ADDRESS>   # ⚠ still needed from you
WEALTH_BUILDER_ID      = 8409                     # Helix's existing SoDEX builder id
WEALTH_FEE_RATE        = 10                        # 0.01% (precision 100_000)
WEALTH_MAX_FEE_RATE    = 10                        # standing cap; hard max 2000 (2%)
```
`fee = amount * rate / 100_000`, rounded down. Hard cap **2000 (2%)** on spot and vaults.

---

## A. ETFs via CLOB spot orders  ← **recommended Phase A route**

### Endpoint / payload / signing (from Spot Trading docs)
- `POST {gw}/api/v1/spot/trade/orders/batch` (testnet `https://testnet-gw.sodex.dev`).
- Body: `{ accountID, orders: [{ symbolID, clOrdID, side, type, timeInForce, price, quantity }] }`.
  - `accountID` = spot `data.aid` from `/api/v1/spot/accounts/{addr}/state`.
  - `symbolID` = market id from `/api/v1/spot/markets/symbols` (we already have: vQQQ_vUSDC 41, vVOO 39, vVGT 42, vSCHD 37, vVYM 38, vSMH 40, vSTRC 43, vBOXX 36).
  - `side 1=BUY`, `type 1=LIMIT`, `timeInForce 1=GTC`; `price`/`quantity` decimal strings. (Helix already builds this; MARKET + `funds` for buys is our existing spot path.)
- **Signer = the trading API key** (NOT the master wallet): EIP-712 domain `{name:"spot", version:"1", chainId:138565 (testnet)}`, primaryType `ExchangeAction`, signed payload `{type:"batchNewOrder", params}`, HTTP body = `params`; headers `X-API-Key`, `X-API-Nonce`, `X-API-Sign` (`0x01`-prefixed). **No master-wallet tx, no SOSO gas for the order.**
- **Sizing**: satisfy the market's price / lot-size / notional filters (from `/spot/markets/symbols` — Helix already reads `pricePrecision/stepSize/minQuantity/minNotional`; min notional ≈ $10).

### Funds location
- Spot orders spend the **SoDEX Spot account** (vUSDC) — *"Trading APIs move balances that are already in a Spot or Perps account."* Same place the terminal already trades from. No wallet/bridge step for ETFs.

### Builder fee (from Builder Codes in Trading)
- **Charged on SELLS only**: *"builder codes … do not apply to the buying side of spot trades; they apply to both sides of perp trades."* So Helix earns on ETF **sells**, nothing on buys.
- Attached per order via `"builder": {"id": 8409, "fee": <tenths-bp>}` (must be in the payload **before** the hash) — `placeOrderBatch` already injects the builder type-agnostically.
- **Approval is one call for both engines**: *"Approval succeeds when both engines accept the request."* So **Helix's existing builder approval already covers spot** — likely no new approval needed (confirm via the `spot` array of `GET /user/{addr}/builders`; raise `maxFeeRate` only if we want >0.01%). Max spot fee 2% (2000).

### Why CLOB over RFQ for ETFs
RFQ doesn't apply to `clob`. CLOB also reuses our API-key signing (no master-wallet prompt, no SOSO gas), and draws from the spot account the user already funds. **Recommendation: Phase A = CLOB spot Buy/Sell for the ETFs** (vQQQ, vVOO, vVGT, vSCHD, vVYM, vSMH, vSTRC, vBOXX). Fee capture is on sells.

---

## B. Escrow vaults (CXMT, Unitree) — Phase B

Route depends on the fund's live **channel** (from trading-status): `subscription` (pre-live, use the subscription contract), `rfq` (TigrisRFQ), or `batch` (vault request/claim). Helix must branch on it.

### Vault ABI (batch) — from the Wealth API reference
```solidity
requestDeposit(uint256 assets, address receiver, bytes32 builderFeeData, bytes32 referral)   // approve underlying first; wallet pays SOSO gas
requestRedeem (uint256 shares, address receiver, bytes32 builderFeeData, bytes32 referral)   // no approval; spends shares
claimDeposit(address receiver, uint256 requestId)
claimRedeem (address receiver, uint256 requestId)
claimDelayedRedeem(address receiver, uint256 requestId)
getAsset() / getMinDepositAmount() / getMinRedeemShares() / getUserDepositIds(address) / balanceOf(address)
// relayed (no builder fee): requestDepositOnBehalf(...), requestRedeemOnBehalf(...)
```
- Deposit: `approve(underlying, vault)` → `requestDeposit(...)` → settle → `claimDeposit` if not auto-delivered. `assets ≥ getMinDepositAmount()`.
- Redeem: `requestRedeem(...)` → settle → `claimRedeem` (immediate) / `claimDelayedRedeem` (delayed leg). `shares ≥ getMinRedeemShares()`.
- Status via **User Fund History** (`claimable`, `delayedPending`; "flag omitted = unknown, not false"). Settlement is async/batched — **no schedule published** (open item).

### RFQ ABI (TigrisRFQ) — when channel = `rfq`
```solidity
buy (address vault, uint256 payAmount, uint256 receiveAmount, uint256 deadline, bytes quoteSig[, bytes32 builderFeeData])
sell(address vault, uint256 payAmount, uint256 receiveAmount, uint256 deadline, bytes quoteSig[, bytes32 builderFeeData])
claimBuy/claimSell(address vault, uint256 orderId); claimDelayedBuy/claimDelayedSell(...)
```
- Owner wallet calls directly (`msg.sender == owner`, SOSO gas). 5-arg = no fee; 6-arg adds builderFeeData. **Fee on sells only**: *"A sell claim deducts a builder fee … A buy claim does not."*

### `builderFeeData` + `approveBuilder`
- `builderFeeData` = `bytes32`: bits 0–159 builder addr, 160–175 `feeRate`, 176–191 `maxFeeRate`. `(maxFeeRate<<176)|(feeRate<<160)|uint160(addr)`. `bytes32(0)` = none.
- `BuilderRegistry.approveBuilder(address builder, uint256 maxFeeRate)` — **per user, per builder (not per vault)**, a **standing cap** (`getMaxFeeRate(user,builder)`; `revokeBuilder` clears). **Takes no signature — the user sends it as a tx from their own wallet** (SOSO gas). A non-zero `maxFeeRate` inside `builderFeeData` can also set the cap in the same tx. Fee is **only taken on redeem/sell claims**, paid in the vault underlying (`getAsset()`).

### Funding (answers #4)
- A vault deposit **spends the underlying on the ValueChain wallet (EOA)**, not the spot account.
- **wallet → spot/perps** is documented + automatable: `ClobGateway.depositERC20(token, amount)` at `0x0101…0101` (viem scripts provided; EOA signs, approve ERC-20 first).
- **spot → wallet** (what vault funding needs, since the user's idle USDC sits in the spot account) is **not** on the transfers page — it routes through **Withdrawals** ("To move funds back to EVM … use Withdrawals"). **Open item**: confirm the Withdrawals API and whether Helix can automate spot→wallet, or must hand the user off to SoDEX for that step. This is the Phase B UX fork.

---

## Contract addresses (mainnet)

| Contract | Address |
|---|---|
| BuilderRegistry | `0x638c784760FD1eE465F1bDaF721268ACA24D5A22` |
| TigrisRFQ | `0x4Aa5E39956aCADd68bE0B6720a030Be3C14a6239` |
| ClobGateway (wallet→account) | `0x0101010101010101010101010101010101010101` |
| VaultFactory / MarketFactory | `0x0ec2…54D6` / `0x75ee…16C8` |
| CXMT vault / underlying asset | `0x9876…0629` / `0xcb7f80df…e2c6` |
| Unitree vault / underlying asset | `0x6753…ecbe` / `0xcb7f80df…e2c6` (same underlying) |

Per-fund vault/market/asset/subscription addresses **change per deployment** — load at runtime from `GET /wealth/funds/{id}` → `.data.contracts`. **No npm SDK exists** (raw HTTP + viem; ABI JSON not published inline — pull from the vault ABI / `llms.txt` / `sitemap.md`).

---

## Answers to your 5 questions
1. **USDC Earn (`bridged_vault`)** — ✅ removed from the on-chain rail (bridge not ready); Invest stays link-out.
2. **`requestDeposit/redeem`** — ✅ `escrow_vault` only; `clob` must not call them.
3. **ETF route** — **CLOB spot**, not RFQ (RFQ is vault-only). CLOB: funds from the **spot account**, **API-key** signer, builder via per-order field, **fee on sells**. RFQ (for vaults): funds from the **wallet**, **master-wallet** signer + SOSO gas, 6-arg builderFeeData, fee on sells. **Recommend CLOB for Phase A.**
4. **Vault funding** — vault spends the **wallet** balance. wallet→account is automatable (`ClobGateway.depositERC20`); **account→wallet goes through Withdrawals** (open item — confirm automation vs. SoDEX-UI hand-off).
5. **Contracts/ABIs/SDK** — addresses + vault/RFQ/registry signatures above; **no SDK package**.

## Remaining open items
- a) Confirm Helix's existing builder approval already shows in the `spot` array (so no new spot approval is needed).
- b) Withdrawals API for **spot→wallet** automation (gates Phase B funding UX).
- c) Escrow-vault **settlement timing** + which channel CXMT/Unitree are in right now (subscription vs rfq vs batch).
- d) Full vault **ABI JSON** (return types) — from the ABI file / `sitemap.md`.

## Phase plan (each after your OK)
- **Phase A — ETF Buy/Sell via CLOB spot.** Invest panel (Buy/Sell, USDC or units, est. units/price/exchange+builder fees, min-size check). New spot order path, **separate from `placeLiveOrder` (perps untouched)**, same error handling/toasts/re-fetch. Reuse the existing builder approval (confirm spot array). **DRY_RUN** payloads first; one min-size mainnet test by you before enable. Fee capture on sells.
- **Phase B — vault Deposit/Redeem/Claim (CXMT, Unitree).** Channel-aware (subscription/rfq/batch). On-chain master-wallet txs with `builderFeeData` = `WEALTH_BUILDER_ADDRESS`; `approveBuilder` once. Step UI (approve → request → settle → claim) from User Fund History; copy on async settlement + SOSO gas + the sell-side builder fee. Resolve spot→wallet funding first. **Testnet (138565) end-to-end**, then a min-size mainnet test by you.

## Rules
Never place a real order / send a real tx autonomously (DRY_RUN / testnet only; mainnet min-size tests by you). Perps signing untouched; the spot path is additive. `tsc` + build green per commit.
