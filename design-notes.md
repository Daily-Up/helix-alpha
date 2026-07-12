# Interface system — design notes

Read this before adding a screen or a table. It exists so the next screen
isn't built wrong.

## Root cause it fixes
Helix rendered the *shape of the API response*: every field became a column,
every column got equal width, every number got full precision, nothing was
ranked. That is density without encoding — noise. A newsroom's core skill is
deciding what the lead is; these screens hadn't.

## The primitives (src/components/ui/) — use them, don't hand-roll

| Primitive | Contract |
|---|---|
| `<Num>` | The ONE number. Precision by **magnitude class** (≥1e9→2dp B, ≥1e6→1dp M, ≥1e3→thousands-sep, 1–1000→2dp, <1→≤4 sig-dp). Always `tabular-nums`. Full precision on hover (`title`). Zero recedes. Tiers: `lead` / `secondary` / `context`. `tone="auto"` colours by sign. |
| `<Magnitude>` | A numeric cell with an inline bar behind it scaled to the **column max** — the reader *sees* the ratio. `tone="auto"` = diverging (green up / red down). This is the most important one. |
| `<Empty>` | The ONE "nothing" glyph (`—`), ~40% opacity. Never `$0.00` here and `—` there. |
| `<Addr>` | ONE address format `0x1234…5678`, click-to-copy the full value. Zero local `slice()` variants. |
| `<Timestamp>` | ONE format, absolute + relative (SSR-safe). |
| `<Action>` | Refuses to render when `enabled` is false. No withdraw on an empty balance. |
| `<DataTable>` | Columns declare a **role** — `lead` / `magnitude` / `context` / `identifier` / `action`. Width, weight, alignment derive from the role, never from the field list. Computes the per-magnitude-column max for bar scaling. |

The number policy lives in `src/lib/format/num.ts` (`formatNum`) so it's pure and
testable. Never re-implement it in a component.

## The rules (apply forever)
1. **Rank every group** — one lead per screen, one lead per section. Two numbers at the same size claims they matter equally; usually a lie.
2. **Encode magnitude, don't print it** — order-of-magnitude spread → `<Magnitude>` bar, not a wall of digits to compare by eye.
3. **Zero and null recede** — `<Num>` mutes zero; `<Empty>` is 40% opacity.
4. **No badges compensating for hierarchy** — if you need a "▲ TOP" badge to mark the biggest row, the design failed. The biggest row should *look* biggest (the bar does this).
5. **Precision is a design decision** — magnitude class, not API passthrough. Full precision on hover only.
6. **Never render an impossible action** — `<Action enabled={…}>`.
7. **Every screen answers its first question, in words, at the top.**
8. **One format per data type, app-wide** — one address, one timestamp, one empty glyph, one precision policy.

## Migration log
- **HoldingsTable** (/index-fund) — 11 flat columns → 6 role-based (Asset · Weight · Drift · Value · P&L · Why). Weight/Drift/P&L now encode magnitude; Target/Quantity/Avg-Entry/Last-Px/Mkt-column folded. *This was the worst table — the template.*
- **SodexBalancesTable** (/settings/connect-sodex) — `<Num>` (killed `289.821858`→`289.82`), `<Action>` gates: no Withdraw with 0 available, no Transfer on a 0 balance.
- **FundLeaderboard** (/etfs) — `<DataTable>` with a **diverging** Daily-Inflow bar; retired the ▲/▼ top-inflow/outflow badges (rule 4).
- **PortfolioDashboard** (/portfolio) — open + closed tables → `<DataTable>`. P&L encoded as a magnitude bar (green up / red down); Side folded into the Asset cell; Stop/Target dropped; Close gated by `isPublicMode()`; `<Timestamp>` for age/closed.
- **Signal performance** (/signals/performance) — by-tier, by-subtype, and receipts "Avg realized / Realized" columns now carry a proportional bar scaled to the column max. Rendered in the page's **editorial idiom** (inline `MagBar`, Fraunces/hairlines kept) — encoding without a re-skin.
- **TreasuriesDashboard** (/treasuries) — Top-holders table → `<DataTable>` with **BTC-held** as a magnitude bar, so MSTR's dominance reads as length. `#` rank kept as context.
- **Magnitude bar visibility** — bumped from ~15–20% → **45%** opacity, left-anchored proportion fill; `<DataTable>` rows given breathing room (taller, wider padding, row hover). The bars were technically present before but invisible; this is the change that made the pass *look* like a change.

### Still on the API-shape default (next passes, same recipe)
SignalCard trade figures (lead = conviction), macro/sectors returns tables
(heterogeneous units — encode per-column or leave as coloured numbers), the
treasuries *recent-purchases* table, and the equal-weight stat rows where a single
lead is defensible. Note: several stat rows (home "Live snapshot", events StatsBar)
are genuinely co-equal KPIs — forcing a hero there would be arbitrary, so they stay
flat by design. Ops/stub screens (/agents, /jobs, /system-health, /patterns,
/learnings, /calibration) are gated internal — migrate last.

## Make it stick
`tests/ui-primitives-guard.test.ts` is a **ratchet**: it counts raw `.toFixed()`,
`toLocaleString()`, and local address-slices in `src/components`+`src/app`
(excluding `components/ui/`) and fails CI if any count **increases** past the
baseline. Existing debt is tolerated; new violations are blocked. When you migrate
a file, lower the baseline in that test — it only ratchets down.

## Do not touch
Palette (it's good), charts, data fetching, scoring, AlphaIndex framework, API routes.
