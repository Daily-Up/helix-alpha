/**
 * EvidenceRow — paired screenshot + caption in a 12-col zigzag layout.
 *
 * Three rows on the landing's "Built to be inspected" section. Each row
 * dedicates 7 cols to the screenshot and 5 cols to the caption, alternating
 * sides so the page reads with rhythm. Source order is always image then
 * caption, so on mobile (<768px) the stack reads naturally.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import Image from "next/image";
import Link from "next/link";

const TEXT = "#ede4d3";
const TEXT_MUTED = "#8a857a";
const ACCENT = "#d97757";

export interface EvidenceRowProps {
  /** Which side the screenshot sits on at ≥768px. */
  side: "left" | "right";
  /** Monospace eyebrow label, e.g. "EVIDENCE 01". */
  eyebrow: string;
  title: string;
  body: string;
  /** Footer link label, e.g. "View live audit →". */
  linkLabel: string;
  /** Destination route, e.g. "/signals". */
  href: string;
  /** Public path of the screenshot. */
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

export function EvidenceRow({
  side,
  eyebrow,
  title,
  body,
  linkLabel,
  href,
  src,
  alt,
}: EvidenceRowProps) {
  const hasImage = imageExists(src);
  const imageLeft = side === "left";

  // Source order = image then caption so mobile stacks read top-to-bottom
  // with the screenshot first. On desktop we use col-start to place each
  // cell, allowing the caption to render to the left of the image when
  // side="right" despite coming second in the DOM. 8-col image / 4-col
  // caption — the wider image slot is the difference between readable
  // dashboard text and a thumbnail.
  const imageCol = imageLeft
    ? "md:col-start-1 md:col-span-8"
    : "md:col-start-5 md:col-span-8";
  const captionCol = imageLeft
    ? "md:col-start-9 md:col-span-4"
    : "md:col-start-1 md:col-span-4 md:row-start-1";

  return (
    <figure
      className="grid w-full grid-cols-1 items-center gap-y-10 opacity-0 md:grid-cols-12 md:gap-x-12"
      data-reveal="screenshot"
    >
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
            className="landing-screenshot relative h-full w-full overflow-hidden"
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
              <div className="flex h-full w-full flex-col items-center justify-center gap-3">
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
          className="font-[var(--font-jetbrains-mono)] uppercase transition-opacity hover:opacity-80"
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
