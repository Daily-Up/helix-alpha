import type { ReactNode } from "react";
import { cn } from "./cn";
import { Num } from "./Num";
import { Magnitude } from "./Magnitude";

/**
 * A table where columns declare a ROLE. Width, weight, and alignment
 * derive from the role — never from the raw field list. This is what stops
 * "every returned field became an equal column".
 *
 *   lead        — the one number that matters per row (emphasised)
 *   magnitude   — numeric + inline bar scaled to the column max (see the ratio)
 *   context     — supporting numbers, muted and small (fold candidates)
 *   identifier  — asset / ticker / name (mono, left)
 *   action      — an <Action> (already refuses impossible ones)
 */
export type ColRole = "lead" | "magnitude" | "context" | "identifier" | "action";

export interface Column<T> {
  key: string;
  header: string;
  role: ColRole;
  /** Numeric accessor for lead / magnitude / numeric-context columns. */
  num?: (row: T) => number | null | undefined;
  unit?: string;
  sign?: boolean;
  dp?: number;
  compact?: boolean;
  tone?: "positive" | "negative" | "auto";
  /** Custom cell (identifier / action, or a text override). */
  render?: (row: T) => ReactNode;
  align?: "left" | "right";
}

export function DataTable<T>({
  columns,
  rows,
  getKey,
  className,
  minWidth = 360,
}: {
  columns: Column<T>[];
  rows: T[];
  getKey: (row: T, i: number) => string;
  className?: string;
  minWidth?: number;
}) {
  // per magnitude column: the absolute max, for bar scaling
  const maxes: Record<string, number> = {};
  for (const c of columns) {
    if (c.role === "magnitude" && c.num) {
      let mx = 0;
      for (const r of rows) {
        const v = c.num(r);
        if (v != null && !Number.isNaN(v)) mx = Math.max(mx, Math.abs(v));
      }
      maxes[c.key] = mx;
    }
  }
  const alignOf = (c: Column<T>) =>
    c.align ?? (c.role === "identifier" ? "left" : "right");

  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full border-collapse text-sm" style={{ minWidth }}>
        <thead>
          <tr className="border-b border-line">
            {columns.map((c) => (
              <th
                key={c.key}
                className={cn(
                  "px-4 py-2.5 text-[10px] font-medium uppercase tracking-[0.14em] text-fg-dim",
                  alignOf(c) === "right" ? "text-right" : "text-left",
                  c.role === "context" && "opacity-60",
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={getKey(r, i)}
              className="border-b border-line/50 transition-colors hover:bg-surface-2/50"
            >
              {columns.map((c) => {
                const right = alignOf(c) === "right";
                let cell: ReactNode;
                if (c.role === "magnitude" && c.num) {
                  cell = (
                    <Magnitude
                      value={c.num(r)}
                      max={maxes[c.key]}
                      unit={c.unit}
                      sign={c.sign}
                      dp={c.dp}
                      compact={c.compact}
                      tone={c.tone}
                    />
                  );
                } else if (c.render) {
                  cell = (
                    <span
                      className={cn(
                        c.role === "identifier" &&
                          "font-[var(--font-jetbrains-mono)] text-fg",
                        c.role === "context" && "text-xs text-fg-muted",
                        c.role === "lead" && "font-medium text-fg",
                      )}
                    >
                      {c.render(r)}
                    </span>
                  );
                } else if (c.num) {
                  cell = (
                    <Num
                      value={c.num(r)}
                      unit={c.unit}
                      sign={c.sign}
                      dp={c.dp}
                      compact={c.compact}
                      tone={c.tone}
                      tier={c.role === "context" ? "context" : "secondary"}
                      className={c.role === "lead" ? "font-medium text-[15px]" : undefined}
                    />
                  );
                } else {
                  cell = null;
                }
                return (
                  <td
                    key={c.key}
                    className={cn(
                      "py-3",
                      // magnitude cells manage their own inner padding so the
                      // bar can run the width of the column
                      c.role === "magnitude" ? "px-1.5" : "px-4",
                      right ? "text-right" : "text-left",
                    )}
                  >
                    {cell}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
