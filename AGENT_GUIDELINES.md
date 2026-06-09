# Missive — Communication Intelligence Layer

## Product Vision
Missive is an AI-native communication hub that unifies email, chat, tickets, social messages, and documents into a single knowledge stream for AI assistants and human operators. It treats communication as **knowledge**, not messages.

## Brand & Naming

### Missive (`@theaiinc/missive`)
- Communications layer. The message itself.
- Not a mail client. A Communication Intelligence Layer.
- Short, memorable, professional. Doesn't lock into email.

### AI Inc Ecosystem
| Package | Role |
|---|---|
| `@theaiinc/pathway` | Orchestration, Memory & Graph |
| `@theaiinc/cognition` | Agentic & Reasoning |
| `@theaiinc/veil` | PII & Privacy |
| `@theaiinc/missive` | Communications |

Folded into Pathway: Chronicle (memory).
Folded into Cognition: Oracle (reasoning engine).

### Tagline
> "Every message. One memory."

## Architecture
```
Gmail / Outlook / Facebook / Slack / Discord / CRM / Tickets
    ↓
Connectors
    ↓
Missive (Core) — normalize, serve events, expose API
    ↓
Pathway — orchestrate, remember, relate, store graph
    ↓
Cognition — reason, decide, act via agents
    ↓
Actions
```

### Core Concepts
- **Missive** — A communication artifact (email, chat, ticket, comment, SMS, notification)
- **Thread** — A collection of related Missives
- **Entity** — People, companies, projects, products, documents
- **Context** — Relationships between Missives and Entities

Missive normalizes and exposes communication data. Pathway owns the graph relationships and memory storage. Cognition owns the agent reasoning and action execution.

## Tech Stack
- **Frontend:** React, Vite, TanStack Query, shadcn/ui, Lucide, TipTap, React Flow
- **Backend:** Node.js, NestJS, PostgreSQL, Redis
- **AI:** LM Studio (local, `google/gemma-4-26b-a4b-qat`), OpenAI (cloud)

## MVP Scope
### Gmail Connector
- OAuth Login, Inbox Sync, Thread/Message Retrieval, Search, Send Reply

### Outlook Connector
- OAuth Login, Inbox Sync, Thread Retrieval, Search

### Unified Inbox
- View Messages, Search Messages, Thread View, Reply, Archive

### AI Features
- Summarization, Classification, Entity Extraction

### Integration with Pathway & Cognition
Events emitted by Missive — Pathway subscribes and builds the graph:

```typescript
missive.on("missive.received", (event) => pathway.ingest(event))
missive.on("missive.sent", (event) => pathway.ingest(event))
missive.on("thread.updated", (event) => pathway.ingest(event))
missive.on("entities.extracted", (event) => pathway.linkEntities(event))
```

Pathway → Cognition flow:
```typescript
pathway.on("insight.ready", (event) => cognition.triggerAgent(event))
cognition.on("action.required", (event) => pathway.updateGraph(event))
```

Cognition emits back to Missive for display:
```typescript
cognition.on("action.completed", (event) => missive.notify(event))
```

## Storage
- **Missive:** PostgreSQL (raw comms: missives, threads, sync state), object storage for attachments
- **Pathway:** Graph store (Neo4j / PG graph model), Memory store
- **Cognition:** Agent state, decision logs, execution traces

## Roadmap
1. **Phase 1:** Gmail, Outlook, Search, AI Summary
2. **Phase 2:** Facebook, Slack, Discord, CRM Connectors
3. **Phase 3:** Deep Pathway integration, cross-entity graph queries
4. **Phase 4:** Cognition agent integration, autonomous communication agents

## Dev Setup Learnings

### NestJS dev script: DO NOT use `tsx watch` directly
`tsx` uses esbuild under the hood which **does not support `emitDecoratorMetadata`**. This means NestJS dependency injection breaks silently — `this.store` will be `undefined` even though DI wiring looks correct.

**Correct approach:** Use `tsc` for compilation (it generates proper decorator metadata) + `node --watch` for auto-restart.

```json
"dev": "tsc && concurrently -k -n compile,run \"tsc --watch\" \"node --watch dist/main.js\""
```

The `.env` file lives at the monorepo root (`/Users/stevetran/theaiincmissive/.env`) and is loaded via `dotenv.config()` in `main.ts`.

## Folders Implementation
- **Core:** `Folder` type in `@theaiinc/missive-core` with `id`, `name`, `slug`, `icon`, `color`, `system` (bool), `order`, `missiveCount`. Missive type has `folder` field (slug string, defaults to `"inbox"`).
- **System folders:** Inbox, Archived, Invoices, Complaints, Leads, Support, Personal — seeded in `PostgresService.onModuleInit()` after migrations run.
- **Custom folders:** Users create via sidebar UI (`Plus` button → inline input) → POST `/api/v1/folders`. Slugs are auto-generated from name (lowercased, hyphens).
- **DB schema:** `folders` table + `folder` column on `missives` table. No FK constraint — app-level validation via `ON CONFLICT (slug) DO NOTHING` seed pattern.
- **Backend endpoints:**
  - `GET /api/v1/folders` — list all folders with missive count
  - `POST /api/v1/folders` — create custom folder
  - `POST /api/v1/folders/move-missive` — move single missive
  - `POST /api/v1/folders/move-thread` — move entire thread
- **Filtering:** `GET /api/v1/search?folder=<slug>` filters by folder slug. Inbox defaults to `folder=inbox` from UI, search doesn't pass folder.
- **Auto-assignment:** Classification result maps to a folder via `classificationToFolder()` (e.g. "invoice" → "invoices"), called during classification and sync.
- **UI:** Folders listed first in sidebar above Search/Settings. Active folder highlighted. Missive count badge shown. Inbox header dynamically shows current folder name.

## Auto-Sync
- **`SyncService`** (`sync.service.ts`) — extracted from the old controller's `syncGmail()`. Shared between `ConnectorController` (manual trigger) and `SyncScheduler` (auto).
- **`SyncScheduler`** (`sync-scheduler.ts`) — `OnModuleInit`, starts a `setInterval` at 5 minutes (configurable via `AUTO_SYNC_INTERVAL_MS` env var, default 300000ms). First tick delayed 15s after startup. Logs how many new messages were synced each tick. Errors are caught and logged so one bad tick doesn't crash the scheduler.
- **Staggering:** Not yet implemented across providers, but `syncGmail()` and `syncOutlook()` both iterate connectors in order with per-account error isolation. Scheduler calls both in sequence (Gmail first, then Outlook) each tick.

## Outlook / Microsoft 365
- **OAuth:** Uses Microsoft identity platform v2.0 endpoints. `state` param set to `"outlook"` so the OAuth callback page can route to the correct token exchange endpoint.
- **`ConnectorStore` methods:**
  - `getOutlookAuthUrl()` — builds the authorize URL with scopes: `openid profile email User.Read Mail.Read Mail.ReadBasic Mail.Send offline_access`
  - `exchangeOutlookCode(code)` — POSTs to `/oauth2/v2.0/token`, then fetches `/v1.0/me` to get the user's email
  - `refreshOutlookTokens(refreshToken)` — POSTs to `/oauth2/v2.0/token` with `grant_type=refresh_token`
- **Sync (`syncOutlook`):** Fetches messages from `https://graph.microsoft.com/v1.0/me/messages?$top=10&$filter=isDraft eq false&$orderby=receivedDateTime desc`, then fetches full body per message. Extracts `body.content` for HTML or text. Same thread/missive storage pattern as Gmail.
- **Controller endpoints:** `/api/v1/connector/outlook/auth`, `outlook/token`, `outlook/status`, `outlook/disconnect`, `outlook/sync`
- **Env vars needed:** `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`, `OUTLOOK_REDIRECT_URI`, `OUTLOOK_TENANT` (defaults to `"common"`)
- **Frontend:** Settings page now uses generic `handleConnect("outlook")` / `ProviderSection` wired to `outlookStatus`. OAuth callback page reads `state` param to route to the correct token endpoint.

## Chat / AI Assistant
- **Backend:** `ChatService` (`chat.service.ts`) — streams from LM Studio via SSE. Uses system prompt: "You are Missive AI, an intelligent communication assistant..." Two methods: `streamChat()` (returns SSE `data: { content: "..." }` chunks + `{ done: true }`) and `chat()` (non-streaming).
- **Timeout:** `ChatService` now uses `fetchWithTimeout()` with configurable `LM_STUDIO_TIMEOUT_MS` (default 120000ms). On timeout, returns HTTP 504 with clear message.
- **Endpoint:** `POST /api/v1/chat/stream` — accepts `{ message: string }`, returns SSE. Registered in `AppModule` as `ChatController` + `ChatService`.
- **Frontend:** `ChatWidget` component — floating panel at bottom-right corner, toggled by a circular button (primary color when closed, grey/close when open). Features: `[Bot icon + avatar]` for assistant messages, user icon for user messages, streaming indicator with animated blink cursor, auto-scroll, keyboard Enter to send, AbortController for cancel, Markdown-ish rendering (bold, italic, code, newlines). Also has a client-side safety timeout (120s) that shows user-friendly message on timeout.
- **Mount:** `ChatWidget` is rendered inside `Layout.tsx` so it appears on **all pages** (inbox, search, settings, thread view).
- **Vite proxy:** `vite.config.ts` proxy for `/api` has timeout/proxyTimeout set to 120s to match LM Studio timeout.
- **Model choice:** The 26B model (gemma-4-26b) is too slow for local chat (~76s per response). Use `qwen3-4b-z-image-engineer-v4` (loaded in LM Studio) — responds in ~12s. Configured via `LM_STUDIO_MODEL` in `.env`.

## Notifications
- **Library:** `sonner` for toast notifications. `Toaster` component mounted in `Layout.tsx` (position: bottom-left).
- **Backend endpoint:** `GET /api/v1/recent-missives?since=<ISO>&limit=<N>` — returns missives created after the given timestamp. Used by the polling hook.
- **Hook:** `useNotifications()` in `src/hooks/useNotifications.ts`. Polls every 30 seconds. On new messages:
  - Shows a **sonner toast** with sender name, subject, and "View" button (links to `/inbox`)
  - Fires a **browser Notification** (`"Missive: sender"` with subject as body) if permission granted
  - Updates **document title** to `(N) Missive` showing unread count
  - Clears badge count when the tab becomes visible (`visibilitychange`)
- **Permissions:** Requests `Notification.permission` on mount if not yet decided.
- **Storage:** Uses `localStorage` key `missive_last_seen` to track which messages have been seen/notified.

## Rules System (AI-Generated Organization)

### How It Works
1. User types a natural language request in the ChatWidget: "move all invoices from stripe to the invoices folder"
2. Frontend calls `POST /api/v1/chat/rule-proposal` with the message
3. `ChatService.proposeRule()` sends the message to LM Studio with a system prompt that instructs the model to return structured JSON (RuleProposal)
4. The response includes a `RuleProposal` with conditions, actions, and whether clarification is needed
5. Frontend renders a `RuleCard` with an Approve/Reject button
6. On approve, `POST /api/v1/rules` creates the rule in DB
7. `POST /api/v1/rules/evaluate-all` applies it retroactively to all existing messages
8. Future syncs automatically run rules via `SyncService` → `RuleService.evaluate()`

### Core Types (`@theaiinc/missive-core`)
- **RuleCondition** — `{ field, operator, value }` where field is `from_address|from_domain|subject_contains|body_contains|has_attachments|channel|classification|account_email|direction`
- **RuleAction** — `{ type, params? }` where type is `move_to_folder|mark_read|mark_unread|archive|label|delete|notify`
- **Rule** — Full rule with AND logic (all conditions must match), priority, applied count tracking
- **RuleProposal** — AI-generated draft with `needsClarification` flag for ambiguous requests

### Backend
- **RuleService** — `list()`, `get()`, `create()`, `update()`, `remove()`, `evaluate(missive)`, `evaluateAll()`, `applyActions(missiveId, actions)`
- **RuleController** — `GET /api/v1/rules`, `POST /api/v1/rules`, `POST /:id/toggle`, `DELETE /:id`, `POST /evaluate-all`
- **Migration** (`005_add_rules.sql`) — `rules` table with JSONB conditions/actions columns, enabled/applied_count tracking
- **Sync integration** — After each missive is saved in `SyncService.syncGmail()` and `syncOutlook()`, `rules.evaluate(missive)` is called. If it matches, `rules.applyActions()` is called to move, label, archive, etc.

### Frontend
- **ChatWidget** — On send, first tries `POST /api/v1/chat/rule-proposal`. If a proposal is returned:
  - `needsClarification: true` → show AI's question as normal chat
  - Otherwise → show `RuleCard` inside the chat bubble with conditions/actions display + Approve/Reject buttons
- Approve calls `POST /api/v1/rules` to persist the rule, then `POST /api/v1/rules/evaluate-all` to apply to existing messages
- The `/api/v1/rules` endpoint expects: `{ name, description?, conditions: [{field, operator, value}], actions: [{type, params?}] }`

## Strategic Positioning
- Email clients manage messages.
- **Missive** ingests and normalizes communications.
- **Pathway** remembers, relates, and orchestrates.
- **Cognition** reasons, decides, and acts.