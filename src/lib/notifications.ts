/**
 * Thin wrapper around the browser Notification API. All functions are safe to
 * call during SSR / where notifications aren't available — they no-op.
 */
export function canNotify(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export async function requestNotificationPermission(): Promise<void> {
  if (!canNotify()) return;
  try {
    if (Notification.permission === "default") {
      await Notification.requestPermission();
    }
  } catch {
    /* some browsers reject without a user gesture — ignore */
  }
}

export function notify(title: string, body: string): void {
  if (!canNotify() || Notification.permission !== "granted") return;
  try {
    // `tag` collapses repeated notifications for the same channel/DM.
    new Notification(title, { body, tag: title });
  } catch {
    /* ignore */
  }
}
