"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Cell,
} from "recharts";
import { fmtUsd } from "@/lib/format";

export interface InflowChartRow {
  date: string;
  total_net_inflow: number | null;
}

/**
 * Daily net inflow bar chart — green = positive, red = negative.
 * The competitor's app does the same chart but with mocked data; ours
 * is real SoSoValue data so the bars actually mean something.
 */
export function InflowChart({ data }: { data: InflowChartRow[] }) {
  const safe = data.map((d) => ({
    ...d,
    flow: typeof d.total_net_inflow === "number" ? d.total_net_inflow : 0,
  }));

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer>
        <BarChart data={safe} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
          <CartesianGrid stroke="#1f2630" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: "#8a93a6", fontSize: 10 }}
            axisLine={{ stroke: "#1f2630" }}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={20}
          />
          <YAxis
            tickFormatter={(v) => fmtUsd(v)}
            tick={{ fill: "#8a93a6", fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={70}
          />
          <Tooltip
            cursor={{ fill: "#161b24" }}
            contentStyle={{
              background: "#0f1218",
              border: "1px solid #2a3340",
              borderRadius: 6,
              fontSize: 12,
              color: "#e6e9ef",
            }}
            labelStyle={{ color: "#8a93a6" }}
            formatter={(value) => [
              fmtUsd(typeof value === "number" ? value : Number(value)),
              "Net inflow",
            ]}
          />
          <ReferenceLine y={0} stroke="#2a3340" />
          <Bar dataKey="flow" radius={[2, 2, 0, 0]}>
            {safe.map((entry, idx) => (
              <Cell
                key={idx}
                fill={entry.flow >= 0 ? "#22c55e" : "#ef4444"}
                opacity={0.85}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
