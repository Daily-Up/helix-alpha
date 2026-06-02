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

  // Everything below this point can run in parallel. Each call is one
  // Turso round-trip (~80-150ms), and there are ~10 of them; running
  // them sequentially was eating the 15s function budget on cold
  // starts. With Promise.all the whole blob now finishes in ~300ms.
  const eventId = signal.triggered_by_event_id;
  const secondaryIds = signal.secondary_asset_ids
    ? (JSON.parse(signal.secondary_asset_ids) as string[])
    : [];

  const [
    asset,
    event,
    classification,
    impact,
    secondary,
    supersededByRow,
    supersededOthers,
    suppressionsThisWon,
    signalScopedAll,
    eventScopedAll,
  ] = await Promise.all([
    Assets.getAssetById(signal.asset_id),
    eventId
      ? get<EventRow>(
          `SELECT id, release_time, title, content, author, source_link,
                  original_link, category, is_blue_verified, duplicate_of
           FROM news_events WHERE id = ?`,
          [eventId],
        )
      : Promise.resolve(undefined),
    eventId
      ? get<ClassRow>(
          `SELECT event_type, sentiment, severity, confidence, actionable,
                  event_recency, affected_asset_ids, reasoning, model,
                  prompt_version, classified_at
           FROM classifications WHERE event_id = ?`,
          [eventId],
        )
      : Promise.resolve(undefined),
    eventId
      ? get<ImpactRow>(
          `SELECT impact_pct_1d, impact_pct_3d, impact_pct_7d, computed_at
           FROM impact_metrics
           WHERE event_id = ? AND asset_id = ?`,
          [eventId, signal.asset_id],
        )
      : Promise.resolve(undefined),
    Promise.all(
      secondaryIds.map(async (aid) => {
        const a = await Assets.getAssetById(aid);
        return {
          asset_id: aid,
          symbol: a?.symbol ?? aid,
          name: a?.name ?? aid,
          tradable_symbol: a?.tradable?.symbol ?? null,
        };
      }),
    ),
    Supersessions.getSupersessionForOld(signal.id),
    Supersessions.listSupersessionsByNew(signal.id),
    Conflicts.listSuppressionsForConflict(signal.id),
    AgentTraces.listRecentTraces(50),
    eventId
      ? AgentTraces.listTracesForEvent(eventId)
      : Promise.resolve([]),
  ]);

  // Duplicates need the canonical event id which depends on the
  // resolved event row above, so fire it after the parallel block.
  const canonicalId = event?.duplicate_of ?? eventId;
  const duplicates: DupRow[] = canonicalId
    ? await all<DupRow>(
        `SELECT id, release_time, title, author, source_link
         FROM news_events
         WHERE (id = ? OR duplicate_of = ?)
           AND id != ?
         ORDER BY release_time ASC`,
        [canonicalId, canonicalId, eventId ?? ""],
      )
    : [];

  // Dedupe traces server-side so we don't ship a giant JSON blob to
  // the client. Keep only the latest non-stuck run per agent_name.
  const STUCK_AFTER_MS = 5 * 60 * 1000;
  const now = Date.now();
  const allTraces = [
    ...eventScopedAll.filter((r) => !r.signal_id),
    ...signalScopedAll.filter((r) => r.signal_id === signal.id),
  ];
  const latestByAgent = new Map<string, (typeof allTraces)[number]>();
  for (const t of allTraces) {
    if (t.status === "running" && t.started_at < now - STUCK_AFTER_MS) {
      continue; // crashed mid-run — skip
    }
    const prev = latestByAgent.get(t.agent_name);
    if (!prev || t.started_at > prev.started_at) {
      latestByAgent.set(t.agent_name, t);
    }
  }
  const agent_traces = [...latestByAgent.values()];
  const agent_trace = agent_traces[0] ?? null;

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
    agent_traces,
  });
}
