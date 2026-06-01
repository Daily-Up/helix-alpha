/**
 * Public database surface.
 *
 * Import from "@/lib/db" — never reach into individual repos. Keeps the
 * connection lifecycle and table names encapsulated.
 */

export {
  db,
  getClient,
  closeDb,
  transaction,
  batch,
  bootstrapSchema,
  all,
  get,
  run,
  _setClientForTests,
} from "./client";

export * as Assets from "./repos/assets";
export * as Events from "./repos/events";
export * as Classifications from "./repos/classifications";
export * as Klines from "./repos/klines";
export * as ETFFlows from "./repos/etf-flows";
export * as Sectors from "./repos/sectors";
export * as Macro from "./repos/macro";
export * as Impact from "./repos/impact";
export * as Cron from "./repos/cron";
export * as Settings from "./repos/settings";
export * as Signals from "./repos/signals";
export * as PaperTrades from "./repos/paper-trades";
export * as IndexFund from "./repos/index-fund";
export * as Postmortem from "./repos/postmortem";
export * as Briefings from "./repos/briefings";
export * as Treasuries from "./repos/treasuries";
export * as Outcomes from "./repos/outcomes";
export * as Alerts from "./repos/alerts";
export * as ShadowPortfolio from "./repos/shadow-portfolio";
export * as AgentTraces from "./repos/agent-traces";
export type { AgentStep, AgentTraceRow } from "./repos/agent-traces";
export * as FrameworkSwitches from "./repos/framework-switches";
export * as ExecutedTrades from "./repos/executed-trades";
export type {
  ExecutedTradeRow,
  TradeStatus as ExecutedTradeStatus,
} from "./repos/executed-trades";

// Re-export commonly-needed enum values + types so call sites don't need a
// second import.
export {
  EventTypes,
  Sentiments,
  Severities,
  EventRecencies,
  type EventType,
  type Sentiment,
  type Severity,
  type EventRecency,
  type Classification,
} from "./repos/classifications";

export type {
  SignalRow,
  SignalTier,
  SignalStatus,
  SignalDirection,
  NewSignal,
} from "./repos/signals";

export type {
  PaperTradeRow,
  TradeDirection,
  TradeStatus,
  ExitReason,
  NewPaperTrade,
  PortfolioStats,
} from "./repos/paper-trades";

export type { SettingsSnapshot } from "./repos/settings";

export type {
  IndexRow,
  IndexPositionRow,
  IndexRebalanceRow,
  IndexNavRow,
} from "./repos/index-fund";

export type {
  BriefingRow,
  BriefingInputsSummary,
  Regime,
  TopPick,
  WatchlistEntry,
} from "./repos/briefings";
