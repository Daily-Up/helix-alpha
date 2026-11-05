# Performance backlog (post-race)

Parked performance ideas — out of scope for the buildathon but worth revisiting.
Nothing here is committed work; each needs its own pass + testing.

## /trade — current state (2026-11-05)

Batch-2 perf pass shipped: lazy-load the chart + both modals + BottomPanel +
SetupCard; `React.memo` on the heavy panels (PriceChart / OrderBook / OrderPanel
/ AccountPanel) with stable `useCallback` handlers; reserved header-stat widths
so `—`→value never reflows.

Lighthouse **mobile** preset (4× CPU throttle):

| Metric | Before | After |
|---|---|---|
| Performance | 54 | 76 |
| CLS | 0.205 | **0.001** (target < 0.1 — met) |
| Total Blocking Time | 2,530 ms | ~815 ms (−68%) |

CLS is solved. Performance plateaus at 76 on the mobile preset; the dominant
remaining main-thread cost is the app-wide wallet bundle, not the terminal.
Helix is desktop-only — see the desktop numbers at the bottom.

## Idea: injected-only connect modal (replace RainbowKit)

**Why.** The biggest remaining Lighthouse main-thread cost on /trade (and every
page) is the vendor chunk = wagmi + viem + **RainbowKit** (~2 s of script
evaluation under mobile throttle). RainbowKit loads app-wide via
[`Web3Provider`](../src/components/providers/Web3Provider.tsx).

**The opening.** Helix registers **only** the `injected()` connector — no
WalletConnect/Reown (deliberately removed; see the CSP note in `next.config.ts`).
RainbowKit's only job here is the wallet-picker + account modal. With injected
wallets only, that can be a small custom component driven by wagmi directly:

- `useConnectors()` / `useConnect()` — list the EIP-6963-discovered injected
  wallets (name + icon) and connect to the chosen one.
- `useAccount()` / `useDisconnect()` — account state + disconnect.
- Drop `@rainbow-me/rainbowkit` (+ its stylesheet) entirely.

**Scope / risk.**

- App-wide change to the connect UX on *every* page, not just /trade. The
  connect/sign flow is security-sensitive (real funds on prod) — test wallet
  connect, `addAPIKey` signing, and disconnect on each surface before shipping.
- Touch points: `Web3Provider` (remove `RainbowKitProvider`), the
  `ConnectButton.Custom` usage in `SignalsConnectPanel`, the SodexAuth setup
  modal, and any `openConnectModal` / `openAccountModal` callers.
- Payoff is **uncertain**: viem + wagmi stay heavy, so this may not alone clear
  Performance 85 on the mobile preset. The real value is bundle size + load
  time; on desktop (below) the score is already strong.

**Status:** parked (post-race). Decided 2026-11-05 to leave RainbowKit as-is.

## /trade — desktop preset (Helix is desktop-only)

Lighthouse `--preset=desktop` (no 4× CPU throttle), post batch-2:

| Metric | Run 1 | Run 2 |
|---|---|---|
| Performance | **89** | **95** |
| Total Blocking Time | 190 ms | 160 ms |
| CLS | 0.009 | 0.009 |
| LCP | 1.0 s | 1.0 s |
| Speed Index | 2.2 s | 1.2 s |

On the desktop preset — the environment Helix actually targets — /trade clears
the **Perf ≥ 85** goal (89–95) with TBT ~160–190 ms and CLS ~0.009. The mobile
score (76) reflects the 4× CPU throttle, which doesn't model a desktop user, so
no further perf work is planned.
