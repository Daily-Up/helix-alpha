/**
 * Public trading surface.
 */

export {
  runSignalGen,
  runSignalGenWithAudit,
  type SignalGenSummary,
} from "./signal-generator";

export {
  executeSignal,
  dismissSignal,
  autoExecutePending,
  reconcileOpenPositions,
  type ExecutionResult,
} from "./paper-executor";
