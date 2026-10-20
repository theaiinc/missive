import { describe, expect, it } from "vitest";
import { folderFor, parseClassifications } from "../organizer.service";

describe("reading the classifier's answer", () => {
  it("copes with the shapes models answer in", () => {
    const text = [
      // The example's own words copied: the label sits where the folder should.
      "IDX0 classification=notification|GitHub CI run failed",
      "**IDX1**: newsletter=archived|weekly digest",
      "- IDX2|other|inbox|a colleague asking for a review",
      "IDX3 | invoice | invoices | receipt",
      "IDX4|other|leads|wants a quote",
      "IDX5 not sure what this is",
    ].join("\n");
    expect(parseClassifications(text, 6)).toEqual([
      { classification: "notification", folder: null },
      { classification: "newsletter", folder: "archived" },
      { classification: "other", folder: "inbox" },
      { classification: "invoice", folder: "invoices" },
      { classification: "other", folder: "leads" },
      null,
    ]);
  });

  it("never gives IDX1 the answer meant for IDX10", () => {
    const text = "IDX10|spam|spam|scam\nIDX1|personal|inbox|from a friend";
    const answers = parseClassifications(text, 11);
    expect(answers[1]).toEqual({ classification: "personal", folder: "inbox" });
    expect(answers[10]).toEqual({ classification: "spam", folder: "spam" });
  });
});

describe("where a labelled message goes", () => {
  it("keeps mail in the inbox unless it's clearly something else", () => {
    // What every message became from Sep 25, 2026: archived. Now it stays.
    expect(folderFor("other", null)).toBe("inbox");
    expect(folderFor("notification", null)).toBe("inbox");
    expect(folderFor("meeting", "archived")).toBe("inbox");
    expect(folderFor("newsletter", "archived")).toBe("archived");
    expect(folderFor("invoice", null)).toBe("invoices");
    expect(folderFor("spam", null)).toBe("spam");
    expect(folderFor("other", "leads")).toBe("leads");
    expect(folderFor("support", "complaints")).toBe("complaints");
  });
});
