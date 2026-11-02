import { describe, expect, it, vi } from "vitest";
import { SyncService } from "../sync.service";

const b64 = (value: string) => Buffer.from(value).toString("base64url");

describe("Gmail attachment MIME discovery", () => {
  it("recursively saves nested attachments, decodes RFC 2231 names, and keeps non-inline Content-ID files", async () => {
    const saved: any[] = [];
    const storage = {
      saveAttachments: vi.fn(async (_missiveId: string, attachments: any[]) => {
        saved.push(...attachments);
      }),
    };
    const store = { list: vi.fn(async () => []) };
    const service = new SyncService(store as any, storage as any, {} as any, {} as any);

    const gmail = {
      users: {
        messages: {
          attachments: {
            get: vi.fn(async ({ id }: { id: string }) => ({
              data: { data: b64(`file-${id}`) },
            })),
          },
        },
      },
    } as any;

    const payload = {
      mimeType: "multipart/related",
      parts: [
        {
          mimeType: "text/html",
          body: { data: b64('<img src="cid:inline-image">') },
        },
        {
          mimeType: "multipart/mixed",
          parts: [
            {
              mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              filename: "attachment",
              headers: [
                { name: "Content-Disposition", value: "attachment; filename*=UTF-8''T%C3%A0i%20li%E1%BB%87u.docx" },
                { name: "Content-ID", value: "<not-inline>" },
              ],
              body: { attachmentId: "docx-1", size: 8 },
            },
            {
              mimeType: "image/png",
              filename: "inline.png",
              headers: [
                { name: "Content-Disposition", value: "inline; filename=\"inline.png\"" },
                { name: "Content-ID", value: "<inline-image>" },
              ],
              body: { attachmentId: "image-1", size: 8 },
            },
          ],
        },
      ],
    };

    await (service as any).saveGmailAttachments(
      gmail,
      "gmail-message-1",
      "missive-1",
      payload,
      '<img src="cid:inline-image">',
    );

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      filename: "Tài liệu.docx",
    });
    expect(saved[0].content).toBeInstanceOf(Buffer);
    expect(storage.saveAttachments).toHaveBeenCalledWith(
      "missive-1",
      expect.arrayContaining([
        expect.objectContaining({ filename: "Tài liệu.docx" }),
      ]),
    );
    expect(saved[0].content.toString()).toBe("file-docx-1");
  });
});