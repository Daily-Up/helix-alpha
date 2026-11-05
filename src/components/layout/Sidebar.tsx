"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  CandlestickChart,
  Zap,
  Newspaper,
  Wallet,
  LineChart,
  Rss,
  Lock,
  LayoutGrid,
  ArrowLeftRight,
  Landmark,
  Globe,
  Shapes,
  GraduationCap,
  Gauge,
  Bot,
  Clock,
  Activity,
  type LucideIcon,
} from "lucide-react";
import { isPublicMode } from "@/lib/public-mode";
import { cn } from "@/components/ui/cn";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Hidden from the sidebar when public-mode is on (judges, public viewers). */
  internal?: boolean;
}

// Trader-facing navigation. Four clear groups, no NEW/SOON/BETA badges.
const NAV: Array<{ section: string; items: NavItem[] }> = [
  {
    section: "Trade",
    items: [
      { href: "/app", label: "Dashboard", icon: LayoutDashboard },
      { href: "/trade", label: "Trade Terminal", icon: CandlestickChart },
      { href: "/signals", label: "Live Signals", icon: Zap },
      { href: "/briefing", label: "Daily Briefing", icon: Newspaper },
    ],
  },
  {
    section: "Portfolio",
    items: [
      { href: "/portfolio", label: "Portfolio", icon: Wallet },
      { href: "/wealth-index", label: "Wealth Index", icon: LineChart },
    ],
  },
  {
    section: "Markets",
    items: [
      { href: "/events", label: "Event Stream", icon: Rss },
      { href: "/unlocks", label: "Token Unlocks", icon: Lock },
      { href: "/sectors", label: "Sector Rotation", icon: LayoutGrid },
      { href: "/etfs", label: "ETF Flows", icon: ArrowLeftRight },
      { href: "/treasuries", label: "Treasury Watch", icon: Landmark },
      { href: "/macro", label: "Macro Bridge", icon: Globe },
    ],
  },
  {
    section: "Internal",
    items: [
      { href: "/patterns", label: "Pattern Library", icon: Shapes, internal: true },
      { href: "/learnings", label: "Learnings", icon: GraduationCap, internal: true },
      { href: "/calibration", label: "Calibration", icon: Gauge, internal: true },
      { href: "/agents", label: "Agent Activity", icon: Bot, internal: true },
      { href: "/jobs", label: "Cron & Audit", icon: Clock, internal: true },
      { href: "/system-health", label: "System Health", icon: Activity, internal: true },
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
  const pathname = usePathname() ?? "";
  const sections = NAV.map((section) => ({
    ...section,
    items: section.items.filter((item) => !(publicMode && item.internal)),
  })).filter((section) => section.items.length > 0);
  const isActive = (href: string) =>
    pathname === href || (href.length > 1 && pathname.startsWith(href + "/"));
  return (
    <>
      <Link
        href="/"
        onClick={onNavigate}
        className="flex h-14 items-center gap-2 border-b border-line px-4 transition-colors hover:bg-surface-2"
      >
        <div className="flex h-7 w-7 items-center justify-center rounded bg-accent text-sm font-semibold text-bg">
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
              {section.items.map((item) => {
                const active = isActive(item.href);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "relative flex items-center gap-2.5 rounded-md py-1.5 pl-3 pr-2 text-sm transition-colors duration-150",
                        active
                          ? "bg-accent/10 font-medium text-accent-2"
                          : "text-fg-muted hover:bg-surface-2 hover:text-fg",
                      )}
                    >
                      {active ? (
                        <span
                          aria-hidden
                          className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-accent"
                        />
                      ) : null}
                      <Icon
                        size={16}
                        strokeWidth={active ? 2.25 : 1.9}
                        className={cn("shrink-0", active ? "text-accent-2" : "text-fg-dim")}
                      />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
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
