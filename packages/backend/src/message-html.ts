import { Parser } from "htmlparser2";
import { convert } from "html-to-text";

/**
 * The HTML of messages people write in Compose. The editor sends HTML; it's
 * cut down to an allowlist of formatting (bold, italics, links, lists, quotes)
 * before it leaves, and the plain-text part is made from what's left.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const FONT = "font:15px/1.6 -apple-system,Segoe UI,Inter,sans-serif";

/** The HTML part of a message written as plain text: paragraphs, with line breaks kept. */
export const textToHtml = (text: string) =>
  `<div style="${FONT}">${text
    .split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, "<br>")}</p>`).join("")}</div>`;

/** Tags kept, with the inline style mail apps need to show them as the editor did. */
const ALLOWED: Record<string, string> = {
  p: "margin:0 0 14px",
  br: "",
  strong: "",
  b: "",
  em: "",
  i: "",
  u: "",
  s: "",
  code: "font-family:Menlo,Consolas,monospace;font-size:90%",
  pre: "margin:0 0 14px;font-family:Menlo,Consolas,monospace;font-size:13px;white-space:pre-wrap",
  blockquote: "margin:0 0 14px;padding-left:12px;border-left:3px solid #d0d7de;color:#57606a",
  ul: "margin:0 0 14px;padding-left:24px",
  ol: "margin:0 0 14px;padding-left:24px",
  li: "margin:0 0 4px",
  a: "",
  h1: "margin:0 0 14px;font-size:22px",
  h2: "margin:0 0 14px;font-size:19px",
  h3: "margin:0 0 14px;font-size:17px",
  hr: "border:none;border-top:1px solid #d0d7de;margin:14px 0",
};
const VOID = new Set(["br", "hr"]);
/** Dropped with everything inside them, not just the tags. */
const DROP = new Set(["script", "style", "head", "title", "iframe", "object", "embed", "noscript", "template", "svg", "math", "textarea", "select"]);
/** Headings past h3 are kept as h3. */
const ALIAS: Record<string, string> = { h4: "h3", h5: "h3", h6: "h3", strike: "s", del: "s" };

/** Links may go to the web or to an address; nothing that runs (javascript:, data:, …). */
const safeHref = (href: string) => {
  const h = href.trim();
  return /^(https?:|mailto:)/i.test(h) ? h : null;
};

/** Client HTML cut down to the formatting a message can carry: no scripts, styles, handlers or images. */
export function sanitizeHtml(html: string): string {
  let out = "";
  // Open tags, innermost last; a link that wasn't safe is open but writes no tags.
  const open: { tag: string; written: boolean }[] = [];
  let dropping = 0;
  const parser = new Parser(
    {
      onopentag(raw, attrs) {
        if (DROP.has(raw)) dropping++;
        if (dropping) return;
        const tag = ALIAS[raw] ?? raw;
        if (!(tag in ALLOWED)) return;
        // The editor puts each list item's text in a <p>; inside an item it takes no extra space.
        const css = tag === "p" && open.at(-1)?.tag === "li" ? "margin:0" : ALLOWED[tag];
        const style = css ? ` style="${css}"` : "";
        if (tag === "a") {
          // A link without a safe target keeps its text, not the link.
          const href = attrs.href ? safeHref(attrs.href) : null;
          if (href) out += `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">`;
          open.push({ tag, written: !!href });
          return;
        }
        const start = tag === "ol" && /^\d{1,6}$/.test(attrs.start ?? "") ? ` start="${attrs.start}"` : "";
        out += `<${tag}${start}${style}>`;
        if (!VOID.has(tag)) open.push({ tag, written: true });
      },
      ontext(text) {
        if (!dropping) out += esc(text);
      },
      onclosetag(raw) {
        if (DROP.has(raw)) {
          if (dropping) dropping--;
          return;
        }
        if (dropping) return;
        const tag = ALIAS[raw] ?? raw;
        const at = open.map((o) => o.tag).lastIndexOf(tag);
        if (at < 0) return;
        // Close it, and anything left open inside it.
        for (const o of open.splice(at).reverse()) if (o.written) out += `</${o.tag}>`;
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true }
  );
  parser.write(html);
  parser.end();
  for (const o of open.reverse()) if (o.written) out += `</${o.tag}>`;
  return out;
}

/** The plain-text part for formatted HTML: lists keep their bullets and numbers, links show where they go. */
export const htmlToText = (html: string) =>
  convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
      { selector: "li > p", format: "inline" },
      { selector: "h1", options: { uppercase: false } },
      { selector: "h2", options: { uppercase: false } },
      { selector: "h3", options: { uppercase: false } },
    ],
  })
    .trim()
    // Mail clients recognize "-- " as the signature delimiter; html-to-text
    // removes trailing whitespace, so restore it at the start of a line.
    .replace(/^--(?=\r?\n|$)/gm, "-- "); 

/**
 * A message's text and HTML parts. With `html` (formatted in Compose) it's
 * sanitized and the plain text is made from it; with only `text`, as before,
 * the HTML is that text in paragraphs.
 */
export function messageBody({ text, html }: { text: string; html?: string }): { text: string; html: string } {
  if (html === undefined) return { text, html: textToHtml(text) };
  const clean = sanitizeHtml(html);
  return { text: htmlToText(clean), html: `<div style="${FONT}">${clean}</div>` };
}
