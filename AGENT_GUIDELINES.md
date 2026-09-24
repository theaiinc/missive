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
- **Bug fix (2026-06-19):** Three issues prevented emails from being auto-sorted into folders:
  1. The AI prompt in `organizer.service.ts` instructed the model to use `inbox|archive|unknown` as folders, but actual system folders are `invoices`, `complaints`, `leads`, `support`, `personal`, `archived`
  2. The folder parser only accepted `"inbox"` or `"archive"` — rejected all other valid folder names
  3. Even when classification was set correctly, the `applyClassification` method relied on the AI-suggested folder (which was always wrong) instead of using the `classificationToFolder()` mapping. Fixed to fall back to `classificationToFolder(result.classification)` when AI doesn't suggest a valid folder.
  4. Added orphan fix: on each organizer pass, missives with a classification but still stuck in `inbox` folder get moved to the correct folder
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
  - **IMPORTANT:** Must return `{ missives: Missive[] }` — NOT a raw array. The frontend expects the `missives` key. See controller `@Get("recent-missives")`.
- **Hook:** `useNotifications()` in `src/hooks/useNotifications.ts`. Polls every 30 seconds. On new messages:
  - Shows a **sonner toast** with sender name, subject, and "View" button (links to `/inbox`)
  - Fires a **browser Notification** (`"Missive: sender"` with subject as body) if permission granted
  - Updates **document title** to `(N) Missive` showing unread count
  - Clears badge count when the tab becomes visible (`visibilitychange`)
- **Bug fix (2026-06-19):** `missive.controller.ts` was returning a raw `Missive[]` array from `getRecentMissives()` when `since` was provided, but the frontend expects `{ missives: Missive[] }`. The `if (!data.missives?.length) return;` guard in the polling hook always fired, so no notifications ever appeared. Fixed by wrapping the return value.

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
- **RuleService** — `list()`, `get()`, `create()`, `update()`, `remove()`, `evaluate(missive)`, `evaluateAll()`, `evaluatePending(limit)`, `applyActions(missiveId, actions)`
- **RuleController** — `GET /api/v1/rules`, `POST /api/v1/rules`, `POST /:id/toggle`, `DELETE /:id`, `POST /evaluate-all`
- **Migration** (`005_add_rules.sql`) — `rules` table with JSONB conditions/actions columns, enabled/applied_count tracking
- **Migration** (`007_add_rules_evaluated_at.sql`) — adds `rules_evaluated_at` column to `missives` table + partial index to find pending missives efficiently
- **Sync integration** — After each missive is saved in `SyncService.syncGmail()` and `syncOutlook()`, `rules.evaluate(missive)` is called. If it matches, `rules.applyActions()` is called to move, label, archive, etc.

### Auto-Evaluation (Periodic)
- The `SyncScheduler` runs `rules.evaluatePending(50)` on every tick (every ~5 min) **after** sync + organizer classification
- `evaluatePending()` queries missives where `rules_evaluated_at IS NULL OR rules_evaluated_at < updated_at` — this catches:
  - Missives that were synced before any rule existed
  - Missives that got classified by the OrganizerService after their initial sync (so `classification`-based rules now match)
  - Missives that were updated for any other reason
- When a rule matches, `evaluate()` updates the `applied_count` on the rule AND sets `rules_evaluated_at` on the missive
- When no rule matches, `rules_evaluated_at` is still set to avoid re-scanning the same missive every tick
- The partial index `idx_missives_rules_pending` on `missives(rules_evaluated_at NULLS FIRST) WHERE rules_evaluated_at IS NULL OR rules_evaluated_at < updated_at` keeps the pending lookup efficient

### Frontend
- **ChatWidget** — On send, first tries `POST /api/v1/chat/rule-proposal`. If a proposal is returned:
  - `needsClarification: true` → show AI's question as normal chat
  - Otherwise → show `RuleCard` inside the chat bubble with conditions/actions display + Approve/Reject buttons
- Approve calls `POST /api/v1/rules` to persist the rule, then `POST /api/v1/rules/evaluate-all` to apply to existing messages
- The `/api/v1/rules` endpoint expects: `{ name, description?, conditions: [{field, operator, value}], actions: [{type, params?}] }`
- **Rules page** (`packages/web/src/pages/Rules.tsx`) — `/rules` route, linked in sidebar. Lists all rules with toggle (enable/disable) and delete. Uses TanStack Query for data fetching and mutations. Returns `{ missives: Missive[] }` shape.

## Strategic Positioning
- Email clients manage messages.
- **Missive** ingests and normalizes communications.
- **Pathway** remembers, relates, and orchestrates.
- **Cognition** reasons, decides, and acts.

## Organizations (Classification Layer)

### How It Works
Organizations are a named classification dimension (alongside "projects" and "classifications") that allows users to tag missives and threads with which organization(s) they belong to. Since one project can belong to multiple organizations, the field is a `TEXT[]` array on the `missives` table.

### Database
- **Migration** (`008_add_organizations.sql`) — adds `organizations TEXT[] DEFAULT '{}'` column to `missives` table + GIN index for efficient `ANY(organizations)` queries.
- The column is auto-picked up by `SELECT *` queries and mapped in `rowToMissive()`.

### Backend API Endpoints
- `GET /api/v1/organizations` — returns all distinct organization names across all missives
- `POST /api/v1/missive/:id/organizations` — set organizations for a single missive (body: `{ organizations: string[] }`)
- `POST /api/v1/thread/:id/organizations` — set organizations for all missives in a thread
- `GET /api/v1/search?organization=<name>` — filter missives by organization (uses `$1 = ANY(organizations)`)

### Storage Service Methods
- `setMissiveOrganizations(id, organizations)` — updates `organizations` column
- `setThreadOrganizations(threadId, organizations)` — updates all missives in a thread
- `listOrganizations()` — `SELECT DISTINCT unnest(organizations) FROM missives`

### ChatService Tools
Two new tool definitions for the AI assistant:
- `setOrganizations` — sets organizations on a single missive
- `setThreadOrganizations` — sets organizations on an entire thread

Both added to `getToolDefinitions()` and `executeTool()` switch in `chat.service.ts`.

### Frontend Visual Indicators
- **Deterministic color palette** — 10 predefined Tailwind color pairs (violet, emerald, orange, cyan, pink, teal, yellow, lime, fuchsia, rose), each with `bg`, `text`, and `dot` classes. Colors are assigned via string hash of the org name, so each org always gets the same color.
- **Organization badges** — Displayed as small inline `span` elements next to the classification badge in the inbox row, showing a colored dot + org name.
- **Organization filter dropdown** — A `<select>` element in the inbox header (next to result count) lets users filter the current folder by organization. Hidden when no orgs exist.
- **System prompt context** — `ChatService.buildSystemPrompt()` now lists available organizations via `listOrganizations()`.

### SearchQuery Type
Extended with optional `organization: string` and `project: string` fields for filtering.

## Projects (Entity Layer)

Projects are a first-class entity dimension alongside organizations, stored identically as a `TEXT[]` array on `missives`.

### Database
- **Migration** (`009_add_projects.sql`) — adds `projects TEXT[] DEFAULT '{}'` column to `missives` + GIN index.

### Backend
- Storage methods: `setMissiveProjects`, `setThreadProjects`, `listProjects`
- API endpoints: `GET /api/v1/projects`, `POST /missive/:id/projects`, `POST /thread/:id/projects`
- Search filter: `GET /api/v1/search?project=<name>`
- ChatService tools: `setProjects`, `setThreadProjects` with definitions and execution handlers
- System prompt context lists projects in use

### Settings Page
Both Organizations and Projects are managed from the **Settings** page under `ConfigSection` components:
- **Add**: Type a name and click Add
- **Rename**: Click the name to edit inline
- **Delete**: Click the trash icon to remove
- **Color picker**: Click the color swatch to choose from 8 colors (same palette as account colors)
- Config is stored in `localStorage` under `missive_managed_organizations` and `missive_managed_projects` keys, using a shared `useEntityConfig` hook

### Inbox Row Display
Org and project names appear as colored badges (with a colored dot + name) next to the classification badge in each inbox row:
- Badge colors come from the Settings-configurable palette
- Fallback: deterministic hash-based colors for any org/project name not in the managed list

### Organization Filter
A `<select>` dropdown in the inbox header (next to the results count) filters by organization. Projects have a similar filter next to it.