import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

/**
 * Page shell — sidebar + topbar wrapping the main content.
 *
 * Content is capped at 1440px max-width to match the landing's
 * editorial framing — without the cap, every dashboard panel
 * stretched to whatever viewport width the user had, which made
 * signal cards float in 400px of empty space on wide monitors.
 * 1440 is slightly wider than the landing's 1280 so dense
 * dashboard panels (equity curve + risk metrics side by side)
 * still breathe. Used by every page in the app.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-bg text-fg">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="flex-1 overflow-y-auto px-6 py-5 md:px-10 md:py-7">
          <div className="mx-auto w-full max-w-[1440px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
