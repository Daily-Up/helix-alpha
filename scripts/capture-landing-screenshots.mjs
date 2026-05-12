#!/usr/bin/env node
/**
 * Capture the three landing-page screenshots from the live deployment
 * at 2x device pixel ratio so dashboard text inside them stays readable
 * when rendered at ~900px wide on /.
 *
 *   audit.png         — /signal/[id] (a pending/REVIEW signal with rich
 *                       reasoning text)
 *   events.png        — /events (live event stream with classifier verdicts)
 *   stress.png        — /index-fund (stress test panel)
 *
 * Viewport 1440x900 @ 2x DPI → saved PNG is 2880x1800. The HTML renders
 * the image at max 1200px wide, so the asset stays crisp on retina.
 */

import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "public", "landing");
const BASE_URL = process.env.SCREENSHOT_BASE_URL ?? "https://helix-alpha-kappa.vercel.app";

mkdirSync(OUT_DIR, { recursive: true });

async function pickSignalId() {
  const res = await fetch(`${BASE_URL}/api/data/signals`);
  const data = await res.json();
  // Prefer a pending/REVIEW tier signal whose reasoning is long enough
  // to show the classifier output and gate decisions.
  const candidates = data.signals.filter(
    (s) =>
      s.status !== "superseded" &&
      s.reasoning &&
      s.reasoning.length > 400 &&
      s.tier !== "info",
  );
  const chosen = candidates[0] ?? data.signals[0];
  return chosen.id;
}

async function capture(page, url, outName, prep) {
  console.log(`→ ${url}`);
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  if (prep) await prep(page);
  // Give CSS animations / data fetches a moment to settle.
  await page.waitForTimeout(2000);
  const buf = await page.screenshot({
    type: "png",
    fullPage: false, // capture only the 1440x900 viewport
  });
  const out = join(OUT_DIR, outName);
  writeFileSync(out, buf);
  console.log(`  saved ${out} (${(buf.length / 1024).toFixed(0)} KB)`);
}

async function main() {
  const signalId = await pickSignalId();
  console.log(`using signal ${signalId}\n`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  // Audit — scroll a bit so the "Reasoning" card is in view if it isn't.
  await capture(
    page,
    `${BASE_URL}/signal/${signalId}`,
    "audit.png",
    async (p) => {
      // No special prep — viewport top-aligned naturally shows the
      // signal header + reasoning + classifier panels.
      await p.evaluate(() => window.scrollTo(0, 0));
    },
  );

  // Event stream — the live ingestion feed. The page renders dozens of
  // recent events with classifier verdicts; the top viewport captures
  // the freshest batch + sidebar context for free.
  await capture(page, `${BASE_URL}/events`, "events.png", async (p) => {
    await p.evaluate(() => window.scrollTo(0, 0));
  });

  // Stress — /index-fund opens on Live portfolio by default. Click the
  // "Stress tests" tab so the historical stress-window table renders.
  await capture(page, `${BASE_URL}/index-fund`, "stress.png", async (p) => {
    await p.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        /stress tests/i.test((b.textContent ?? "").trim()),
      );
      if (btn) (btn).click();
    });
    await p.waitForTimeout(1500);
    await p.evaluate(() => window.scrollTo(0, 0));
  });

  await browser.close();
  console.log("\ndone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
