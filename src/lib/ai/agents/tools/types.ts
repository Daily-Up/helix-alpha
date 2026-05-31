/**
 * Shared types for agent tools.
 *
 * Each tool is a pair: an Anthropic tool descriptor (sent to Claude so it
 * knows what's available) plus a `handle()` function the agent loop calls
 * when Claude requests it. Tools are pure functions — they don't mutate
 * agent state; the loop is responsible for recording the trace.
 */

import type Anthropic from "@anthropic-ai/sdk";

export interface AgentTool<Input = unknown, Output = unknown> {
  /** Anthropic-format tool descriptor sent in the `tools` array. */
  spec: Anthropic.Tool;
  /** Execute the tool. Throws on failure — the agent loop catches and
   *  records the error as part of the trace. */
  handle: (input: Input) => Promise<Output>;
}
