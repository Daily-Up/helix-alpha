/**
 * POST /api/events/hero-image  { eventId, query }
 *
 * Returns a cached Unsplash hero photo for an event, fetching + caching it on
 * first request. Follows Unsplash's API guidelines: we HOTLINK their image URL
 * (never rehost, never use the news source's own article image), return the
 * "Photo by X on Unsplash" attribution for the card, and trigger their download
 * endpoint the first time a photo is used. Each event is searched ONCE — the
 * result (image or a negative marker) is cached in event_images — so we stay
 * well within the demo-tier rate limit.
 *
 * The Unsplash access key lives only on the server (UNSPLASH_ACCESS_KEY); the
 * browser never sees it. With no key configured the route returns null and the
 * hero falls back to its chart-only layout.
 */

import { NextResponse } from "next/server";
import { get, run } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNSPLASH_API = "https://api.unsplash.com";

interface Body {
  eventId?: string;
  query?: string;
}
interface CacheRow {
  image_url: string | null;
  photographer: string | null;
  photographer_url: string | null;
}
interface HeroImage {
  url: string;
  photographer: string;
  photographer_url: string;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const eventId = typeof body.eventId === "string" ? body.eventId : "";
  const query =
    typeof body.query === "string" ? body.query.trim().slice(0, 120) : "";
  if (!eventId) {
    return NextResponse.json({ error: "eventId required" }, { status: 400 });
  }

  // 1. Cache hit (positive OR negative) → serve it with no API call.
  const cached = await get<CacheRow>(
    "SELECT image_url, photographer, photographer_url FROM event_images WHERE event_id = ?",
    [eventId],
  ).catch(() => undefined);
  if (cached) {
    return NextResponse.json({ image: toImage(cached) });
  }

  const key = process.env.UNSPLASH_ACCESS_KEY;
  // No key yet, or nothing to search → don't cache, so it works once a key is
  // configured (and a better query can still win later).
  if (!key || !query) {
    return NextResponse.json({ image: null });
  }

  // 2. Search Unsplash — one landscape result, safe content only.
  let image: HeroImage | null = null;
  let unsplashId: string | null = null;
  let downloadLocation: string | null = null;
  try {
    const url =
      `${UNSPLASH_API}/search/photos?query=${encodeURIComponent(query)}` +
      `&orientation=landscape&per_page=1&content_filter=high`;
    const res = await fetch(url, {
      headers: { Authorization: `Client-ID ${key}`, "Accept-Version": "v1" },
    });
    // API error (429 rate-limit, 5xx) → DON'T cache; a later request retries.
    if (!res.ok) return NextResponse.json({ image: null });

    const data = (await res.json()) as {
      results?: Array<{
        id: string;
        urls?: { regular?: string };
        user?: { name?: string; links?: { html?: string } };
        links?: { download_location?: string };
      }>;
    };
    const photo = data.results?.[0];
    if (photo?.urls?.regular) {
      unsplashId = photo.id;
      downloadLocation = photo.links?.download_location ?? null;
      const name = photo.user?.name ?? "Unsplash";
      const profile = photo.user?.links?.html ?? "https://unsplash.com";
      image = {
        url: photo.urls.regular,
        photographer: name,
        photographer_url: `${profile}?utm_source=helix&utm_medium=referral`,
      };
    }
  } catch {
    // Network error → don't cache; retry later.
    return NextResponse.json({ image: null });
  }

  // 3. Trigger the download endpoint on first use (Unsplash guideline).
  if (downloadLocation) {
    try {
      await fetch(downloadLocation, {
        headers: { Authorization: `Client-ID ${key}` },
      });
    } catch {
      /* best-effort — the hotlink + attribution are what matter */
    }
  }

  // 4. Cache the outcome. A successful 0-result search is cached as a NEGATIVE
  //    row (NULL image_url) so we never re-query that event.
  try {
    await run(
      `INSERT INTO event_images
         (event_id, unsplash_id, image_url, photographer, photographer_url, query)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO NOTHING`,
      [
        eventId,
        unsplashId,
        image?.url ?? null,
        image?.photographer ?? null,
        image?.photographer_url ?? null,
        query,
      ],
    );
  } catch {
    /* a concurrent request already cached it — fine */
  }

  return NextResponse.json({ image });
}

function toImage(r: CacheRow): HeroImage | null {
  if (!r.image_url) return null;
  return {
    url: r.image_url,
    photographer: r.photographer ?? "Unsplash",
    photographer_url: r.photographer_url ?? "https://unsplash.com",
  };
}
