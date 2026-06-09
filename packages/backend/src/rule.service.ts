import { Injectable } from "@nestjs/common";
import { PostgresService } from "./storage/postgres.service";
import type {
  Missive,
  Rule,
  RuleCondition,
  RuleAction,
} from "@theaiinc/missive-core";

@Injectable()
export class RuleService {
  constructor(private readonly pg: PostgresService) {}

  // ── CRUD ──

  async list(): Promise<Rule[]> {
    const { rows } = await this.pg.query(
      "SELECT * FROM rules ORDER BY priority DESC, created_at ASC"
    );
    return rows.map(rowToRule);
  }

  async get(id: string): Promise<Rule | null> {
    const { rows } = await this.pg.query(
      "SELECT * FROM rules WHERE id = $1",
      [id]
    );
    return rows.length > 0 ? rowToRule(rows[0]) : null;
  }

  async create(data: {
    name: string;
    description?: string;
    conditions: RuleCondition[];
    actions: RuleAction[];
    enabled?: boolean;
    priority?: number;
  }): Promise<Rule> {
    const id = `rule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const { rows } = await this.pg.query(
      `INSERT INTO rules (id, name, description, conditions, actions, enabled, priority, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
       RETURNING *`,
      [
        id,
        data.name,
        data.description ?? null,
        JSON.stringify(data.conditions),
        JSON.stringify(data.actions),
        data.enabled ?? true,
        data.priority ?? 0,
      ]
    );
    return rowToRule(rows[0]);
  }

  async update(
    id: string,
    data: Partial<{
      name: string;
      description: string;
      conditions: RuleCondition[];
      actions: RuleAction[];
      enabled: boolean;
      priority: number;
    }>
  ): Promise<Rule | null> {
    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (data.name !== undefined) {
      sets.push(`name = $${idx}`); params.push(data.name); idx++;
    }
    if (data.description !== undefined) {
      sets.push(`description = $${idx}`); params.push(data.description); idx++;
    }
    if (data.conditions !== undefined) {
      sets.push(`conditions = $${idx}`); params.push(JSON.stringify(data.conditions)); idx++;
    }
    if (data.actions !== undefined) {
      sets.push(`actions = $${idx}`); params.push(JSON.stringify(data.actions)); idx++;
    }
    if (data.enabled !== undefined) {
      sets.push(`enabled = $${idx}`); params.push(data.enabled); idx++;
    }
    if (data.priority !== undefined) {
      sets.push(`priority = $${idx}`); params.push(data.priority); idx++;
    }

    if (sets.length === 0) return this.get(id);

    sets.push(`updated_at = NOW()`);
    params.push(id);
    const { rows } = await this.pg.query(
      `UPDATE rules SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
      params
    );
    return rows.length > 0 ? rowToRule(rows[0]) : null;
  }

  async remove(id: string): Promise<void> {
    await this.pg.query("DELETE FROM rules WHERE id = $1", [id]);
  }

  // ── Evaluation ──

  /**
   * Evaluate all enabled rules against a missive.
   * Returns the actions from the highest-priority matching rule.
   */
  async evaluate(missive: Missive): Promise<RuleAction[]> {
    const rules = await this.list();
    const enabled = rules.filter((r) => r.enabled);

    for (const rule of enabled) {
      if (this.matches(rule, missive)) {
        // Track that this rule was applied
        await this.pg.query(
          `UPDATE rules SET applied_count = applied_count + 1, last_applied_at = NOW() WHERE id = $1`,
          [rule.id]
        );
        return rule.actions;
      }
    }

    return [];
  }

  /**
   * Evaluate all enabled rules against every missive in the database.
   * Applies matching actions immediately.
   */
  async evaluateAll(): Promise<{ applied: number; total: number }> {
    const { rows } = await this.pg.query(
      "SELECT * FROM missives ORDER BY received_at DESC"
    );
    const missives = rows.map(rowToSimpleMissive);
    let applied = 0;

    for (const missive of missives) {
      const actions = await this.evaluate(missive);
      if (actions.length > 0) {
        await this.applyActions(missive.id, actions);
        applied++;
      }
    }

    return { applied, total: missives.length };
  }

  /**
   * Execute action list against a missive.
   */
  async applyActions(missiveId: string, actions: RuleAction[]): Promise<void> {
    for (const action of actions) {
      switch (action.type) {
        case "move_to_folder": {
          const folder = action.params?.folder;
          if (folder) {
            await this.pg.query(
              "UPDATE missives SET folder = $1, updated_at = NOW() WHERE id = $2",
              [folder, missiveId]
            );
          }
          break;
        }
        case "archive": {
          await this.pg.query(
            "UPDATE missives SET folder = 'archived', status = 'archived', updated_at = NOW() WHERE id = $1",
            [missiveId]
          );
          break;
        }
        case "mark_read": {
          await this.pg.query(
            "UPDATE missives SET status = 'read', updated_at = NOW() WHERE id = $1",
            [missiveId]
          );
          break;
        }
        case "mark_unread": {
          await this.pg.query(
            "UPDATE missives SET status = 'unread', updated_at = NOW() WHERE id = $1",
            [missiveId]
          );
          break;
        }
        case "label": {
          const label = action.params?.label;
          if (label) {
            await this.pg.query(
              "UPDATE missives SET classification = $1, updated_at = NOW() WHERE id = $2",
              [label, missiveId]
            );
          }
          break;
        }
        case "delete": {
          await this.pg.query(
            "UPDATE missives SET status = 'deleted', updated_at = NOW() WHERE id = $1",
            [missiveId]
          );
          break;
        }
        // "notify" is handled server-side via event emitter (future)
        default:
          break;
      }
    }
  }

  /** Check if a rule's conditions all match a missive (AND logic) */
  private matches(rule: Rule, m: Missive): boolean {
    return rule.conditions.every((c) => this.evaluateCondition(c, m));
  }

  private evaluateCondition(c: RuleCondition, m: Missive): boolean {
    const actual = this.getFieldValue(c.field, m);
    if (actual === undefined) return false;

    switch (c.operator) {
      case "equals":
        return String(actual).toLowerCase() === c.value.toLowerCase();
      case "not_equals":
        return String(actual).toLowerCase() !== c.value.toLowerCase();
      case "contains":
        return String(actual).toLowerCase().includes(c.value.toLowerCase());
      case "not_contains":
        return !String(actual).toLowerCase().includes(c.value.toLowerCase());
      case "matches":
        try {
          return new RegExp(c.value, "i").test(String(actual));
        } catch {
          return false;
        }
      case "before":
        return new Date(m.receivedAt) < new Date(c.value);
      case "after":
        return new Date(m.receivedAt) > new Date(c.value);
      default:
        return false;
    }
  }

  private getFieldValue(
    field: string,
    m: Missive
  ): string | boolean | undefined {
    switch (field) {
      case "from_address":
        return m.from.address;
      case "from_domain":
        return m.from.address?.split("@")[1];
      case "subject_contains":
      case "subject_matches":
        return m.subject ?? "";
      case "body_contains":
        return m.body;
      case "has_attachments":
        return (m.attachments?.length ?? 0) > 0;
      case "channel":
        return m.channel;
      case "classification":
        return m.classification ?? "";
      case "account_email":
        return m.accountEmail ?? "";
      case "direction":
        return m.direction;
      case "received_before":
      case "received_after":
        return m.receivedAt;
      default:
        return undefined;
    }
  }
}

function rowToRule(row: any): Rule {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    enabled: row.enabled,
    conditions:
      typeof row.conditions === "string"
        ? JSON.parse(row.conditions)
        : row.conditions,
    actions:
      typeof row.actions === "string"
        ? JSON.parse(row.actions)
        : row.actions,
    priority: row.priority,
    appliedCount: row.applied_count,
    lastAppliedAt: row.last_applied_at
      ? row.last_applied_at.toISOString()
      : undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Convert a DB row to a minimal Missive object for rule evaluation */
function rowToSimpleMissive(row: any): Missive {
  return {
    id: row.id,
    threadId: row.thread_id,
    channel: row.channel,
    direction: row.direction,
    provider: row.provider,
    providerMessageId: row.provider_message_id,
    subject: row.subject ?? undefined,
    body: row.body,
    bodyHtml: row.body_html ?? undefined,
    from: { name: row.sender_name ?? undefined, address: row.sender_address },
    to: typeof row.recipients === "string" ? JSON.parse(row.recipients) : row.recipients,
    status: row.status,
    classification: row.classification ?? undefined,
    folder: row.folder ?? "inbox",
    accountEmail: row.account_email ?? undefined,
    receivedAt: row.received_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
