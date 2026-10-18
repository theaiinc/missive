// The web view has no Notification API and no web push, so the page's
// `new Notification(...)` (web/src/hooks/useNotifications.ts) would do nothing.
// This stands in for it and shows a macOS notification (src/mac_notify.rs,
// through the app's commands in main.rs), and puts the unread count on the Dock icon. Only on
// Missive's own pages.
(() => {
  if (location.origin !== "https://missive.theaiinc.com") return;
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);

  let permission = "default";
  invoke("notification_permission")
    .then((state) => { permission = state; })
    .catch(() => {});

  class MissiveNotification extends EventTarget {
    static get permission() { return permission; }
    static async requestPermission(callback) {
      try {
        permission = await invoke("request_notification_permission");
      } catch {
        permission = "denied";
      }
      if (typeof callback === "function") callback(permission);
      return permission;
    }
    constructor(title, options = {}) {
      super();
      this.title = String(title);
      this.body = options.body ?? "";
      this.onclick = this.onclose = this.onerror = this.onshow = null;
      if (permission === "granted") {
        invoke("notify", { title: this.title, body: this.body }).catch(() => {});
      }
    }
    close() {}
  }

  Object.defineProperty(window, "Notification", { value: MissiveNotification, configurable: true, writable: true });

  // The unread count on the Dock icon (web/src/lib/badge.ts uses the Badging API).
  const badge = (value) => invoke("plugin:window|set_badge_count", { label: "main", value }).catch(() => {});
  navigator.setAppBadge = (count) => badge(count > 0 ? Math.floor(count) : null);
  navigator.clearAppBadge = () => badge(null);
})();
