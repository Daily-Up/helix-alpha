"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtUsd } from "@/lib/format";

export interface AumChartRow {
  date: string;
  total_net_assets: number | null;
}

/** Cumulative net assets (AUM) area chart. */
export function AumChart({ data }: { data: AumChartRow[] }) {
  const safe = data.map((d) => ({
    ...d,
    aum: typeof d.total_net_assets === "number" ? d.total_net_assets : 0,
  }));

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer>
        <AreaChart data={safe} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
          <defs>
            <linearGradient id="aumFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ff7a45" stopOpacity={0.4} />
              <stop offset="100%" stopColor="#ff7a45" stopOpacity={0} />
            </linearGradient>
          </defs>
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
            domain={["auto", "auto"]}
          />
          <Tooltip
            cursor={{ stroke: "#2a3340" }}
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
              "AUM",
            ]}
          />
          <Area
            type="monotone"
            dataKey="aum"
            stroke="#ff7a45"
            strokeWidth={2}
            fill="url(#aumFill)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
