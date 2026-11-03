import { useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { Bold, Italic, Link as LinkIcon, List, ListOrdered, Unlink } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Plain text (an AI draft, a signature, a quote) as HTML paragraphs, line breaks kept. */
export const textToHtml = (text: string) =>
  text.trim() ? text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("") : "";

/** What you've written, as plain text: paragraphs apart by a blank line. */
export const editorText = (editor: Editor | null) => editor?.getText({ blockSeparator: "\n\n" }) ?? "";

/** The editor for a message's body: bold, italics, links and lists (Markdown shortcuts like "- " and "**" work too). */
export function useMessageEditor({ text, autofocus }: { text?: string; autofocus?: boolean }) {
  return useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Link.configure({ openOnClick: false, autolink: true, defaultProtocol: "https", protocols: ["mailto"] }),
    ],
    content: textToHtml(text ?? ""),
    autofocus: autofocus ? "start" : false,
    editorProps: {
      attributes: {
        "aria-label": "Message",
        class:
          "prose prose-sm dark:prose-invert max-w-none min-h-[12rem] px-3 py-2 leading-relaxed focus:outline-none [&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2",
      },
    },
  });
}

function ToolButton({ active, label, onClick, children }: { active?: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      // Keep the selection in the editor.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn("p-1.5 rounded text-muted-foreground hover:bg-muted hover:text-foreground", active && "bg-muted text-foreground")}
    >
      {children}
    </button>
  );
}

export function MessageEditor({ editor }: { editor: Editor | null }) {
  const [link, setLink] = useState<string | null>(null);
  if (!editor) return null;
  const mod = /Mac|iP(hone|ad)/.test(navigator.platform) ? "⌘" : "Ctrl+";
  const applyLink = () => {
    const href = (link ?? "").trim();
    const chain = editor.chain().focus().extendMarkRange("link");
    if (!href) chain.unsetLink().run();
    else {
      const url = /^(https?:|mailto:)/i.test(href) ? href : href.includes("@") && !href.includes("/") ? `mailto:${href}` : `https://${href}`;
      // With nothing selected, the address becomes the link's text.
      if (editor.state.selection.empty && !editor.isActive("link")) chain.insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href: url } }] }).run();
      else chain.setLink({ href: url }).run();
    }
    setLink(null);
  };
  return (
    <div className="rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring">
      <div className="flex items-center gap-0.5 border-b border-input px-1.5 py-1" role="toolbar" aria-label="Formatting">
        <ToolButton label={`Bold (${mod}B)`} active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}>
          <Bold className="w-4 h-4" />
        </ToolButton>
        <ToolButton label={`Italic (${mod}I)`} active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}>
          <Italic className="w-4 h-4" />
        </ToolButton>
        <ToolButton label="Link" active={editor.isActive("link")} onClick={() => setLink(link === null ? editor.getAttributes("link").href ?? "" : null)}>
          <LinkIcon className="w-4 h-4" />
        </ToolButton>
        {editor.isActive("link") && (
          <ToolButton label="Remove link" onClick={() => editor.chain().focus().extendMarkRange("link").unsetLink().run()}>
            <Unlink className="w-4 h-4" />
          </ToolButton>
        )}
        <span className="mx-1 h-4 w-px bg-border" />
        <ToolButton label="Bulleted list" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}>
          <List className="w-4 h-4" />
        </ToolButton>
        <ToolButton label="Numbered list" active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
          <ListOrdered className="w-4 h-4" />
        </ToolButton>
      </div>
      {link !== null && (
        <div className="flex items-center gap-2 border-b border-input px-2 py-1.5">
          <Input
            autoFocus
            value={link}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyLink();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setLink(null);
                editor.commands.focus();
              }
            }}
            placeholder="https://example.com"
            className="h-8 text-sm"
            aria-label="Link address"
          />
          <button type="button" onClick={applyLink} className="text-xs font-medium px-2 py-1 rounded hover:bg-muted">
            Apply
          </button>
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}
