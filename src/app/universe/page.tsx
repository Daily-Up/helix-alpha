import { Shell } from "@/components/layout/Shell";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Assets } from "@/lib/db";
import { fmtAssetSymbol } from "@/lib/format";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  token: "Token",
  rwa: "RWA",
  etf_fund: "ETF Fund",
  etf_aggregate: "ETF Aggregate",
  stock: "Stock",
  treasury: "Treasury",
  index: "SSI Index",
  macro: "Macro",
};

export default function UniversePage() {
  const all = Assets.getAllAssets();
  const grouped = new Map<string, typeof all>();
  for (const a of all) {
    if (!grouped.has(a.kind)) grouped.set(a.kind, []);
    grouped.get(a.kind)!.push(a);
  }

  const order = [
    "token",
    "rwa",
    "etf_aggregate",
    "etf_fund",
    "stock",
    "treasury",
    "index",
    "macro",
  ];

  return (
    <Shell>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="text-xl font-semibold text-fg">Asset Universe</h1>
          <p className="text-sm text-fg-muted">
            {all.length} instruments tracked across crypto / RWA / ETFs / stocks /
            sector indexes / macro indicators.
          </p>
        </header>

        {order
          .filter((k) => grouped.has(k))
          .map((kind) => {
            const list = grouped.get(kind)!;
            return (
              <Card key={kind}>
                <CardHeader>
                  <CardTitle>{KIND_LABEL[kind] ?? kind}</CardTitle>
                  <div className="text-xs text-fg-muted">{list.length}</div>
                </CardHeader>
                <CardBody>
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4">
                    {list.map((a) => (
                      <div
                        key={a.id}
                        className="flex items-center justify-between gap-2 rounded border border-line bg-bg px-2 py-1.5"
                      >
                        <div className="min-w-0">
                          <div className="font-mono text-xs font-medium text-fg">
                            {fmtAssetSymbol(a.symbol, a.kind)}
                          </div>
                          <div className="truncate text-[11px] text-fg-dim">
                            {a.name}
                          </div>
                        </div>
                        {a.tags.length ? (
                          <Badge tone="default">{a.tags[0]}</Badge>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </CardBody>
              </Card>
            );
          })}
      </div>
    </Shell>
  );
}
