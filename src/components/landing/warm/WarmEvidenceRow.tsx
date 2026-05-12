import { existsSync } from "node:fs";
import { join } from "node:path";
import Image from "next/image";
import Link from "next/link";

const TEXT = "#f0e8db";
const TEXT_MUTED = "#9a8e7d";
const ACCENT = "#c87a4a";

export interface WarmEvidenceRowProps {
  /** Which side the screenshot sits on at ≥768px. Captions take the other side. */
  side: "left" | "right";
  /** Monospace eyebrow label, e.g. "EVIDENCE 01". */
  eyebrow: string;
  /** Serif headline shown alongside the screenshot. */
  title: string;
  /** Inter body paragraph. */
  body: string;
  /** Footer link text — kept short, e.g. "View live audit →". */
  linkLabel: string;
  /** Destination route, e.g. "/signals". */
  href: string;
  /** Path under /public for the screenshot. */
  src: string;
  /** Accessible description of what the screenshot proves. */
  alt: string;
}

function imageExists(publicPath: string): boolean {
  const fsPath = join(process.cwd(), "public", publicPath.replace(/^\//, ""));
  try {
    return existsSync(fsPath);
  } catch {
    return false;
  }
}

export function WarmEvidenceRow({
  side,
  eyebrow,
  title,
  body,
  linkLabel,
  href,
  src,
  alt,
}: WarmEvidenceRowProps) {
  const hasImage = imageExists(src);
  const imageLeft = side === "left";

  // Source order is always image-then-caption so that on mobile (<768px,
  // single-column stack) the screenshot sits above its caption regardless
  // of which side it's pinned to on desktop. On desktop we re-position
  // each cell with col-start so the zigzag rhythm reads correctly. 8-col
  // image / 4-col caption — the wider image slot is the difference between
  // readable dashboard text and a thumbnail.
  const imageCol = imageLeft
    ? "md:col-start-1 md:col-span-8"
    : "md:col-start-5 md:col-span-8";
  const captionCol = imageLeft
    ? "md:col-start-9 md:col-span-4"
    : "md:col-start-1 md:col-span-4 md:row-start-1";

  return (
    <figure className="grid w-full grid-cols-1 items-center gap-y-10 md:grid-cols-12 md:gap-x-12">
      {/* ── Screenshot frame ── */}
      <div className={`${imageCol} flex justify-center`}>
        <div
          className="relative w-full max-w-[1200px]"
          style={{ aspectRatio: "16 / 10" }}
        >
          {/* Amber accent stripe — vertical, left edge */}
          <span
            aria-hidden
            className="pointer-events-none absolute left-0 top-0 bottom-0 z-10"
            style={{
              width: "3px",
              background: ACCENT,
              opacity: 0.6,
            }}
          />
          <div
            className="relative h-full w-full overflow-hidden"
            style={{ border: `1px solid ${TEXT}33` }}
          >
            {hasImage ? (
              <Image
                src={src}
                alt={alt}
                fill
                sizes="(min-width: 1280px) 950px, (min-width: 768px) 70vw, 100vw"
                className="object-cover"
                unoptimized
              />
            ) : (
              <div
                className="flex h-full w-full flex-col items-center justify-center gap-3"
                style={{ background: "#1a1714" }}
              >
                <div
                  className="font-[var(--font-jetbrains-mono)] uppercase"
                  style={{
                    fontSize: "11px",
                    color: TEXT_MUTED,
                    letterSpacing: "0.12em",
                  }}
                >
                  SCREENSHOT PENDING
                </div>
                <div
                  className="font-[var(--font-jetbrains-mono)]"
                  style={{
                    fontSize: "12px",
                    color: TEXT_MUTED,
                    opacity: 0.6,
                  }}
                >
                  {src}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Caption block ── */}
      <figcaption className={captionCol}>
        <div
          className="font-[var(--font-jetbrains-mono)] uppercase"
          style={{
            fontSize: "11px",
            letterSpacing: "0.22em",
            color: ACCENT,
            marginBottom: "16px",
          }}
        >
          {eyebrow}
        </div>
        <div
          className="font-[var(--font-fraunces)]"
          style={{
            fontSize: "32px",
            fontWeight: 500,
            color: TEXT,
            letterSpacing: "-0.015em",
            lineHeight: 1.2,
            marginBottom: "20px",
          }}
        >
          {title}
        </div>
        <p
          className="font-[var(--font-inter)]"
          style={{
            fontSize: "16px",
            fontWeight: 400,
            lineHeight: 1.65,
            color: TEXT_MUTED,
            maxWidth: "320px",
            marginBottom: "24px",
          }}
        >
          {body}
        </p>
        <Link
          href={href}
          className="font-[var(--font-jetbrains-mono)] uppercase transition-colors hover:opacity-80"
          style={{
            fontSize: "11px",
            letterSpacing: "0.18em",
            color: ACCENT,
          }}
        >
          {linkLabel}
        </Link>
      </figcaption>
    </figure>
  );
}
