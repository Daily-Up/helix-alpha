/**
 * Agent-backed classifier — drop-in alternative to the Wave 1 single-shot
 * classifier. Runs the research agent on each event sequentially and
 * persists the structured output.
 *
 * The agent path is meaningfully more expensive (~$0.04/event vs
 * ~$0.003/event), so the news ingest caller is expected to cap how many
 * events go through this path per cycle. The remainder fall back to the
 * Wave 1 classifier.
 */

import { Assets, Classifications, Events } from "@/lib/db";
import type { StoredEvent } from "@/lib/db/repos/events";
import type { Asset } from "@/lib/universe";
import { runResearchAgent } from "./research";

export interface AgentClassifyResult {
  results: Array<{ event_id: string; trace_id: string }>;
  errors: Array<{ event_id: string; error: string }>;
  totals: { input: number; output: number; cached: number };
  cost_usd: number;
}

export async function classifyBatchWithAgent(
  events: StoredEvent[],
  opts: { universe: Asset[] },
): Promise<AgentClassifyResult> {
  const results: AgentClassifyResult["results"] = [];
  const errors: AgentClassifyResult["errors"] = [];
  const totals = { input: 0, output: 0, cached: 0 };
  let cost_usd = 0;

  // Project the full universe down to the compact view the agent prompt
  // expects.
  const universeView = opts.universe.map((a) => ({
    id: a.id,
    symbol: a.symbol,
    name: a.name,
    kind: a.kind,
  }));

  for (const event of events) {
    try {
      const r = await runResearchAgent({
        event,
        universe: universeView,
      });
      totals.input += r.tokens.input;
      totals.output += r.tokens.output;
      totals.cached += r.tokens.cached;
      cost_usd += r.cost_usd;

      if (r.error || !r.classification) {
        errors.push({
          event_id: event.id,
          error: r.error ?? "no classification returned",
        });
        continue;
      }

      // Persist the classification and link the affected assets, mirroring
      // what the Wave 1 classifier does after a successful call.
      await Classifications.upsertClassification(r.classification);

      const ids = r.classification.affected_asset_ids ?? [];
      const validIds: string[] = [];
      for (const id of ids) {
        const a = await Assets.getAssetById(id);
        if (a) validIds.push(a.id);
      }
      if (validIds.length > 0) {
        await Events.linkEventAssets(event.id, validIds, "inferred");
      }

      results.push({ event_id: event.id, trace_id: r.trace_id });
    } catch (err) {
      errors.push({
        event_id: event.id,
        error: (err as Error).message ?? String(err),
      });
    }
  }

  return { results, errors, totals, cost_usd };
}

/**
 * Operator-set cap on how many events go through the agent per ingest
 * cycle. Set AGENT_CLASSIFIER_PER_CYCLE to tune. Default 5 — keeps
 * per-cycle cost bounded to ~$0.20 while still demonstrating the agent
 * path on the hottest events.
 */
export function agentClassifierCap(): number {
  const raw = process.env.AGENT_CLASSIFIER_PER_CYCLE;
  if (!raw) return 5;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 5;
}

export function agentClassifierEnabled(): boolean {
  return (
    process.env.AGENT_CLASSIFIER === "1" ||
    process.env.AGENT_CLASSIFIER === "true"
  );
}
