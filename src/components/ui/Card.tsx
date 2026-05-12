import { cn } from "./cn";

/**
 * Editorial section container. No rounded box, no surface fill — just a
 * subtle hairline top border separating it from neighbors. Replaces the
 * old Bloomberg-terminal Card chrome.
 */
export function Card({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <section
      className={cn("flex flex-col", className)}
      style={{ borderTop: "1px solid rgba(237, 228, 211, 0.08)" }}
      {...rest}
    >
      {children}
    </section>
  );
}

/** Section header — small-caps mono title on the left, optional meta on the right. */
export function CardHeader({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn("flex items-baseline justify-between gap-3 pt-5 pb-3", className)}
    >
      {children}
    </div>
  );
}

/** Editorial title — small-caps mono, dim cream, generous tracking. */
export function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="font-[var(--font-jetbrains-mono)] uppercase"
      style={{
        fontSize: "10px",
        fontWeight: 600,
        letterSpacing: "0.22em",
        color: "#8a857a",
      }}
    >
      {children}
    </div>
  );
}

/** Body — no extra padding so children sit flush under the header hairline. */
export function CardBody({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={cn("pb-5", className)}>{children}</div>;
}
