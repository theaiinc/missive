import type { Missive, Thread, EntityReference, RuleProposal } from "./types";

// ──────────────────────────────────────────────
// Search — Missive's own full-text search
// Searches raw communication data only.
// Graph-aware search (by entity, by relationship) goes through Pathway.
// ──────────────────────────────────────────────

export interface SearchQuery {
  query?: string;
  channel?: string;
  provider?: string;
  from?: string;
  to?: string;
  after?: string;
  before?: string;
  folder?: string;
  organization?: string;
  project?: string;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  missives: Missive[];
  threads: Thread[];
  total: number;
}

// ──────────────────────────────────────────────
// Rule API — AI proposes, user approves
// ──────────────────────────────────────────────

/** Frontend sends this to create/update a rule */
export interface CreateRuleRequest {
  name: string;
  description?: string;
  conditions: { field: string; operator: string; value: string }[];
  actions: { type: string; params?: Record<string, string> }[];
  enabled?: boolean;
}

export interface RuleProposalResponse {
  proposal: RuleProposal | null;
  /** Human-readable text to show alongside the proposal (AI's explanation) */
  message: string;
}

// ──────────────────────────────────────────────
// Missive API
// ──────────────────────────────────────────────

export interface MissiveService {
  search(query: SearchQuery): Promise<SearchResult>;
  getMissive(id: string): Promise<Missive | null>;
  getThread(id: string): Promise<Thread | null>;
  getThreadMissives(threadId: string): Promise<Missive[]>;
  summarize(threadId: string): Promise<string>;
  classify(missiveId: string): Promise<string>;
  extractEntities(missiveId: string): Promise<EntityReference[]>;
}

// ──────────────────────────────────────────────
// Connector API
// ──────────────────────────────────────────────

export interface Connector {
  readonly provider: string;
  connect(config: Record<string, unknown>): Promise<void>;
  disconnect(): Promise<void>;
  sync(): Promise<SyncResult>;
  send(message: SendPayload): Promise<string>;
}

export interface SyncResult {
  newMessages: number;
  updatedMessages: number;
  errors: string[];
  syncedAt: string;
}

export interface SendPayload {
  threadId?: string;
  to: { name?: string; address: string }[];
  cc?: { name?: string; address: string }[];
  bcc?: { name?: string; address: string }[];
  subject?: string;
  body: string;
  bodyHtml?: string;
  attachments?: {
    filename: string;
    mimeType: string;
    content: Buffer;
  }[];
}

// ──────────────────────────────────────────────
// Event API (Pathway Integration)
// Missive emits raw communication events.
// Pathway subscribes, builds the graph, stores memory.
// ──────────────────────────────────────────────

export type MissiveEventType =
  | "missive.received"
  | "missive.sent"
  | "missive.classified"
  | "missive.summarized"
  | "thread.updated"
  | "entities.extracted"       // Missive AI → Pathway to link & store
  | "sync.completed"
  | "connector.error";

export interface MissiveEvent {
  type: MissiveEventType;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface EventBus {
  emit(event: MissiveEvent): Promise<void>;
  subscribe(
    type: MissiveEventType | "*",
    handler: (event: MissiveEvent) => Promise<void>
  ): Promise<void>;
}