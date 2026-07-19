import Link from "next/link";
import { isPublicMode } from "@/lib/public-mode";

interface NavItem {
  href: string;
  label: string;
  /** Hidden from the sidebar when public-mode is on (judges, public viewers). */
  internal?: boolean;
}

// Trader-facing navigation. Four clear groups, no NEW/SOON/BETA badges.
// Unfinished stubs (Pattern Library, Learnings, Calibration) and ops
// surfaces (Agent Activity, Cron & Audit, System Health) are grouped
// under "internal" and hidden on the public deploy — dev still sees them.
// Asset Universe is demoted to a footer link (raw reference data).
const NAV: Array<{ section: string; items: NavItem[] }> = [
  {
    section: "Trade",
    items: [
      { href: "/app", label: "Dashboard" },
      { href: "/signals", label: "Live Signals" },
      { href: "/briefing", label: "Daily Briefing" },
      { href: "/signals/performance", label: "Track Record" },
    ],
  },
  {
    section: "Portfolio",
    items: [
      { href: "/portfolio", label: "Portfolio" },
      { href: "/index-fund", label: "AlphaIndex" },
    ],
  },
  {
    section: "Markets",
    items: [
      { href: "/events", label: "Event Stream" },
      { href: "/unlocks", label: "Token Unlocks" },
      { href: "/sectors", label: "Sector Rotation" },
      { href: "/etfs", label: "ETF Flows" },
      { href: "/treasuries", label: "Treasury Watch" },
      { href: "/macro", label: "Macro Bridge" },
    ],
  },
  {
    section: "Live Trading",
    items: [{ href: "/settings/connect-sodex", label: "Connect SoDEX" }],
  },
  {
    section: "Internal",
    items: [
      { href: "/patterns", label: "Pattern Library", internal: true },
      { href: "/learnings", label: "Learnings", internal: true },
      { href: "/calibration", label: "Calibration", internal: true },
      { href: "/agents", label: "Agent Activity", internal: true },
      { href: "/jobs", label: "Cron & Audit", internal: true },
      { href: "/system-health", label: "System Health", internal: true },
    ],
  },
];

/** Desktop rail — hidden below md, where MobileNav's drawer takes over. */
export function Sidebar() {
  return (
    <aside className="hidden h-screen w-56 shrink-0 flex-col border-r border-line bg-surface md:flex">
      <SidebarContent />
    </aside>
  );
}

/**
 * The nav column itself (logo + sections + footer). Shared by the desktop
 * rail and the mobile drawer. `onNavigate` lets the drawer close itself
 * when a link is tapped.
 */
export function SidebarContent({ onNavigate }: { onNavigate?: () => void } = {}) {
  const publicMode = isPublicMode();
  const sections = NAV.map((section) => ({
    ...section,
    items: section.items.filter((item) => !(publicMode && item.internal)),
  })).filter((section) => section.items.length > 0);
  return (
    <>
      <Link
        href="/"
        onClick={onNavigate}
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
        {sections.map((section) => (
          <div key={section.section} className="mb-4">
            <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-fg-dim">
              {section.section}
            </div>
            <ul className="flex flex-col gap-0.5">
              {section.items.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    className="flex items-center rounded px-2 py-1.5 text-sm text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
                  >
                    <span>{item.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-line px-3 py-2">
        <Link
          href="/universe"
          onClick={onNavigate}
          className="block pb-1.5 text-[11px] text-fg-muted transition-colors hover:text-fg"
        >
          Asset Universe →
        </Link>
        <div className="text-[10px] text-fg-dim">Data: SoSoValue · AI: Claude</div>
      </div>
    </>
  );
}
