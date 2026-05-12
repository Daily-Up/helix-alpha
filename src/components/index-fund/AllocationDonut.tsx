"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { fmtUsd } from "@/lib/format";

interface Slice {
  name: string;
  value: number;
  weight: number;
  color: string;
}

const PALETTE = [
  "#ff7a45", // accent
  "#22c55e",
  "#4d9fff",
  "#a855f7",
  "#f59e0b",
  "#ef4444",
  "#14b8a6",
  "#ec4899",
  "#84cc16",
  "#8b5cf6",
  "#06b6d4",
  "#facc15",
  "#fb7185",
  "#10b981",
  "#3b82f6",
];

export function AllocationDonut({
  positions,
  cashUsd,
  navTotal,
}: {
  positions: Array<{ symbol: string; current_value_usd: number }>;
  cashUsd: number;
  navTotal: number;
}) {
  const slices: Slice[] = positions.map((p, i) => ({
    name: p.symbol,
    value: p.current_value_usd,
    weight: navTotal > 0 ? p.current_value_usd / navTotal : 0,
    color: PALETTE[i % PALETTE.length],
  }));
  if (cashUsd > 0) {
    slices.push({
      name: "Cash",
      value: cashUsd,
      weight: navTotal > 0 ? cashUsd / navTotal : 0,
      color: "#3a4250",
    });
  }

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer>
        <PieChart>
          <Pie
            data={slices}
            dataKey="value"
            nameKey="name"
            innerRadius="55%"
            outerRadius="90%"
            paddingAngle={1}
            stroke="#0f1218"
          >
            {slices.map((s, i) => (
              <Cell key={i} fill={s.color} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              background: "#0f1218",
              border: "1px solid #2a3340",
              borderRadius: 6,
              fontSize: 12,
              color: "#e6e9ef",
            }}
            formatter={(value: unknown, _name: unknown, item) => {
              const v = typeof value === "number" ? value : Number(value);
              const w = (item.payload?.weight ?? 0) * 100;
              return [`${fmtUsd(v)} (${w.toFixed(1)}%)`, item.payload?.name];
            }}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
