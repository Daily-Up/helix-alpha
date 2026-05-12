# Landing-page screenshots

Drop three real screenshots from the running Helix dashboard here:

- `audit.png` — single-signal audit page (`/signal/[id]`). Show conviction
  breakdown, sources, gate-rule outcomes, corroboration status.
- `calibration.png` — `/calibration` with the framework toggle on
  Compare. Show v1 vs v2.1 hit rate / PnL / sample-size.
- `stress.png` — `/alphaindex` v2 (preview) tab, scrolled to the stress
  windows table showing the 8 historical 60-day windows with the −35%
  bear cell visible.

**Resolution:** 2x retina (≥ 2160px wide for full-page captures, ≥ 1080px
for cropped panels). PNG format. Crop tightly to the relevant content —
don't include browser chrome or sidebar nav unless it adds context.

The landing page (`src/app/page.tsx`) renders a placeholder frame when
the file is missing, so it's safe to ship without these and replace them
when ready.
