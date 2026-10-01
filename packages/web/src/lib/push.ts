/**
 * Push notifications for new mail (public/sw.js, backend push.service.ts):
 * they arrive with Missive closed. On iPhone and iPad they need Missive added
 * to the Home Screen first (Safari → Share → Add to Home Screen).
 */

export type PushState = "unsupported" | "needs-install" | "unavailable" | "denied" | "off" | "on";

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

function urlBase64ToBytes(base64: string): ArrayBuffer {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)).buffer;
}

async function serverKey(): Promise<string> {
  const res = await fetch("/api/v1/push/key");
  if (!res.ok) return "";
  return ((await res.json()) as { publicKey?: string }).publicKey ?? "";
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return (await navigator.serviceWorker.getRegistration("/")) ?? navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

/** The quiet subscribe on load (refreshPush), which pushState waits for so it doesn't report "off" meanwhile. */
let refreshing: Promise<boolean> = Promise.resolve(false);

export async function pushState(): Promise<PushState> {
  await refreshing;
  if (!("serviceWorker" in navigator) || !("Notification" in window)) return isIos() && !standalone() ? "needs-install" : "unsupported";
  if (!("PushManager" in window)) return isIos() && !standalone() ? "needs-install" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (!(await serverKey())) return "unavailable";
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

/** Asks for permission (call from a click) and subscribes this browser. */
export async function enablePush(): Promise<PushState> {
  if (Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") return pushState();
  const key = await serverKey();
  if (!key) return "unavailable";
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(key) }));
  await fetch("/api/v1/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  });
  return "on";
}

export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await fetch("/api/v1/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    await sub.unsubscribe();
  }
  return pushState();
}

/**
 * On load: a browser that already allowed notifications is (re)subscribed
 * quietly, so the server always has a current subscription for it. True
 * when push is on (the page then leaves system notifications to it).
 */
export function refreshPush(): Promise<boolean> {
  refreshing = (async () => {
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || Notification.permission !== "granted") return false;
      return (await enablePush()) === "on";
    } catch {
      return false;
    }
  })();
  return refreshing;
}
