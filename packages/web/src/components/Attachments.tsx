import { Download, FileText, Paperclip } from "lucide-react";
import type { Missive } from "@theaiinc/missive-core";

type File = NonNullable<Missive["attachments"]>[number];

/** What the API shows in place (attachments.controller.ts); the rest only downloads. */
const PICTURE = /^image\/(png|jpeg|gif|webp)$/;
const viewable = (f: File) => PICTURE.test(f.mimeType) || f.mimeType === "application/pdf";

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const url = (f: File, inline = false) => `/api/v1/attachments/${encodeURIComponent(f.id)}${inline ? "?inline=1" : ""}`;

/** A message's files: pictures as thumbnails, everything else as a named chip. */
export function Attachments({ files }: { files?: File[] }) {
  if (!files?.length) return null;
  return (
    <div className="px-4 py-3 border-t border-border">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
        <Paperclip className="w-3.5 h-3.5" />
        {files.length === 1 ? "1 attachment" : `${files.length} attachments`}
      </p>
      <div className="flex flex-wrap gap-2">
        {files.map((f) => (
          <div key={f.id} className="group flex items-center gap-2 rounded-md border border-border bg-muted/30 pr-1 max-w-full">
            <a
              href={url(f, viewable(f))}
              {...(viewable(f) ? { target: "_blank", rel: "noopener noreferrer" } : { download: f.filename })}
              className="flex items-center gap-2 min-w-0 py-1.5 pl-1.5"
              title={viewable(f) ? `Open ${f.filename}` : `Download ${f.filename}`}
            >
              {PICTURE.test(f.mimeType) ? (
                <img src={url(f, true)} alt="" loading="lazy" className="w-10 h-10 rounded object-cover shrink-0 bg-muted" />
              ) : (
                <FileText className="w-8 h-8 p-1.5 text-muted-foreground shrink-0" />
              )}
              <span className="min-w-0">
                <span className="block text-xs font-medium truncate max-w-[14rem]">{f.filename}</span>
                <span className="block text-[11px] text-muted-foreground">{formatSize(f.size)}</span>
              </span>
            </a>
            <a href={url(f)} download={f.filename} className="p-1.5 text-muted-foreground hover:text-foreground shrink-0" aria-label={`Download ${f.filename}`}>
              <Download className="w-4 h-4" />
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
