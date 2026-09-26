import { openRow, openRows, seal, sealJson } from "./storage/content-crypto";
import { llmBaseUrl, llmHeaders, llmModel } from "./llm";
import { safeError } from "./log-safe";
import { Injectable, Logger } from "@nestjs/common";
import { MISSIVE_LIST_COLUMNS, StorageService } from "./storage/storage.service";
import { PostgresService } from "./storage/postgres.service";
import { SystemEventService } from "./system-event.service";

/** Messages classified per model call. */
const BATCH_SIZE = 15;
const DIGEST_INTERVAL_MS = 60 * 60 * 1000;
const organizerSince = (): string | null => {
  const v = process.env.ORGANIZER_SINCE;
  return v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;
};

export interface DigestItem {
  threadId: string;
  subject: string;
  sender: string;
  importance: "high" | "medium" | "low";
  reason: string;
  classification: string;
}

export interface Digest {
  id: string;
  summary: string;
  items: DigestItem[];
  periodStart: string;
  periodEnd: string;
  missiveCount: number;
  createdAt: string;
}

interface ClassifyResult {
  classification: string;
  folder: string | null;
}

@Injectable()
export class OrganizerService {
  private readonly logger = new Logger(OrganizerService.name);
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private _isRunning = false;

  /** Whether the organizer is currently processing missives. */
  get isRunning(): boolean {
    return this._isRunning;
  }

  constructor(
    private readonly storage: StorageService,
    private readonly pg: PostgresService,
    private readonly events: SystemEventService
  ) {
    this.baseUrl = llmBaseUrl();
    this.model = llmModel();
    this.timeoutMs = parseInt(process.env.LM_STUDIO_TIMEOUT_MS ?? "120000", 10);
  }

  /**
   * Process all unclassified missives: classify, tag, move to folders.
   * Also catches missives that were classified but never moved to the correct folder
   * (e.g. due to a bug in an older version of the classifier).
   * Uses batch AI for efficiency.
   */
  async processNewMissives(limit = 20): Promise<number> {
    if (this._isRunning) return 0;
    this._isRunning = true;
    try {
      // Find missives without classification, or those classified as "other" that never got folder-mapped
      // ORGANIZER_SINCE (an ISO date) leaves mail from before the organizer
      // was switched on where it is, rather than re-filing a whole backlog.
      const since = organizerSince();
      const { rows } = await this.pg.query(
        `SELECT ${MISSIVE_LIST_COLUMNS} FROM missives WHERE channel = 'email'
         AND (
           (classification IS NULL OR classification = '')
           OR (classification = 'other' AND folder = 'inbox')
         )
         AND ($2::timestamptz IS NULL OR received_at >= $2::timestamptz)
         ORDER BY received_at DESC LIMIT $1`,
        [Math.min(limit, BATCH_SIZE), since]
      );

      if (rows.length === 0) return 0;

      // Batch classify all at once (on decrypted subject/sender/body)
      const results = await this.batchClassify(await openRows("missives", rows));
      let processed = 0;

      for (const result of results) {
        if (result) {
          await this.applyClassification(result.missiveId, result.threadId, result);
          // Clear rules evaluator so rules based on classification re-trigger
          await this.pg.query(
            "UPDATE missives SET rules_evaluated_at = NULL WHERE id = $1",
            [result.missiveId]
          );
          processed++;
        }
      }

      // Also fix orphaned missives that were classified but never moved to the right folder
      const { rows: orphaned } = await this.pg.query(
        `SELECT id, thread_id, classification FROM missives
         WHERE classification IS NOT NULL AND classification != '' AND folder = 'inbox'
         AND classification IN ('invoice', 'complaint', 'lead', 'support', 'personal', 'newsletter', 'meeting', 'spam', 'other')
         LIMIT $1`,
        [limit]
      );
      for (const row of orphaned) {
        const targetFolder = classificationToFolder(row.classification);
        if (targetFolder && targetFolder !== "inbox") {
          await this.pg.query(
            "UPDATE missives SET folder = $1, updated_at = NOW() WHERE id = $2",
            [targetFolder, row.id]
          );
          await this.pg.query(
            "UPDATE missives SET folder = $1, updated_at = NOW() WHERE thread_id = $2 AND folder = 'inbox'",
            [targetFolder, row.thread_id]
          );
        }
      }
      if (orphaned.length > 0) {
        this.logger.log(`Organizer fixed ${orphaned.length} orphaned missive(s) moved to correct folders`);
      }

      // Fix previously mis-archived notifications — bring them back to inbox
      const { rows: misarchived } = await this.pg.query(
        `UPDATE missives SET folder = 'inbox', updated_at = NOW()
         WHERE folder = 'archived' AND classification = 'notification'
         RETURNING id`
      );
      if (misarchived.length > 0) {
        this.logger.log(`Organizer moved ${misarchived.length} mis-archived notification(s) back to inbox`);
      }

      if (processed > 0) {
        this.logger.log(`Organizer classified ${processed} missive(s)`);
        this.events.emit("organizer", `Classified **${processed}** message(s) into folders.`);
      }

      // Emit events for other fixes
      if (orphaned.length > 0) {
        this.events.emit("organizer", `Fixed **${orphaned.length}** previously misclassified message(s) — moved to correct folders.`);
      }
      if (misarchived.length > 0) {
        this.events.emit("organizer", `Moved **${misarchived.length}** notification(s) back to inbox (previously mis-archived).`);
      }
      return processed + orphaned.length;
    } finally {
      this._isRunning = false;
    }
  }

  /**
   * Generate a digest of all missives since the last digest.
   * Returns the digest or null if no new missives.
   */
  async generateDigest(): Promise<Digest | null> {
    // Find last digest end time
    const lastRes = await this.pg.query(
      "SELECT period_end, created_at FROM digests ORDER BY created_at DESC LIMIT 1"
    );
    // At most one digest an hour: each one is a model call.
    const lastAt = lastRes.rows[0]?.created_at as Date | undefined;
    if (lastAt && Date.now() - new Date(lastAt).getTime() < DIGEST_INTERVAL_MS) return null;
    const since =
      lastRes.rows.length > 0
        ? (lastRes.rows[0].period_end as Date).toISOString()
        : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const periodEnd = new Date().toISOString();

    // Get missives since last digest
    const { rows } = await this.pg.query(
      `SELECT m.id, m.owner_id, m.thread_id, m.subject, m.sender_name, m.sender_address,
              m.body, m.classification, m.folder, m.created_at
       FROM missives m
       WHERE m.created_at > $1
       ORDER BY m.created_at DESC
       LIMIT 50`,
      [since]
    );

    if (rows.length === 0) return null;

    // Build the digest via AI
    const items: DigestItem[] = [];
    const summary = await this.buildDigestSummary(await openRows("missives", rows), items);

    const id = `digest_${Date.now()}`;
    await this.pg.query(
      `INSERT INTO digests (id, summary, items, period_start, period_end, missive_count, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        id,
        await seal("digests", "summary", summary),
        await sealJson("digests", "items", items),
        since,
        periodEnd,
        rows.length,
      ]
    );

    this.logger.log(`Digest generated: ${rows.length} missives`);

    // Emit the full summary as a system event
    const topItems = items
      .filter((i) => i.importance === "high" || i.importance === "medium")
      .slice(0, 4)
      .map((i) => `- **${i.subject}** (${i.sender}) — ${i.reason}`)
      .join("\n");
    this.events.emit("digest", `### AI Summary\n${summary}\n\n${topItems ? `**Key items:**\n${topItems}` : ""}`);

    // Fetch the saved digest to return
    const saved = await this.pg.query(
      "SELECT * FROM digests WHERE id = $1",
      [id]
    );
    return saved.rows.length > 0 ? rowToDigest(await openRow("digests", saved.rows[0])) : null;
  }

  /** Get the latest digest */
  async getLatestDigest(): Promise<Digest | null> {
    const { rows } = await this.pg.query(
      "SELECT * FROM digests ORDER BY created_at DESC LIMIT 1"
    );
    return rows.length > 0 ? rowToDigest(await openRow("digests", rows[0])) : null;
  }

  /** List recent digests */
  async listDigests(limit = 10): Promise<Digest[]> {
    const { rows } = await this.pg.query(
      "SELECT * FROM digests ORDER BY created_at DESC LIMIT $1",
      [limit]
    );
    return (await openRows("digests", rows)).map(rowToDigest);
  }

  // ── Private helpers ──

  /**
   * Batch classify multiple missives in a single AI call.
   * Doesn't blindly trust LLM JSON — reconstructs structured results ourselves.
   */
  private async batchClassify(
    rows: any[]
  ): Promise<(ClassifyResult & { missiveId: string; threadId: string })[]> {
    // Only the messages actually shown to the model get a result.
    rows = rows.slice(0, BATCH_SIZE);
    const emailList = rows
      .map(
        (r, i) =>
          `IDX${i}: Subject: "${r.subject}", From: ${r.sender_name ?? r.sender_address}, Body preview: ${(r.body ?? "").slice(0, 200)}`
      )
      .join("\n");

    const prompt = `You are an email classifier. Analyze each email and classify it.

Emails:
${emailList}

For each email, respond with a line like:
IDX0 classification=folder|reason
IDX1 classification=folder|reason

Where classification is one of: invoice, support, newsletter, notification, meeting, personal, spam, other
And folder is one of: inbox, invoices, complaints, leads, support, personal, archived, spam

If the email is an invoice, set folder=invoices. If it's a support request, set folder=support. If it's a lead, set folder=leads. If it's personal, set folder=personal. For spam, set folder=spam. For newsletters/meetings/other, set folder=archived. For notifications, set folder=inbox — notifications (e.g. from GitHub, Jira, CI tools) can be actionable and should stay in the inbox.

Example:
IDX0 newsletter=archived|weekly newsletter
IDX1 invoice=invoices|payment receipt
IDX2 support=support|customer refund request`;

    try {
      const response = await fetch(
        `${this.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: llmHeaders(),
          body: JSON.stringify({
            model: this.model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.1,
            max_tokens: 1024,
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        }
      );

      if (!response.ok) {
        // Out of today's allowance, or the model is down: leave the mail
        // where it is and try again next run, rather than filing it all as "other".
        this.logger.warn(`Classify model returned ${response.status}; will retry next run`);
        return [];
      }

      const data = (await response.json()) as Record<string, any>;
      const rawText = data.choices?.[0]?.message?.content ?? "";

      // ── Reconstruct classifications from raw text, don't trust JSON ──
      const results = rows.map((r, i) => {
        const fallback: ClassifyResult & { missiveId: string; threadId: string } = {
          missiveId: r.id,
          threadId: r.thread_id,
          classification: "other",
          folder: null,
        };

        // Try to extract our structured line format
        const lines = rawText.split("\n");
        const line = lines.find((l: string) => l.startsWith(`IDX${i}`));
        if (line) {
          const parts = line.split(/[=|\|]/);
          if (parts.length >= 2) {
            // parts[0] = "IDX0 invoice", parts[1] = "invoices", parts[2] = "reason"
            const clsMatch = parts[0]?.match(/IDX\d+\s+(\w+)/);
            if (clsMatch) {
              const cls = clsMatch[1].trim().toLowerCase();
              const valid = ["invoice", "support", "newsletter", "notification", "meeting", "personal", "spam", "other"];
              if (valid.includes(cls)) {
                fallback.classification = cls;
              }
            }
            const f = parts[1]?.trim().toLowerCase();
            const validFolders = ["inbox", "invoices", "complaints", "leads", "support", "personal", "archived", "spam"];
            if (validFolders.includes(f)) {
              fallback.folder = f;
            }
          }
          return fallback;
        }

        // Try to find any mention of a known classification near this index in the text
        const valid = ["invoice", "support", "newsletter", "notification", "meeting", "personal", "spam", "other"];
        const subjectLower = (r.subject ?? "").toLowerCase();
        for (const cls of valid) {
          if (subjectLower.includes(cls)) {
            fallback.classification = cls;
            break;
          }
        }

        // Heuristic: newsletter-like subjects
        if (r.subject && /newsletter|weekly|digest|alert|notification|price.?drop|security|unusual|sign.?in/i.test(r.subject)) {
          if (/security|unusual|sign.?in|github|pull.?request|review|ci|deploy|build|action|workflow/i.test(r.subject)) {
            fallback.classification = "notification";
          } else if (/price.?drop|deal|offer|sale/i.test(r.subject)) {
            fallback.classification = "newsletter";
          }
        }

        // Heuristic: invoice-like
        if (r.subject && /invoice|receipt|payment|order|purchase|billing/i.test(r.subject)) {
          fallback.classification = "invoice";
        }

        // Heuristic: spam-like
        if (r.subject && /viagra|enlarge|cryptocurrency|click here|limited time|act now/i.test(r.subject)) {
          fallback.classification = "spam";
        }

        return fallback;
      });

      this.logger.log(`Batch classified ${results.length} missives (AI heuristic)`);
      return results;
    } catch (err) {
      this.logger.error(`Batch classify error: ${safeError(err)}`);
      return [];
    }
  }

  private async applyClassification(
    missiveId: string,
    threadId: string,
    result: ClassifyResult
  ): Promise<void> {
    // Set classification
    await this.pg.query(
      "UPDATE missives SET classification = $1, updated_at = NOW() WHERE id = $2",
      [result.classification, missiveId]
    );

    // Map classification to actual folder
    const classificationFolder = classificationToFolder(result.classification);

    // Move to folder: prefer the mapped folder from classification, fall back to AI's suggestion
    const targetFolder = result.folder ?? classificationFolder;
    if (targetFolder && targetFolder !== "inbox") {
      await this.pg.query(
        "UPDATE missives SET folder = $1, updated_at = NOW() WHERE id = $2",
        [targetFolder, missiveId]
      );
      await this.pg.query(
        "UPDATE missives SET folder = $1, updated_at = NOW() WHERE thread_id = $2 AND folder = 'inbox'",
        [targetFolder, threadId]
      );
    }
  }

  private async buildDigestSummary(
    rows: any[],
    items: DigestItem[]
  ): Promise<string> {
    // Build the items array with AI help
    const emailList = rows
      .slice(0, 15)
      .map(
        (r, i) =>
          `IDX${i}: Subject: "${r.subject}", From: ${r.sender_name ?? r.sender_address}, Classification: ${r.classification ?? "unknown"}, Folder: ${r.folder}`
      )
      .join("\n");

    const prompt = `You are an executive assistant. Review these recently received emails and provide:
1. A 2-3 sentence executive summary of what needs attention
2. For each important email, indicate importance: high, medium, or low with a reason

Emails:
${emailList}

Respond like this:
SUMMARY: <2-3 sentence summary>
IDX0 importance=high|reason for importance
IDX1 importance=medium|reason
IDX2 importance=low|reason`;

    try {
      const response = await fetch(
        `${this.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: llmHeaders(),
          body: JSON.stringify({
            model: this.model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.3,
            max_tokens: 1024,
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        }
      );

      if (!response.ok) {
        return this.buildFallbackSummary(rows, items);
      }

      const data = (await response.json()) as Record<string, any>;
      const rawText = data.choices?.[0]?.message?.content ?? "";

      // ── Extract summary from lines starting with SUMMARY: ──
      let summary = rawText.split("\n").find((l: string) => l.startsWith("SUMMARY:")) ?? "";
      summary = summary.replace(/^SUMMARY:\s*/i, "").trim();
      if (!summary) {
        // Fallback: take first sentence-like part
        const firstLine = rawText.split("\n").find((l: string) => l.trim().length > 10 && !l.startsWith("IDX"));
        summary = firstLine?.trim().slice(0, 200) ?? "";
      }

      // ── Reconstruct digest items from raw text, line by line ──
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        let importance: "high" | "medium" | "low" = "medium";
        let reason = "New email received";

        const lines = rawText.split("\n");
        const line = lines.find((l: string) => l.startsWith(`IDX${i}`));
        if (line) {
          const parts = line.split("|");
          if (parts.length >= 1) {
            const impPart = parts[0]?.match(/importance=(\w+)/i);
            if (impPart) {
              const matched = impPart[1].toLowerCase();
              if (matched === "high" || matched === "medium" || matched === "low") {
                importance = matched;
              }
            }
          }
          if (parts.length >= 2) {
            reason = parts.slice(1).join("|").trim().slice(0, 100);
          }
        }

        items.push({
          threadId: row.thread_id,
          subject: row.subject ?? "(no subject)",
          sender: row.sender_name ?? row.sender_address,
          importance,
          reason,
          classification: row.classification ?? "other",
        });
      }

      if (!summary) {
        summary = `${rows.length} email(s) received.`;
      }

      return summary;
    } catch {
      return this.buildFallbackSummary(rows, items);
    }
  }

  private buildFallbackSummary(rows: any[], items: DigestItem[]): string {
    for (const row of rows) {
      items.push({
        threadId: row.thread_id,
        subject: row.subject ?? "(no subject)",
        sender: row.sender_name ?? row.sender_address,
        importance: "medium",
        reason: "New email received",
        classification: row.classification ?? "other",
      });
    }
    return `${rows.length} new email(s) received.`;
  }
}

function rowToDigest(row: any): Digest {
  const items =
    typeof row.items === "string" ? JSON.parse(row.items) : row.items;
  return {
    id: row.id,
    summary: row.summary,
    items: Array.isArray(items) ? items : [],
    periodStart:
      row.period_start?.toISOString?.() ?? row.period_start,
    periodEnd: row.period_end?.toISOString?.() ?? row.period_end,
    missiveCount: row.missive_count,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
  };
}

/** Map a classification string to a folder slug */
function classificationToFolder(classification: string): string | null {
  const map: Record<string, string> = {
    invoice: "invoices",
    complaint: "complaints",
    lead: "leads",
    support: "support",
    personal: "personal",
    notification: "inbox",
    newsletter: "archived",
    meeting: "archived",
    spam: "spam",
    other: "archived",
  };
  return map[classification?.toLowerCase()] ?? null;
}
