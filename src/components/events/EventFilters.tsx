"use client";

import { cn } from "@/components/ui/cn";

export interface FilterState {
  event_type?: string;
  sentiment?: "positive" | "negative" | "neutral";
  severity?: "high" | "medium" | "low";
}

const EVENT_TYPES = [
  "exploit",
  "regulatory",
  "etf_flow",
  "partnership",
  "listing",
  "social_platform",
  "macro",
  "treasury",
  "narrative",
  "earnings",
  "tech_update",
  "fundraising",
  "other",
];

export function EventFilters({
  value,
  onChange,
}: {
  value: FilterState;
  onChange: (next: FilterState) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterChip
        active={!value.event_type && !value.sentiment && !value.severity}
        onClick={() => onChange({})}
      >
        All
      </FilterChip>

      <Separator />

      <FilterChip
        active={value.sentiment === "positive"}
        onClick={() =>
          onChange({
            ...value,
            sentiment: value.sentiment === "positive" ? undefined : "positive",
          })
        }
        tone="positive"
      >
        Bullish
      </FilterChip>
      <FilterChip
        active={value.sentiment === "negative"}
        onClick={() =>
          onChange({
            ...value,
            sentiment: value.sentiment === "negative" ? undefined : "negative",
          })
        }
        tone="negative"
      >
        Bearish
      </FilterChip>

      <Separator />

      <FilterChip
        active={value.severity === "high"}
        onClick={() =>
          onChange({
            ...value,
            severity: value.severity === "high" ? undefined : "high",
          })
        }
        tone="warning"
      >
        High severity
      </FilterChip>

      <Separator />

      <select
        value={value.event_type ?? ""}
        onChange={(e) =>
          onChange({ ...value, event_type: e.target.value || undefined })
        }
        className="h-7 rounded border border-line bg-surface px-2 text-xs text-fg-muted focus:border-accent focus:outline-none"
      >
        <option value="">All event types</option>
        {EVENT_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
    </div>
  );
}

function Separator() {
  return <div className="h-4 w-px bg-line" />;
}

function FilterChip({
  active,
  onClick,
  children,
  tone = "default",
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  tone?: "default" | "positive" | "negative" | "warning";
}) {
  const activeClass =
    tone === "positive"
      ? "border-positive/40 bg-positive/15 text-positive"
      : tone === "negative"
        ? "border-negative/40 bg-negative/15 text-negative"
        : tone === "warning"
          ? "border-warning/40 bg-warning/15 text-warning"
          : "border-accent/40 bg-accent/15 text-accent-2";

  return (
    <button
      onClick={onClick}
      className={cn(
        "h-7 rounded border px-2.5 text-xs font-medium transition-colors",
        active
          ? activeClass
          : "border-line bg-surface text-fg-muted hover:border-line-2 hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}
