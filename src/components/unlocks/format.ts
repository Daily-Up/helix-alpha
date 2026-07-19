/**
 * Countdown formatter for a FUTURE ms timestamp.
 *
 * The shared <Timestamp> primitive renders relative-to-now for PAST times
 * ("3h ago") and collapses everything future to "now" — wrong for an unlock
 * calendar. This renders the time UNTIL a future unlock ("in 2d 4h", "in 5h").
 */
export function fmtCountdown(unlockAt: number, now: number = Date.now()): string {
  const ms = unlockAt - now;
  if (ms <= 0) return "now";
  const mins = Math.floor(ms / 60_000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days >= 1) {
    const remH = hours - days * 24;
    return remH > 0 ? `in ${days}d ${remH}h` : `in ${days}d`;
  }
  if (hours >= 1) {
    const remM = mins - hours * 60;
    return remM > 0 ? `in ${hours}h ${remM}m` : `in ${hours}h`;
  }
  return `in ${Math.max(1, mins)}m`;
}
