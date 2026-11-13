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

  // Shown notifications by key, so a click (main.rs) reaches the page's onclick.
  const shown = new Map();
  let next = 0;

  // A notification clicked in macOS: its own onclick if this page made it,
  // else the app routes there ("missive:open", useNotifications.ts), else a
  // plain navigation.
  window.__missiveNotificationClicked = (key, url) => {
    const note = shown.get(key);
    shown.delete(key);
    if (note && (note.onclick || note.listens)) {
      const click = new Event("click", { cancelable: true });
      if (typeof note.onclick === "function") note.onclick(click);
      note.dispatchEvent(click);
      return;
    }
    const open = new CustomEvent("missive:open", { detail: url, cancelable: true });
    window.dispatchEvent(open);
    if (!open.defaultPrevented) location.assign(url);
  };

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
      this.tag = options.tag ?? "";
      this.data = options.data ?? null;
      this.onclick = this.onclose = this.onerror = this.onshow = null;
      const path = typeof this.data?.url === "string" && this.data.url.startsWith("/") && !this.data.url.startsWith("//") ? this.data.url : "/inbox";
      // One per tag (a conversation): a newer one replaces it, in macOS too.
      const key = (this.tag || `n${next++}`).replace(/\|/g, "_");
      shown.set(key, this);
      if (shown.size > 100) shown.delete(shown.keys().next().value);
      if (permission === "granted") {
        invoke("notify", { title: this.title, body: this.body, key, url: path }).catch(() => {});
      }
    }
    addEventListener(type, ...rest) {
      if (type === "click") this.listens = true;
      super.addEventListener(type, ...rest);
    }
    close() {}
  }

  Object.defineProperty(window, "Notification", { value: MissiveNotification, configurable: true, writable: true });

  // The unread count on the Dock icon (web/src/lib/badge.ts uses the Badging API).
  const badge = (value) => invoke("plugin:window|set_badge_count", { label: "main", value }).catch(() => {});
  navigator.setAppBadge = (count) => badge(count > 0 ? Math.floor(count) : null);
  navigator.clearAppBadge = () => badge(null);
})();
