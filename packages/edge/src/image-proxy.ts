/**
 * Remote images in mail, fetched here instead of by the reader's browser
 * (GET /img?u=…&e=…&s=…), so a sender's tracking pixel sees Cloudflare, not
 * the reader's IP address or browser. Only URLs the API signed for a
 * signed-in reader are fetched (s = HMAC-SHA256 of "u|e" with EDGE_SECRET,
 * see backend images.ts), so this isn't an open proxy; only images come back.
 */
const MAX_BYTES = 10 * 1024 * 1024;

const enc = new TextEncoder();

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const deny = (status: number, text: string) =>
  new Response(text, { status, headers: { "content-type": "text/plain", "cache-control": "no-store" } });

export async function imageProxy(url: URL, secret: string | undefined): Promise<Response> {
  const u = url.searchParams.get("u") ?? "";
  const e = url.searchParams.get("e") ?? "";
  const s = url.searchParams.get("s") ?? "";
  if (!secret || !u || !/^\d+$/.test(e) || !s) return deny(400, "Bad image link");
  if (Number(e) * 1000 < Date.now()) return deny(410, "Image link expired");
  if (!sameHex(await hmacHex(secret, `${u}|${e}`), s)) return deny(403, "Bad image link");

  let target: URL;
  try {
    target = new URL(u);
  } catch {
    return deny(400, "Bad image link");
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") return deny(400, "Bad image link");

  let res: Response;
  try {
    // No cookies, no referrer, a generic agent: the sender learns only that someone fetched it.
    res = await fetch(target.toString(), {
      headers: { "user-agent": "Mozilla/5.0 (compatible; MissiveImageProxy/1.0)", accept: "image/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return deny(502, "Couldn't fetch the image");
  }
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.toLowerCase().startsWith("image/")) return deny(502, "Not an image");
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) return deny(413, "Image too large");

  // Count bytes as they stream, and stop past the limit even without a length header.
  let seen = 0;
  const limit = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > MAX_BYTES) controller.error(new Error("too large"));
      else controller.enqueue(chunk);
    },
  });
  return new Response(res.body?.pipeThrough(limit) ?? null, {
    headers: {
      // An SVG can carry script; served as an image under this CSP it can't run or load anything.
      "content-type": type,
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=86400",
      "referrer-policy": "no-referrer",
    },
  });
}
