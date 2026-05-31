/**
 * GET /api/data/signal/{id} — per-signal audit blob. Wave 2: async.
 */

import { NextResponse } from "next/server";
import { Assets, Signals, all, get, AgentTraces } from "@/lib/db";
import {
  getSupersessionForOld,
  listSupersessionsByNew,
  listSuppressionsForConflict,
} from "@/lib/db/repos/conflicts";

const Supersessions = {
  getSupersessionForOld,
  listSupersessionsByNew,
};
const Conflicts = {
  listSuppressionsForConflict,
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DupRow {
  id: string;
  release_time: number;
  title: string;
  author: string | null;
  source_link: string | null;
}

interface ClassRow {
  event_type: string;
  sentiment: string;
  severity: string;
  confidence: number;
  actionable: number | null;
  event_recency: string | null;
  affected_asset_ids: string;
  reasoning: string;
  model: string;
  prompt_version: string;
  classified_at: number;
}

interface ImpactRow {
  impact_pct_1d: number | null;
  impact_pct_3d: number | null;
  impact_pct_7d: number | null;
  computed_at: number;
}

interface EventRow {
  id: string;
  release_time: number;
  title: string;
  content: string | null;
  author: string | null;
  source_link: string | null;
  original_link: string | null;
  category: number;
  is_blue_verified: number;
  duplicate_of: string | null;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const signal = await Signals.getSignal(id);
  if (!signal) {
    return NextResponse.json(
      { ok: false, error: "signal not found" },
      { status: 404 },
    );
  }

  const asset = await Assets.getAssetById(signal.asset_id);

  let event: EventRow | undefined;
  let classification: ClassRow | undefined;
  let duplicates: DupRow[] = [];
  let impact: ImpactRow | undefined;

  if (signal.triggered_by_event_id) {
    event = await get<EventRow>(
      `SELECT id, release_time, title, content, author, source_link,
              original_link, category, is_blue_verified, duplicate_of
       FROM news_events WHERE id = ?`,
      [signal.triggered_by_event_id],
    );

    classification = await get<ClassRow>(
      `SELECT event_type, sentiment, severity, confidence, actionable,
              event_recency, affected_asset_ids, reasoning, model,
              prompt_version, classified_at
       FROM classifications WHERE event_id = ?`,
      [signal.triggered_by_event_id],
    );

    const canonicalId = event?.duplicate_of ?? signal.triggered_by_event_id;
    duplicates = await all<DupRow>(
      `SELECT id, release_time, title, author, source_link
       FROM news_events
       WHERE (id = ? OR duplicate_of = ?)
         AND id != ?
       ORDER BY release_time ASC`,
      [canonicalId, canonicalId, signal.triggered_by_event_id],
    );

    impact = await get<ImpactRow>(
      `SELECT impact_pct_1d, impact_pct_3d, impact_pct_7d, computed_at
       FROM impact_metrics
       WHERE event_id = ? AND asset_id = ?`,
      [signal.triggered_by_event_id, signal.asset_id],
    );
  }

  // Resolve secondary asset symbols for display.
  const secondary = signal.secondary_asset_ids
    ? await Promise.all(
        (JSON.parse(signal.secondary_asset_ids) as string[]).map(
          async (aid) => {
            const a = await Assets.getAssetById(aid);
            return {
              asset_id: aid,
              symbol: a?.symbol ?? aid,
              name: a?.name ?? aid,
              tradable_symbol: a?.tradable?.symbol ?? null,
            };
          },
        ),
      )
    : [];

  const supersededByRow = await Supersessions.getSupersessionForOld(signal.id);
  const supersededOthers = await Supersessions.listSupersessionsByNew(signal.id);
  const suppressionsThisWon = await Conflicts.listSuppressionsForConflict(
    signal.id,
  );

  // Wave 2 — agent trace. Prefer one tagged to this specific signal;
  // fall back to one tagged to the triggering event (the research agent
  // ran during classification, before the signal id existed).
  let agent_trace = await AgentTraces.getTraceForSignal(signal.id);
  if (!agent_trace && signal.triggered_by_event_id) {
    agent_trace = await AgentTraces.getTraceForEvent(
      signal.triggered_by_event_id,
    );
  }

  return NextResponse.json({
    signal: {
      ...signal,
      asset_symbol: asset?.symbol,
      asset_name: asset?.name,
      asset_kind: asset?.kind,
    },
    event,
    classification,
    duplicates,
    impact,
    secondary,
    superseded_by: supersededByRow ?? null,
    superseded_others: supersededOthers,
    suppressed_at_emission: suppressionsThisWon,
    agent_trace: agent_trace ?? null,
  });
}
