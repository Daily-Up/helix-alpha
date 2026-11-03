# Portfolio page redesign — build plan (`portfolio-v2`)

> **Read this file first.** It is the complete brief for rebuilding `/portfolio`,
> modeled on SoDEX's own portfolio page, using the trade terminal's design
> system. It carries the finished API research, the architecture, the Turso
> schema, the file list, the decisions, the order of work, and the original
> spec. You should not need to re-derive any of it.
>
> Branch: `portfolio-v2` (cut from `main`, which already has the terminal
> redesign + logos). Deliver a Vercel preview and the URL. Visual + data only —
> **no changes to signing / order-placement code**, and **never click
> Confirm / Close / Cancel in testing** (DRY_RUN or read-only only).

---

## 1. SoDEX API research — what exists, what doesn't

Base URLs (`src/lib/sodex-onchain/chains.ts`): perps `https://mainnet-gw.sodex.dev/api/v1/perps`, spot `https://mainnet-gw.sodex.dev/api/v1/spot`. All reads are public (no auth). Docs: `https://docs.sodex.com` (perps + spot REST pages under `/for-developers/api-reference/trading-api/rest-v1/`).

**Exists — use these (read-only):**
| Need | Endpoint |
|---|---|
| Perps account state (equity `av`, free margin `am`, positions `P`, aid) | `GET /perps/accounts/{addr}/state` |
| Perps balances (collateral, marginRatio per coin) | `GET /perps/accounts/{addr}/balances` |
| Spot balances (coin, total, locked) | `GET /spot/accounts/{addr}/balances` |
| Spot state (balances compact) | `GET /spot/accounts/{addr}/state` |
| **Fee tier** (`feeTier`, `stakingTier`, `makerRebateTier`, maker/taker rates) | `GET /{perps,spot}/accounts/{addr}/fee-rate` |
| Trade executions (fills) | `GET /{perps,spot}/accounts/{addr}/trades` |
| Order history | `GET /{perps,spot}/accounts/{addr}/orders/history` |
| Open orders | `GET /{perps,spot}/accounts/{addr}/orders` |
| Closed positions | `GET /perps/accounts/{addr}/positions/history` |
| Funding payments | `GET /perps/accounts/{addr}/fundings` |
| Tickers / mark prices (for valuing spot holdings) | `GET /{perps,spot}/markets/tickers`, `/markets/mark-prices` |

Response shapes (confirmed live against `0xEeb813d8C68CdC2Dfcecc3c7ECa71f17c830902d`):
- `fee-rate` → `{data:{makerFeeRate, takerFeeRate, feeTier:0, stakingTier:1, makerRebateTier:0}}` — **no 30d-volume field.**
- spot `balances` → `{data:{balances:[{id, coin:"vUSDC", total, locked}]}}` — **no avg price / uPnL per holding** (spot is plain holdings; value = total × spot price; avg-cost/uPnL would have to be reconstructed from spot `/trades` — show "—" in v1 unless cheap).
- perps `balances` → `{data:{balances:[{coin, total, collateral, marginRatio, price, borrowed}]}}`. Perps equity is the `av` field on perps `/state` (already used by the terminal's `AccountPanel`); free collateral = `am`.

**Does NOT exist (decisions below):**
- **Equity / PnL history over time** — no endpoint. → Turso snapshots (§4, §5).
- **30-day trading volume** — no endpoint. → compute from `/trades` (sum `executedValue` of fills in the last 30 days, perps + spot separately and combined).
- **Swap history** — no separate concept. → map the "Swap History" sub-tab to spot trade history.
- **Transfers history** — not in the trading REST API (`POST /accounts/transfers` only submits; no list). The Wealth API (`/for-developers/api-reference/wealth-api/user-fund-history.md`) and Mirror API (`/mirror-api/history-and-status.md`) may expose it — check once; if there is no clean read, the Transfers sub-tab shows an **empty state**, never fabricated rows.

---

## 2. Decisions (confirmed with the user)

1. **Equity history → Turso snapshots.** No SoDEX endpoint, so snapshot current equity per connected address and build the curve from that. Show **"History starts <date>"** until enough points exist. (Pre-approved.)
2. **Snapshot cadence → NOT a 15-min Vercel cron.** `vercel.json` shows daily crons (`0 12 * * *`, `30 2 * * *`) = **Vercel Hobby, which only allows daily crons.** So record a snapshot **on page visit** and piggy-back the terminal's existing 5s account poll, **throttled to at most one write per 15 min per address** (check the latest snapshot's `ts` before inserting). Optionally also add a **daily** cron as a backstop (that frequency *is* allowed). Document whichever you ship.
3. **30d volume** computed from `/trades`.
4. **Swap history** = spot trades; **Transfers** = empty state unless a clean Wealth/Mirror read is found.
5. **Spot avg price / uPnL** → "—" in v1 (no per-holding cost basis from SoDEX); optionally reconstruct from spot `/trades` later.
6. Remove the current record-trade DB list entirely (`LiveOrdersPanel` / `LivePositionsPanel`, built from `/api/sodex/record-trade`, every row stuck on "SUBMITTED"). Order/trade data comes only from SoDEX history endpoints.

---

## 3. Design system — reuse, don't reinvent

Everything matches the trade terminal (now on `main`):
- Wrap the page in a `.trade-terminal` scope (or reuse those tokens) so `--surface/--surface-2/--line/--fg*/--positive/--negative/--accent-trade` + Inter + JetBrains-Mono apply. Tokens live in `src/app/terminal-tokens.css`.
- **Logos**: `AssetLogo` from `@/components/ui/AssetLogo` (handles crypto + stocks + monogram; already covers these markets).
- **Number formatting**: trimmed prices (per-symbol tick, trailing zeros trimmed), dollars always 2-dec, `-PERP` naming via `fmtSodexSymbol(...).replace(/-USDC?$/i,"-PERP")`. Match `src/components/trade/BottomPanel.tsx` / `OrderPanel.tsx` helpers.
- **Charts**: `lightweight-charts` (already a dep; see `src/components/trade/PriceChart.tsx` for options, autoscale, crosshair, token colors `#0ecb81`/`#f6465d`).
- **Account math**: `AccountPanel.tsx` shows the equity/available/margin-ratio derivation + the green→amber→red ratio colour — reuse that logic.
- **Segmented controls / tabs / stat styling**: copy the patterns from the terminal (Buy/Sell segmented pill, Market/Limit underline, bottom-panel tab underline using `--accent-trade`).

---

## 4. Architecture

**Data layer (server, read-only SoDEX + Turso):**
- `src/app/api/portfolio/equity-snapshot/route.ts`
  - `POST {address}` → fetch perps `/state` (`av`) + spot balances + spot/perps tickers, compute `perps_equity`, `spot_equity`, `total_equity`, `perps_upnl`; **insert only if** the newest row for that address is >15 min old (throttle). Returns the current computed values too.
  - `GET ?address=&range=1D|1W|1M|all` → snapshot series for the chart.
- `src/lib/portfolio/fetch.ts` — shared fetchers/derivations used by the route and (where client-side) the page: spot balances + value, fee-rate, 30d volume from `/trades`, Helix-strip stats (filter trade `clOrdID` starting `helix-`: total volume, fill count, builder fees), equity composition.
- (Optional) `src/app/api/cron/equity-snapshots/route.ts` — **daily** backstop snapshot for recently-active addresses; add its `path` to `vercel.json` `crons` at a daily schedule only.

**DB:**
- `src/lib/db/schema.sql` — append the `equity_snapshots` table (§5).
- `src/lib/db/repos/equity-snapshots.ts` — `insert(row)`, `latest(address)`, `series(address, sinceMs)`. Use the `run` / `all` / `get` helpers from `@/lib/db`.
- `src/lib/db/index.ts` — export the new repo (`export * as EquitySnapshots from "./repos/equity-snapshots"`).

**Shared trade-actions hook (commit (e), see §6):**
- `src/lib/sodex-onchain/useSodexTradeActions.ts` — extract from `TradeTerminal.tsx` (lines ~150–860): `bumpHistory`, `refreshAccount`, `refreshOpenOrders`, `onCancelOrders`, `markBySymbol`, `onClosePosition`, `onCloseAll`, `verifyOrderGone`, `onSetTpSl`, `onRemoveTrigger`, and the assembled `tpslCtx`. Inputs: `account`, `symbolMeta`, `tm`, `connectedMaster`, `showToast`, selected-market mid/last. Output: everything `BottomPanel`'s `tpsl` ctx + close/cancel props need. `TradeTerminal` then consumes the hook (behaviour identical); the Perps tab consumes the same hook.

**Page / components (`src/components/portfolio/`):**
- `PortfolioDashboard.tsx` — rewrite. Connect-prompt when no key; otherwise the full layout.
- `EquityChart.tsx` — portfolio (Perps/Spot/Total) + metric (Equity/PnL) dropdowns, big current value + range change ($/%, green/red arrow), 1D/1W/1M/All toggle, area series (line coloured by sign, gradient fill, right price axis, crosshair). "History starts <date>" overlay when sparse.
- `OverviewCard.tsx` — "Overview" + margin-usage ring gauge (SVG, green→amber→red), "You have N positions open using X% of your collateral", Deposit / Perps ⇄ Spot / Withdraw buttons (open the matching SoDEX pages in a new tab — we never move funds), colored-dot stat list (Free Collateral, Perp Positions value, Spot Holdings value), fee-tier card (tier + 30d volume + "View fee tiers →").
- `SpotTab.tsx` — 4 stat cards (Total Spot Equity, 30d Spot Volume, 30d Realized Spot PnL, Current Spot PnL) + sub-tabs Balances | Swap History | Transfers + "Hide dust (<$1)" toggle + balances table (Asset logo+ticker | Total | Settled/Unsettled | Avg Price | Value (sortable) | uPnL).
- `PerpsTab.tsx` — 4 stat cards (Perps Equity, 30d Perps Volume, 30d Realized PnL, Unrealized PnL) + **reuse `BottomPanel`** via the shared hook (Positions | Open Orders | Trade History | Order History | Closed Positions | Funding — same columns, same TP/SL + Close modals).
- `HelixStrip.tsx` — "Traded via Helix" muted card: total volume, fills, builder fees for 1D/1W/All (from `helix-` clOrdID trades).
- `StatCard.tsx`, `SegmentedTabs.tsx`, `RingGauge.tsx` — small shared bits.
- `src/app/portfolio/page.tsx` — pass `symbolMeta` the same way `src/app/trade/page.tsx` does (needed for the Perps tab + formatting).

**Remove:** `PortfolioDashboard`'s use of `LivePositionsPanel` + `LiveOrdersPanel`; delete those two files and the `record-trade` read path if nothing else uses them (grep first).

---

## 5. Turso schema (append to `src/lib/db/schema.sql`)

```sql
CREATE TABLE IF NOT EXISTS equity_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  address       TEXT    NOT NULL,            -- lowercase 0x master/account address
  ts            INTEGER NOT NULL,            -- unix ms
  perps_equity  REAL    NOT NULL,            -- USD
  spot_equity   REAL    NOT NULL,            -- USD
  total_equity  REAL    NOT NULL,            -- USD
  perps_upnl    REAL,                        -- USD, nullable
  spot_upnl     REAL                         -- USD, nullable (if reconstructed)
);
CREATE INDEX IF NOT EXISTS idx_equity_snap_addr_ts ON equity_snapshots(address, ts);
```

Throttle: before inserting, `latest(address)`; skip if `now - latest.ts < 15*60*1000`.

---

## 6. Order of work (commits)

Push after (d) so the user can review before the refactor.

- **(a) Data layer + equity snapshots** — schema, repo, `equity-snapshot` route (+ optional daily cron), `lib/portfolio/fetch.ts`. tsc+build.
- **(b) Overview card + equity chart** — `OverviewCard`, `EquityChart`, and the new `PortfolioDashboard` shell wiring them + the SoDEX fetches. Remove the record-trade panels here.
- **(c) Spot tab** — stat cards, balances table, sub-tabs, hide-dust.
- **(d) Helix strip** — then **push a preview** and share the URL.
- **(e) Trade-actions hook extraction** — its **own commit**. Extract `useSodexTradeActions`, refactor `TradeTerminal` to use it. **Safety gate (below) must pass before (f).**
- **(f) Perps tab** — `PerpsTab` using the hook + `BottomPanel`.

## 7. Hook-extraction safety (before (f))

The terminal must behave **identically** after (e):
- `tsc` + production build green.
- On `/trade`: the TP/SL modal, the Close modal, the per-row Cancel (×) + popover, and Close All still open and wire correctly (render-only; **never click Confirm/Close/Cancel**).
- **Prove the signed payloads are unchanged**: run the existing DRY_RUN approach (`NEXT_PUBLIC_SODEX_DRY_RUN=1`, `NODE_ENV!=production`) for a MARKET close, a reduce-only close, and a TP/SL trigger **before and after** the refactor and diff the logged `body` + field order — they must be byte-identical. The hook only relocates the handlers; it must not change construction or signing.

## 8. Rules (restate in every commit)
- No changes to signing / order-placement / builder-fee code; the hook extraction only relocates existing handlers.
- Never click Confirm / Close / Cancel in testing.
- tsc + production build green before every push.
- Screenshots at 1920 and 1440; push to `portfolio-v2`; give the preview URL.

---

## 9. Original spec (verbatim)

Redesign the Portfolio page, layout modeled on SoDEX's own portfolio page. Do it on a branch `portfolio-v2` with a Vercel preview. Use the same design tokens, fonts, AssetLogo, number formatting (trimmed prices, 2-dec dollars, -PERP naming) and components as the trade terminal.

### Data rules
- Everything comes from SoDEX endpoints (perps + spot REST), read-only, no new signing.
- Remove the current "Your live orders" list built from our record-trade DB (every row stuck on "SUBMITTED"). Order and trade data comes from SoDEX's orders/history and trades endpoints.
- Check the SoDEX docs (docs.sodex.com, REST perps + spot APIs, llms.txt index) for: account equity/PnL history, spot balances, transfers history, swap history, fee tier, 30d volume. Report which exist before building, and use them.

### Layout
**Top: equity chart (left, ~70%)** — Dropdowns: "Perpetuals / Spot / Total" portfolio + "Equity / PnL" metric. Big number: current value (e.g. $724.50), and below it the change for the selected range in $ and %, green/red with an arrow. Range toggle: 1D / 1W / 1M / All. Area chart: line in long/short color by sign of the change, soft gradient fill, right-side price axis, time axis, crosshair tooltip. If SoDEX has no equity-history endpoint: record an equity snapshot every 15 min into our DB (Turso) per connected address (cron or on page visit), and show "History starts <date>" until there's data. Tell me which approach you used.

**Top: Overview card (right, ~30%)** — Title "Overview" + a ring gauge of margin usage (% of collateral used), green → amber → red. Line: "You have N positions open using X% of your collateral." Buttons: Deposit, Perps ⇄ Spot, Withdraw. These open the corresponding SoDEX pages in a new tab (we don't move funds from Helix). Stacked stat list with colored dots: Free Collateral, Perpetual Positions value, Spot Holdings value. Fee tier card (tier + 30d volume) if the endpoint exists, with a "View fee tiers →" link to SoDEX.

**Below: Spot | Perpetuals tabs (segmented control)**
Spot tab: 4 stat cards: Total Spot Equity, 30d Spot Volume, 30d Realized Spot PnL, Current Spot PnL. Sub-tabs: Balances | Swap History | Transfers, plus a "Hide dust" toggle (< $1). Balances table: Asset (logo + ticker) | Total | Settled / Unsettled | Avg Price | Value (sortable) | uPnL.
Perpetuals tab: 4 stat cards: Perps Equity, 30d Perps Volume, 30d Realized PnL, Unrealized PnL. Sub-tabs: Positions | Open Orders | Trade History | Order History | Closed Positions | Funding. Reuse the terminal's bottom-panel components (same columns, same TP/SL and Close modals), not new copies.

**"Traded via Helix" strip (bottom)** — Using the clOrdID prefix "helix-" on SoDEX trade history: total volume traded through Helix, number of fills, and builder fees paid, for 1D/1W/All. Small, muted card.

### Rules
- No changes to signing/order code.
- Never click Confirm/Close/Cancel in testing.
- tsc + build green, screenshots at 1920 and 1440, push to portfolio-v2 and give me the preview URL.
