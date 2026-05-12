"use client";

import { cn } from "./cn";

/**
 * Skeleton placeholder — matches eventual content dimensions.
 * Subtle shimmer at 8% opacity max, respects prefers-reduced-motion.
 */
export function Skeleton({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("skeleton-shimmer rounded", className)}
      {...rest}
    />
  );
}

export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="w-full">
      <div className="flex gap-4 border-b border-line px-3 py-2">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4 border-b border-line px-3 py-3">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function PanelSkeleton({ height = "h-48" }: { height?: string }) {
  return (
    <div className={cn("rounded-md border border-line bg-surface", height)}>
      <div className="flex items-center border-b border-line px-4 py-3">
        <Skeleton className="h-3 w-32" />
      </div>
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  );
}

export function StatSkeleton() {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line bg-surface px-4 py-3">
      <Skeleton className="h-2.5 w-16" />
      <Skeleton className="h-6 w-20" />
      <Skeleton className="h-3 w-24" />
    </div>
  );
}

const CHART_BAR_HEIGHTS = [45, 72, 38, 65, 55, 80, 42, 68, 35, 58, 75, 48];

export function ChartSkeleton({ height = "h-64" }: { height?: string }) {
  return (
    <div className={cn("rounded-md border border-line bg-surface", height)}>
      <div className="flex items-center border-b border-line px-4 py-3">
        <Skeleton className="h-3 w-28" />
      </div>
      <div className="flex h-full items-end gap-1 p-4 pb-8">
        {CHART_BAR_HEIGHTS.map((h, i) => (
          <Skeleton
            key={i}
            className="flex-1"
            style={{ height: `${h}%` }}
          />
        ))}
      </div>
    </div>
  );
}
