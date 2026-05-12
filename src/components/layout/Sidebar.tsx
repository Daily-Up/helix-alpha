import Link from "next/link";

interface NavItem {
  href: string;
  label: string;
  badge?: string;
}

const NAV: Array<{ section: string; items: NavItem[] }> = [
  {
    section: "Overview",
    items: [{ href: "/app", label: "Home" }],
  },
  {
    section: "Intelligence",
    items: [
      { href: "/events", label: "Event Stream" },
      { href: "/sectors", label: "Sector Rotation" },
      { href: "/etfs", label: "ETF Flows" },
      { href: "/treasuries", label: "Treasury Watch", badge: "NEW" },
      { href: "/macro", label: "Macro Bridge" },
      { href: "/patterns", label: "Pattern Library" },
    ],
  },
  {
    section: "Action",
    items: [
      { href: "/briefing", label: "Daily Briefing", badge: "NEW" },
      { href: "/signals", label: "Live Signals" },
      { href: "/portfolio", label: "Paper Portfolio" },
      { href: "/index-fund", label: "AlphaIndex", badge: "NEW" },
      { href: "/learnings", label: "Learnings", badge: "NEW" },
      { href: "/calibration", label: "Calibration", badge: "NEW" },
    ],
  },
  {
    section: "System",
    items: [
      { href: "/jobs", label: "Cron & Audit" },
      { href: "/system-health", label: "System Health", badge: "NEW" },
      { href: "/universe", label: "Asset Universe" },
    ],
  },
];

export function Sidebar() {
  return (
    <aside className="flex h-screen w-56 shrink-0 flex-col border-r border-line bg-surface">
      <Link
        href="/"
        className="flex h-14 items-center gap-2 border-b border-line px-4 transition-colors hover:bg-surface-2"
      >
        <div className="flex h-7 w-7 items-center justify-center rounded bg-accent text-sm font-bold text-bg">
          α
        </div>
        <div className="flex flex-col leading-tight">
          <span className="font-[var(--font-fraunces)] text-[18px] font-medium text-fg">Helix</span>
          <span className="font-[var(--font-jetbrains-mono)] text-[10px] text-fg-dim" style={{ letterSpacing: "0.1em" }}>Event-driven alpha</span>
        </div>
      </Link>

      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {NAV.map((section) => (
          <div key={section.section} className="mb-4">
            <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-fg-dim">
              {section.section}
            </div>
            <ul className="flex flex-col gap-0.5">
              {section.items.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="flex items-center justify-between rounded px-2 py-1.5 text-sm text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
                  >
                    <span>{item.label}</span>
                    {item.badge ? (
                      <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent-2">
                        {item.badge}
                      </span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-line px-3 py-2 text-[10px] text-fg-dim">
        Data: SoSoValue · AI: Claude
      </div>
    </aside>
  );
}
