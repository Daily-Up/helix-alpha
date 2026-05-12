import { Card, CardBody } from "./Card";

export function ComingSoon({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <Card>
      <CardBody className="flex flex-col items-center gap-2 py-12 text-center">
        <div className="text-2xl font-semibold text-fg">{title}</div>
        <div className="max-w-md text-sm text-fg-muted">{description}</div>
        <div className="mt-2 rounded border border-line-2 bg-surface-2 px-2 py-1 text-[10px] uppercase tracking-wider text-fg-dim">
          Coming next
        </div>
      </CardBody>
    </Card>
  );
}
