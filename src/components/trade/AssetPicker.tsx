"use client";

/**
 * AssetPicker — searchable market selector for the terminal. Replaces the
 * native <select> (ugly OS dropdown, no search) with a dark, filterable
 * panel: type to filter by symbol or name, grouped by asset class, each
 * row with its logo. Closes on select, outside-click, or Escape.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AssetLogo } from "@/components/ui/AssetLogo";
import { cn } from "@/components/ui/cn";

export interface PickerAsset {
  id: string;
  symbol: string;
  name: string;
  kind: string;
}

const GROUPS: Array<{ label: string; kinds: string[] }> = [
  { label: "Crypto", kinds: ["token", "rwa"] },
  { label: "Stocks", kinds: ["stock"] },
  { label: "Indices", kinds: ["index"] },
  { label: "Commodities", kinds: ["commodity"] },
  { label: "Other", kinds: ["treasury", "macro"] },
];

export function AssetPicker({
  assets,
  value,
  onChange,
  suffix = "",
}: {
  assets: PickerAsset[];
  value: string;
  onChange: (id: string) => void;
  /** Appended to the selected symbol in the button, e.g. "-PERP". */
  suffix?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = assets.find((a) => a.id === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    const t = setTimeout(() => inputRef.current?.focus(), 10);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      clearTimeout(t);
    };
  }, [open]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (a: PickerAsset) =>
      !needle ||
      a.symbol.toLowerCase().includes(needle) ||
      a.name.toLowerCase().includes(needle);
    return GROUPS.map((g) => ({
      label: g.label,
      items: assets.filter((a) => g.kinds.includes(a.kind) && match(a)),
    })).filter((g) => g.items.length > 0);
  }, [assets, q]);

  function pick(id: string) {
    onChange(id);
    setOpen(false);
    setQ("");
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 text-[16px] font-semibold text-fg outline-none"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {selected ? `${selected.symbol}${suffix}` : "Select market"}
        <span className={cn("text-[11px] text-fg-dim transition-transform", open && "rotate-180")}>
          ▾
        </span>
      </button>

      {open ? (
        <div className="absolute left-0 top-full z-50 mt-2 w-[288px] overflow-hidden rounded-lg border border-line bg-surface shadow-2xl">
          <div className="border-b border-line p-2">
            <div className="flex items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 focus-within:border-[#3a4452]">
              <span className="text-fg-dim">⌕</span>
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search markets…"
                className="w-full bg-transparent py-1.5 text-[13px] text-fg outline-none placeholder:text-fg-dim"
              />
            </div>
          </div>
          <div className="max-h-[340px] overflow-y-auto py-1">
            {groups.length === 0 ? (
              <div className="px-3 py-6 text-center text-[12px] text-fg-dim">
                No markets match “{q}”.
              </div>
            ) : (
              groups.map((g) => (
                <div key={g.label}>
                  <div className="px-3 pb-1 pt-2 text-[9px] font-medium uppercase tracking-wider text-fg-dim">
                    {g.label}
                  </div>
                  {g.items.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => pick(a.id)}
                      className={cn(
                        "flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors hover:bg-surface-2",
                        a.id === value && "bg-accent/10",
                      )}
                    >
                      <AssetLogo symbol={a.symbol} size={18} />
                      <span className="text-[13px] font-medium text-fg">{a.symbol}</span>
                      <span className="truncate text-[11px] text-fg-dim">{a.name}</span>
                      {a.id === value ? (
                        <span className="ml-auto text-[12px] text-accent-2">✓</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
