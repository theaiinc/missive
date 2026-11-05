import { beforeAll, describe, expect, it } from "vitest";
import { draftNeedsEncryption, DraftUnreadableError, openDraft, sealDraft } from "../draft-crypto";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ID = "2f1d3c4b-5a69-4788-9abc-def012345678";
const ID2 = "3f1d3c4b-5a69-4788-9abc-def012345678";
const DRAFT = {
  mailbox: "me@example.com",
  payload: { to: "secret-recipient@example.com", subject: "Secret subject", html: "<p>Secret body</p>", text: "Secret body", attachments: [{ filename: "secret.pdf" }], threadId: "t1" },
};
const SECRETS = ["secret", "Secret", "me@example.com"];

beforeAll(() => {
  process.env.MISSIVE_DATA_KEY ??= "test-key-0123456789abcdef0123456789abcdef";
});

async function stored(ownerId = OWNER, id = ID) {
  const sealed = await sealDraft(ownerId, id, DRAFT);
  return { id, owner_id: ownerId, mailbox: sealed.mailbox, payload: JSON.parse(sealed.payload) as unknown, isEmpty: sealed.isEmpty };
}

async function failure(row: Parameters<typeof openDraft>[0]): Promise<unknown> {
  return openDraft(row).then(() => { throw new Error("decrypted"); }, (error: unknown) => error);
}

describe("draft encryption", () => {
  it("round-trips, and stores nothing of the draft in the clear", async () => {
    const row = await stored();
    const raw = JSON.stringify(row);
    for (const s of SECRETS) expect(raw).not.toContain(s);
    expect(row.payload).toMatch(/^mv1\./);
    expect(row.mailbox).toMatch(/^mv1\./);
    expect(row.isEmpty).toBe(false);
    expect(draftNeedsEncryption(row)).toBe(false);
    await expect(openDraft(row)).resolves.toEqual(DRAFT);
  });

  it("records an empty draft as empty", async () => {
    expect((await sealDraft(OWNER, ID, { mailbox: "me@example.com", payload: { html: "<p></p>" } })).isEmpty).toBe(true);
  });

  it("fails closed for another owner", async () => {
    const row = await stored();
    const error = await failure({ ...row, owner_id: OTHER });
    expect(error).toBeInstanceOf(DraftUnreadableError);
  });

  it("fails closed when the ciphertext is copied to another draft", async () => {
    const row = await stored();
    expect(await failure({ ...row, id: ID2 })).toBeInstanceOf(DraftUnreadableError);
    // Even only the payload, under a mailbox sealed for the other draft.
    const other = await stored(OWNER, ID2);
    expect(await failure({ ...other, payload: row.payload })).toBeInstanceOf(DraftUnreadableError);
  });

  it("fails closed for a tampered ciphertext, with an error that carries no content", async () => {
    const row = await stored();
    const p = row.payload as string;
    const flipped = p.slice(0, -2) + (p.at(-2) === "A" ? "B" : "A") + p.at(-1);
    const error = await failure({ ...row, payload: flipped });
    expect(error).toBeInstanceOf(DraftUnreadableError);
    expect((error as Error).message).toBe(`Draft ${ID} could not be decrypted`);
    expect((error as Error).cause).toBeUndefined();
    // A JSON string that isn't ciphertext isn't taken as a payload either.
    expect(await failure({ ...row, payload: "Secret subject" })).toBeInstanceOf(DraftUnreadableError);
  });

  it("reads a draft saved before encryption", async () => {
    const plain = { id: ID, owner_id: OWNER, mailbox: DRAFT.mailbox, payload: DRAFT.payload };
    expect(draftNeedsEncryption(plain)).toBe(true);
    await expect(openDraft(plain)).resolves.toEqual(DRAFT);
  });
});
