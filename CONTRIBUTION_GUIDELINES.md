# Contributing to Missive

## Project Structure

```
missive/
├── packages/
│   ├── core/          # Types, interfaces, API contracts
│   ├── backend/       # NestJS REST API
│   ├── connectors/    # Provider connectors (Gmail, Outlook, etc.)
│   ├── ai/            # AI features (summarization, classification)
│   └── web/           # React frontend (Vite, TanStack Query, shadcn/ui)
├── tsconfig.base.json # Shared TypeScript config
└── package.json       # Root workspace
```

## Architecture Boundary

**Missive owns:**

- Raw communication ingest, normalize, serve
- Full-text search over raw communications
- AI summary & classification
- Entity extraction (results emitted as events)

**Pathway owns:**

- Orchestration & event routing
- Graph store (entities, relationships)
- Memory store (thread memory, decisions, org memory)

**Cognition owns:**

- Agent reasoning & decision making
- Action execution & agent state
- Decision logs & execution traces

Missive emits events → Pathway ingests, relates, and stores → Cognition reasons and acts.

## Getting Started

```bash
# Start LM Studio server with the model
# LM Studio at http://127.0.0.1:1234 with google/gemma-4-26b-a4b-qat

# Start Missive
pnpm install
pnpm dev
```

- Backend runs on `http://localhost:4000`
- Frontend runs on `http://localhost:5173`
- AI runs on `http://127.0.0.1:1234` (LM Studio, OpenAI-compatible)

## Development Conventions

### Code Style

- TypeScript strict mode enabled
- Prefer `zod` for runtime validation
- Use `@theaiinc/missive-core` types across all packages
- No barrel exports except `index.ts`

### Naming

- **Packages:** `@theaiinc/missive-{name}`
- **Classes:** PascalCase
- **Functions/Variables:** camelCase
- **Files:** kebab-case for modules, PascalCase for components

### API Design

- RESTful endpoints under `/api/v1/`
- JSON request/response bodies
- Search: `GET /api/v1/search?query=...`
- AI actions: `POST /api/v1/{resource}/{id}/{action}`
- Events emitted via `@nestjs/event-emitter`

### Database

- Migrations in `packages/backend/src/storage/migrations/`
- Naming: `{sequence}_{description}.sql`
- Missive only stores raw comms data + sync state + events

### Connector Pattern

```typescript
class XxxConnector extends BaseConnector {
  readonly provider = 'xxx';
  async connect(config) {
    /* OAuth / API key */
  }
  async sync() {
    /* Fetch and convert */
  }
  async send(payload) {
    /* Send via provider API */
  }
}
```

## PR Checklist

- [ ] Types are updated in `@theaiinc/missive-core`
- [ ] No entity/graph/memory storage added (those belong to Pathway)
- [ ] API endpoint follows existing patterns
- [ ] Database migration is included (if needed)
- [ ] Tests pass (`pnpm test`)
- [ ] Frontend handles loading/error/empty states
- [ ] Events are emitted for Pathway integration
