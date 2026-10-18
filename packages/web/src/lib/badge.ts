/**
 * The unread count on the app's icon: the Dock in the desktop app (its
 * notifications.js bridges this) and an installed Chrome or Edge app.
 * Browsers without the Badging API ignore it.
 */
export function setAppBadge(count: number) {
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  try {
    const done = count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.();
    done?.catch(() => {});
  } catch { /* not allowed here */ }
}
