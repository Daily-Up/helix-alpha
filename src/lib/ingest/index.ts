/**
 * Public ingest pipelines.
 *
 * Each exported function is idempotent and safe to call from any of:
 *   • CLI scripts (npm run ingest:news)
 *   • Cron API routes (/api/cron/ingest-news)
 *   • The dashboard's "Run Now" button
 */

export {
  runNewsIngest,
  runNewsIngestWithAudit,
  type NewsIngestSummary,
  type NewsIngestOptions,
} from "./news";

export {
  runKlinesIngest,
  runKlinesIngestWithAudit,
  type KlinesIngestSummary,
  type KlinesIngestOptions,
} from "./klines";

export {
  runETFIngest,
  runETFIngestWithAudit,
  type ETFIngestSummary,
  type ETFIngestOptions,
} from "./etfs";

export {
  runSectorsSnapshot,
  runSectorsSnapshotWithAudit,
  type SectorsIngestSummary,
} from "./sectors";

export {
  runTreasuriesIngest,
  runTreasuriesIngestWithAudit,
  type TreasuriesIngestSummary,
  type TreasuriesIngestOptions,
} from "./treasuries";

export {
  runMacroIngest,
  runMacroIngestWithAudit,
  type MacroIngestSummary,
  type MacroIngestOptions,
} from "./macro";
