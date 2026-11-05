import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftSaver, draftIsEmpty, draftTitle, type DraftBody, type SaveRequest } from "../draftSaver";

const body = (payload: DraftBody["payload"]): DraftBody => ({ mailbox: "me@example.test", payload });

/** A request whose calls resolve or reject only when the test says so. */
function controlledRequest() {
  const calls: Array<{ id: string; body: DraftBody; keepalive: boolean; resolve: () => void; reject: () => void }> = [];
  const request = vi.fn<SaveRequest>(
    (id, b, { keepalive }) =>
      new Promise((resolve, reject) => {
        calls.push({ id, body: b, keepalive, resolve: () => resolve({ id }), reject: () => reject(new Error("offline")) });
      }),
  );
  return { request, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("draftIsEmpty", () => {
  it("counts recipients, subject, message and attachments, not the signature or quote", () => {
    expect(draftIsEmpty({})).toBe(true);
    expect(draftIsEmpty({ html: "<p></p>", text: "-- \nSteve", tail: "-- \nSteve", quote: "> hi" })).toBe(true);
    expect(draftIsEmpty({ to: "a@b.c" })).toBe(false);
    expect(draftIsEmpty({ bcc: "a@b.c" })).toBe(false);
    expect(draftIsEmpty({ subject: "Hi" })).toBe(false);
    expect(draftIsEmpty({ html: "<p>Hi</p>" })).toBe(false);
    expect(draftIsEmpty({ attachments: [{ filename: "a.pdf", mimeType: "application/pdf" }] })).toBe(false);
  });
});

describe("draftTitle", () => {
  it("is the subject, else the first line written", () => {
    expect(draftTitle({ subject: " Plan " })).toBe("Plan");
    expect(draftTitle({ html: "<p></p><p>Tom &amp; Jerry</p><p>second</p>" })).toBe("Tom & Jerry");
    expect(draftTitle({})).toBe("(no subject)");
  });
});

describe("DraftSaver change detection", () => {
  it("never creates an empty draft", async () => {
    const { request } = controlledRequest();
    const saver = new DraftSaver({ request });
    await saver.save(body({ html: "", tail: "-- \nSteve" }));
    saver.flush(body({ html: "" }));
    expect(request).not.toHaveBeenCalled();
  });

  it("saves a payload once, and again only when it changes", async () => {
    const request = vi.fn<SaveRequest>(async (id) => ({ id }));
    const saver = new DraftSaver({ request });
    await saver.save(body({ subject: "Hi" }));
    await saver.save(body({ subject: "Hi" }));
    saver.flush(body({ subject: "Hi" }));
    expect(request).toHaveBeenCalledTimes(1);
    await saver.save(body({ subject: "Hi there" }));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("saves nothing when a reopened draft is unchanged", async () => {
    const request = vi.fn<SaveRequest>(async (id) => ({ id }));
    const saved = body({ to: "a@b.c", html: "<p>x</p>" });
    const saver = new DraftSaver({ request, id: "draft-1", saved });
    await saver.save(body({ to: "a@b.c", html: "<p>x</p>" }));
    expect(request).not.toHaveBeenCalled();
    await saver.save(body({ to: "a@b.c", html: "" }));
    // A draft you have may be emptied; it's an edit.
    expect(request).toHaveBeenCalledWith("draft-1", body({ to: "a@b.c", html: "" }), { keepalive: false });
  });
});

describe("DraftSaver serialization", () => {
  it("keeps one save in flight, then sends only the newest waiting payload, under one id", async () => {
    const { request, calls } = controlledRequest();
    const saver = new DraftSaver({ request });
    const first = saver.save(body({ subject: "a" }));
    void saver.save(body({ subject: "ab" }));
    void saver.save(body({ subject: "abc" }));
    expect(calls).toHaveLength(1);
    calls[0]!.resolve();
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.payload.subject).toBe("abc");
    expect(calls[1]!.id).toBe(calls[0]!.id);
    calls[1]!.resolve();
    await first;
    expect(calls).toHaveLength(2);
    expect(saver.exists).toBe(true);
  });

  it("leaving the page during a save sends the newest payload with keepalive, same id", async () => {
    const { request, calls } = controlledRequest();
    const saver = new DraftSaver({ request });
    void saver.save(body({ subject: "a" }));
    saver.flush(body({ subject: "ab" }));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ id: calls[0]!.id, keepalive: true, body: body({ subject: "ab" }) });
  });

  it("uses the id the API returns", async () => {
    const request = vi.fn<SaveRequest>(async () => ({ id: "from-server" }));
    const saver = new DraftSaver({ request });
    await saver.save(body({ subject: "a" }));
    await saver.save(body({ subject: "b" }));
    expect(request.mock.calls[1]![0]).toBe("from-server");
  });
});

describe("DraftSaver retry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retries after 2 s, 5 s, then every 15 s, with the newest payload", async () => {
    const statuses: string[] = [];
    const request = vi.fn<SaveRequest>().mockRejectedValue(new Error("offline"));
    const saver = new DraftSaver({ request, onStatus: (s) => statuses.push(s) });
    await saver.save(body({ subject: "a" }));
    expect(request).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toBe("error");

    // Edits while a retry is waiting don't hammer the API; they ride the retry.
    await saver.save(body({ subject: "ab" }));
    expect(request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]![1].payload.subject).toBe("ab");

    await vi.advanceTimersByTimeAsync(4_999);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(request).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(request).toHaveBeenCalledTimes(5);

    request.mockImplementation(async (id) => ({ id }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(request).toHaveBeenCalledTimes(6);
    expect(statuses.at(-1)).toBe("saved");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(6);
  });

  it("closing the window tries straight away instead of waiting for the retry", async () => {
    const request = vi.fn<SaveRequest>().mockRejectedValueOnce(new Error("offline")).mockImplementation(async (id) => ({ id }));
    const saver = new DraftSaver({ request });
    await saver.save(body({ subject: "a" }));
    await saver.save(body({ subject: "a" }), { now: true });
    expect(request).toHaveBeenCalledTimes(2);
    expect(saver.retrying).toBe(false);
  });

  it("stops retrying once the draft is sent or discarded", async () => {
    const request = vi.fn<SaveRequest>().mockRejectedValue(new Error("offline"));
    const saver = new DraftSaver({ request });
    await saver.save(body({ subject: "a" }));
    saver.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("reopening a saved draft", () => {
  it("restores everything, keeps its id, and saves nothing until it changes", async () => {
    const { draftFromStored } = await import("../draftSaver");
    const payload = { from: "me@example.test", to: "a@b.c", cc: "c@d.e", bcc: "", subject: "Re: Plan", html: "<p>Sure</p>", text: "Sure\n\n> plan?", tail: "> plan?", quote: "> plan?", replyTo: "m1", threadId: "t1", attachments: [{ filename: "a.pdf", mimeType: "application/pdf", size: 3 }] };
    const stored = { id: "draft-1", mailbox: "me@example.test", payload, updatedAt: "", createdAt: "" };
    const draft = draftFromStored(stored);
    expect(draft).toMatchObject({ id: "draft-1", from: "me@example.test", to: "a@b.c", cc: "c@d.e", subject: "Re: Plan", html: "<p>Sure</p>", text: "> plan?", tail: "> plan?", replyTo: "m1", threadId: "t1", attachments: payload.attachments });

    const request = vi.fn<SaveRequest>(async (id) => ({ id }));
    const saver = new DraftSaver({ request, id: draft.id, saved: draft.saved });
    // The database hands keys back in another order; that's still the same draft.
    const reordered = Object.fromEntries(Object.entries(payload).reverse());
    await saver.save({ payload: reordered, mailbox: "me@example.test" });
    expect(request).not.toHaveBeenCalled();
  });
});
