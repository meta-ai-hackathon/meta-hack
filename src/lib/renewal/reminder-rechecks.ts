import { useEffect, useState } from "react";

/**
 * When to read the saved reminder again (BN-22 / HACK-50, third review).
 *
 * Another tab can save, change, or remove the reminder at any time, and
 * nothing tells this tab. The banner used to read the store only when the
 * page or the device's day changed, so a tab left on a page kept a banner
 * another tab had removed, or stayed silent after another tab saved a due
 * date, until midnight or a reload. Coming back to a tab is when a stale
 * banner would be seen, so the banner reads the store again whenever the
 * window gets focus or the tab becomes visible, whether or not the day
 * changed.
 */

/** Calls `onRecheck` on every focus and every return to a visible tab. Browser-only. */
export function subscribeToReminderRechecks(onRecheck: () => void): () => void {
  const onVisibility = () => {
    if (document.visibilityState === "visible") {
      onRecheck();
    }
  };
  const onFocus = () => onRecheck();
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onFocus);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", onFocus);
  };
}

/** A count that goes up on every recheck, for an effect to depend on. 0 on the server. */
export function useReminderRechecks(): number {
  const [count, setCount] = useState(0);
  useEffect(() => subscribeToReminderRechecks(() => setCount((value) => value + 1)), []);
  return count;
}
