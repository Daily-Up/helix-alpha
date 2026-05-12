/**
 * ScreenshotBlock — server component that renders a real screenshot
 * when the file is present in /public/landing, or a deliberate-looking
 * placeholder frame when it isn't.
 *
 * The placeholder is intentionally austere: thin border, monospace
 * "screenshot pending" caption, and the same captions that live below
 * the real image. This way the page reads as "in progress" rather than
 * "broken" before the screenshots are dropped in.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import Image from "next/image";

const TEXT = "#ede4d3";
const TEXT_MUTED = "#8a857a";

interface ScreenshotBlockProps {
  /** Public path, e.g. "/landing/audit.png". */
  src: string;
  alt: string;
  title: string;
  body: string;
}

function imageExists(publicPath: string): boolean {
  // publicPath starts with "/"; resolve against the public/ folder.
  const fsPath = join(process.cwd(), "public", publicPath.replace(/^\//, ""));
  try {
    return existsSync(fsPath);
  } catch {
    return false;
  }
}

export function ScreenshotBlock({
  src,
  alt,
  title,
  body,
}: ScreenshotBlockProps) {
  const hasImage = imageExists(src);

  return (
    <figure className="w-full max-w-[1080px] opacity-0" data-reveal="screenshot">
      <div
        className="landing-screenshot relative aspect-[16/10] w-full overflow-hidden"
        style={{ border: `1px solid ${TEXT}4d` }}
      >
        {hasImage ? (
          <Image
            src={src}
            alt={alt}
            fill
            sizes="(min-width: 1080px) 1080px, 100vw"
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
      <figcaption className="mt-6">
        <div
          className="font-[var(--font-fraunces)] font-medium"
          style={{ fontSize: "20px", color: TEXT, lineHeight: 1.3 }}
        >
          {title}
        </div>
        <div
          className="mt-2 font-[var(--font-inter)]"
          style={{
            fontSize: "15px",
            color: TEXT_MUTED,
            lineHeight: 1.65,
            maxWidth: "780px",
          }}
        >
          {body}
        </div>
      </figcaption>
    </figure>
  );
}
