/**
 * Public AI surface.
 */

export { anthropic, getModel } from "./client";
export {
  classifyEvent,
  classifyBatch,
  type ClassificationResult,
} from "./classifier";
export { CLASSIFY_PROMPT_VERSION } from "./prompts/classify";
export { runBriefing, gatherBriefingInputs } from "./briefing";
export { BRIEFING_PROMPT_VERSION } from "./prompts/briefing";
