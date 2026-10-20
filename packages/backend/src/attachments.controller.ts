import { Controller, Get, NotFoundException, Param, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { StorageService } from "./storage/storage.service";

/**
 * Types shown in the browser when asked (?inline=1): pictures and PDFs, which
 * can't run script on this site. Everything else is only ever downloaded: an
 * HTML or SVG attachment opened in place would run as missive.theaiinc.com.
 */
const VIEWABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);

/** RFC 6266: an ASCII fallback plus the UTF-8 name. */
function disposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

@Controller("api/v1/attachments")
export class AttachmentsController {
  constructor(private readonly storage: StorageService) {}

  /** A file on one of the signed-in person's messages (row-level security keeps it theirs). */
  @Get(":id")
  async get(@Param("id") id: string, @Query("inline") inline: string | undefined, @Res() res: Response) {
    const file = await this.storage.getAttachment(id);
    if (!file) throw new NotFoundException("No such attachment");
    const viewable = inline === "1" && VIEWABLE.has(file.mimeType);
    res.set({
      "Content-Type": viewable ? file.mimeType : "application/octet-stream",
      "Content-Length": String(file.content.length),
      "Content-Disposition": disposition(viewable ? "inline" : "attachment", file.filename),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      "Cache-Control": "private, max-age=3600",
    });
    res.end(file.content);
  }
}
