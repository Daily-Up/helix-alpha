import { existsSync } from "node:fs";
import { join } from "node:path";
import Image from "next/image";

const TEXT = "#f0e8db";
const TEXT_MUTED = "#9a8e7d";
const ACCENT = "#c87a4a";

interface WarmScreenshotBlockProps {
  src: string;
  alt: string;
  title: string;
  body: string;
}

function imageExists(publicPath: string): boolean {
  const fsPath = join(process.cwd(), "public", publicPath.replace(/^\//, ""));
  try {
    return existsSync(fsPath);
  } catch {
    return false;
  }
}

export function WarmScreenshotBlock({
  src,
  alt,
  title,
  body,
}: WarmScreenshotBlockProps) {
  const hasImage = imageExists(src);

  return (
    <figure className="w-full max-w-[1080px]">
      <div
        className="relative aspect-[16/10] w-full overflow-hidden rounded-sm"
        style={{
          border: `1px solid ${TEXT}15`,
          boxShadow: `0 20px 60px rgba(0,0,0,0.4), 0 0 0 1px ${TEXT}08`,
        }}
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
            lineHeight: 1.6,
            maxWidth: "780px",
          }}
        >
          {body}
        </div>
      </figcaption>
    </figure>
  );
}
