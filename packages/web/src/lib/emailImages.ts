/**
 * Remote images in an email, which senders use to see that (and when, and
 * from where) a message was opened. Hidden until the reader shows them; then
 * they load through Missive's /img proxy (backend images.ts, edge
 * image-proxy.ts), never straight from the sender's server. The email's
 * frame also has a CSP that refuses anything else remote (wrapEmailHtml).
 */

const REMOTE = /^\s*(https?:)?\/\//i;
const CSS_URL = /url\(\s*(['"]?)(https?:\/\/[^'")\s]+|\/\/[^'")\s]+)\1\s*\)/gi;
/** A 1×1 transparent GIF, so a hidden image keeps its box without loading anything. */
const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const absolute = (url: string) => (url.trim().startsWith("//") ? `https:${url.trim()}` : url.trim());

function srcsetUrls(srcset: string): string[] {
  return srcset
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0] ?? "")
    .filter((u) => REMOTE.test(u))
    .map(absolute);
}

/** Every remote image URL in the email: <img>, srcset, background attributes and CSS url(). */
export function remoteImageUrls(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const urls = new Set<string>();
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>("[src], [srcset], [background], [poster]"))) {
    for (const attr of ["src", "background", "poster"]) {
      const v = el.getAttribute(attr);
      if (v && REMOTE.test(v) && (attr !== "src" || el.tagName === "IMG" || el.tagName === "INPUT" || el.tagName === "SOURCE")) urls.add(absolute(v));
    }
    const set = el.getAttribute("srcset");
    if (set) srcsetUrls(set).forEach((u) => urls.add(u));
  }
  for (const css of [...Array.from(doc.querySelectorAll("style")).map((s) => s.textContent ?? ""), ...Array.from(doc.querySelectorAll<HTMLElement>("[style]")).map((e) => e.getAttribute("style") ?? "")]) {
    for (const m of css.matchAll(CSS_URL)) urls.add(absolute(m[2]!));
  }
  return [...urls];
}

/**
 * The email with each remote image pointed at its proxy link (`proxied`), or
 * blanked when there's none (images hidden, or a URL the proxy wouldn't take).
 */
export function rewriteImages(html: string, proxied: Record<string, string> | null): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const swap = (url: string) => (proxied && proxied[absolute(url)]) || BLANK;
  const swapCss = (css: string) => css.replace(CSS_URL, (_m, _q, url: string) => (proxied && proxied[absolute(url)] ? `url("${proxied[absolute(url)]}")` : "none"));

  for (const el of Array.from(doc.querySelectorAll<HTMLElement>("[src], [srcset], [background], [poster]"))) {
    for (const attr of ["src", "background", "poster"]) {
      const v = el.getAttribute(attr);
      if (v && REMOTE.test(v)) el.setAttribute(attr, swap(v));
    }
    const set = el.getAttribute("srcset");
    if (set && srcsetUrls(set).length) {
      // A proxied srcset keeps its sizes; a hidden one is dropped (src stays blank).
      if (proxied) {
        el.setAttribute(
          "srcset",
          set
            .split(",")
            .map((part) => {
              const [url = "", ...rest] = part.trim().split(/\s+/);
              return REMOTE.test(url) ? [swap(url), ...rest].join(" ") : part.trim();
            })
            .join(", "),
        );
      } else {
        el.removeAttribute("srcset");
      }
    }
  }
  for (const style of Array.from(doc.querySelectorAll("style"))) style.textContent = swapCss(style.textContent ?? "");
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>("[style]"))) el.setAttribute("style", swapCss(el.getAttribute("style") ?? ""));
  // Prefetch and preload hints would fetch without showing anything.
  for (const link of Array.from(doc.querySelectorAll("link"))) link.remove();
  return doc.body ? doc.head.innerHTML + doc.body.innerHTML : html;
}

/** Proxy links for these URLs, signed by the API for the signed-in reader. */
export async function signImageUrls(urls: string[]): Promise<Record<string, string>> {
  if (!urls.length) return {};
  const res = await fetch("/api/v1/images/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls }),
  });
  if (!res.ok) throw new Error(`Couldn't load images (${res.status})`);
  return ((await res.json()) as { urls: Record<string, string> }).urls;
}
