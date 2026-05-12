# Landing-page screenshots

Drop three real screenshots from the running Helix dashboard here:

- `audit.png` — single-signal audit page (`/signal/[id]`). Show full
  reasoning, sources, gate-rule outcomes, corroboration status.
- `events.png` — `/events` live event stream with classifier verdicts.
- `stress.png` — `/index-fund` stress tests tab — historical 60-day
  drawdown windows with v1 vs v2.1 equity curves.

**Resolution:** 2x retina (≥ 2160px wide for full-page captures, ≥ 1080px
for cropped panels). PNG format. Crop tightly to the relevant content —
don't include browser chrome or sidebar nav unless it adds context.

The landing page (`src/app/page.tsx`) renders a placeholder frame when
the file is missing, so it's safe to ship without these and replace them
when ready.
