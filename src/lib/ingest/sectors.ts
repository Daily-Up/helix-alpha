/**
 * Sector spotlight ingest — snapshots /currencies/sector-spotlight to the
 * sector_snapshots table. Run on a 5-min or hourly cron so we accumulate
 * a time series for the narrative-cycle clock.
 */

import { Cron, Sectors } from "@/lib/db";
import { Sector } from "@/lib/sosovalue";

export interface SectorsIngestSummary {
  sectors_recorded: number;
  latency_ms: number;
}

export async function runSectorsSnapshot(): Promise<SectorsIngestSummary> {
  const t0 = Date.now();
  const data = await Sector.getSectorSpotlight();
  const sectors = data.sector ?? [];
  Sectors.snapshotSectors(t0, sectors);
  return { sectors_recorded: sectors.length, latency_ms: Date.now() - t0 };
}

export async function runSectorsSnapshotWithAudit(): Promise<
  SectorsIngestSummary & { run_id: number }
> {
  const { id, data } = await Cron.recordRun("snapshot_sectors", async () => {
    const summary = await runSectorsSnapshot();
    return {
      summary: `sectors=${summary.sectors_recorded}`,
      data: summary,
    };
  });
  return { ...(data as SectorsIngestSummary), run_id: id };
}
