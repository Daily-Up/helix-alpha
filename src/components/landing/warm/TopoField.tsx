/**
 * Generative topographic contour field.
 * Renders organic flowing lines that evoke data topology / terrain maps.
 * Pure SVG — no runtime dependencies. Deterministic (seeded math).
 */

const ACCENT = "#c87a4a";
const ACCENT_GLOW = "#d4a574";

function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function generateContourPaths(): string[] {
  const rand = seededRandom(42);
  const paths: string[] = [];
  const layers = 14;

  for (let layer = 0; layer < layers; layer++) {
    const yBase = 50 + layer * 60;
    const amplitude = 20 + rand() * 40;
    const frequency = 0.003 + rand() * 0.004;
    const phase = rand() * Math.PI * 2;

    let d = `M -20 ${yBase}`;
    for (let x = -20; x <= 920; x += 8) {
      const y =
        yBase +
        Math.sin(x * frequency + phase) * amplitude +
        Math.sin(x * frequency * 2.3 + phase * 1.7) * (amplitude * 0.4) +
        Math.cos(x * frequency * 0.7 + phase * 0.5) * (amplitude * 0.3);
      d += ` L ${x} ${y.toFixed(1)}`;
    }
    paths.push(d);
  }

  return paths;
}

const CONTOUR_PATHS = generateContourPaths();

export function TopoField() {
  return (
    <svg
      viewBox="0 0 900 900"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="h-full w-full"
      preserveAspectRatio="xMidYMid slice"
    >
      {CONTOUR_PATHS.map((d, i) => (
        <path
          key={i}
          d={d}
          stroke={i % 3 === 0 ? ACCENT_GLOW : ACCENT}
          strokeWidth={i % 5 === 0 ? 1.5 : 0.8}
          opacity={0.3 + (i % 3) * 0.15}
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}
