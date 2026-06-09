
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/badge/Missive-Communication_Intelligence_Layer-6366f1?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDgiIGhlaWdodD0iNDgiIHZpZXdCb3g9IjAgMCA0OCA0OCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iNDgiIGhlaWdodD0iNDgiIHJ4PSIxMiIgZmlsbD0iIzYzNjZmMSIvPjxwYXRoIGQ9Ik0xNCAxOEwyNCAyNkwzNCAxOE0xNCAzMEwyNCAyMkwzNCAzMCIgc3Ryb2tlPSJ3aGl0ZSIgc3Ryb2tlLXdpZHRoPSIzIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz48L3N2Zz4="/>
  <img src="https://img.shields.io/badge/Missive-Communication_Intelligence_Layer-6366f1?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDgiIGhlaWdodD0iNDgiIHZpZXdCb3g9IjAgMCA0OCA0OCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iNDgiIGhlaWdodD0iNDgiIHJ4PSIxMiIgZmlsbD0iIzYzNjZmMSIvPjxwYXRoIGQ9Ik0xNCAxOEwyNCAyNkwzNCAxOE0xNCAzMEwyNCAyMkwzNCAzMCIgc3Ryb2tlPSJ3aGl0ZSIgc3Ryb2tlLXdpZHRoPSIzIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz48L3N2Zz4=" alt="Missive"/>
</picture>

<h1 align="center">Missive</h1>
<p align="center">
  <strong>Communication Intelligence Layer</strong><br>
  Unify, search, and reason over all your communications — from any channel, with AI.
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#roadmap">Roadmap</a> •
  <a href="#contributing">Contributing</a>
</p>

<br>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white"/>
  <img src="https://img.shields.io/badge/NestJS-E0234E?style=flat-square&logo=nestjs&logoColor=white"/>
  <img src="https://img.shields.io/badge/React-20232A?style=flat-square&logo=react&logoColor=61DAFB"/>
  <img src="https://img.shields.io/badge/PostgreSQL-316192?style=flat-square&logo=postgresql&logoColor=white"/>
  <img src="https://img.shields.io/badge/IMAP-FF6B35?style=flat-square&logo=maildotru&logoColor=white"/>
  <img src="https://img.shields.io/badge/LM_Studio-FF6F00?style=flat-square&logo=llama&logoColor=white"/>
  <img src="https://img.shields.io/badge/shadcn/ui-000000?style=flat-square&logo=shadcnui&logoColor=white"/>
  <img src="https://img.shields.io/badge/TanStack_Query-FF4154?style=flat-square&logo=reactquery&logoColor=white"/>
</p>

---

## Overview

Missive is an open-source **Communication Intelligence Layer** that treats communication as knowledge rather than messages. It ingests emails and messages from multiple providers, normalizes them into a unified data model, and applies AI to classify, summarize, and surface what matters.

Instead of jumping between Gmail, Outlook, Slack, and your CRM, Missive gives you a single pane of glass — with an AI layer that learns how you work.

## Features

### Universal Inbox
| Provider | Method | Status |
|----------|--------|--------|
| **Gmail** | OAuth 2.0 (read, send, modify) | ✅ |
| **Outlook / Microsoft 365** | OAuth 2.0 (read, send, IMAP access) | ✅ |
| **Any IMAP/POP3 server** | Direct IMAP + XOAUTH2 | ✅ |

### AI Intelligence
- **Auto-classification** — Batch AI classification of incoming messages (invoice, support, newsletter, notification, meeting, personal, spam, other) with heuristic fallbacks
- **Smart Digest** — AI-generated executive summaries highlighting what needs attention, with importance scoring
- **Semantic Search** — Ask natural-language questions about your communications via LM Studio
- **Folder Organization** — AI suggests and moves emails to appropriate folders
- **Rule Engine** — Custom evaluation rules for auto-handling messages

### Modern UI
- **Inbox with infinite scroll** — Folder-based views with pagination
- **Thread view** — Full conversation timeline with HTML email rendering
- **Search** — Combined keyword + AI semantic search with smart debouncing
- **Notification panel** — Real-time bell icon with unread count, toasts, and browser notifications
- **Dark mode** — System-aware theme with manual toggle
- **Connection status** — Sync timestamps and account management in Settings

### Technical
- **Monorepo** — `pnpm` workspaces, shared TypeScript configs
- **Type-driven** — Zod schemas, shared `@theaiinc/missive-core` types
- **Robust error handling** — Global JSON exception filter, graceful AI fallbacks
- **No vendor lock-in** — LM Studio for local AI inference (OpenAI-compatible API)

## Architecture

```
missive/
├── packages/
│   ├── core/           # Shared types, Zod schemas, API contracts
│   ├── backend/        # NestJS REST API server
│   │   ├── src/
│   │   │   ├── connector.controller.ts   # OAuth + IMAP connection endpoints
│   │   │   ├── connector.store.ts         # Credential & token management
│   │   │   ├── imap-sync.service.ts       # IMAP/POP3 sync engine
│   │   │   ├── sync.service.ts            # Gmail + Outlook sync
│   │   │   ├── sync-scheduler.ts          # Periodic auto-sync (5min)
│   │   │   ├── organizer.service.ts       # AI classification + digest
│   │   │   ├── search.service.ts          # Full-text search
│   │   │   ├── chat.service.ts            # AI chat + rule proposals
│   │   │   ├── missive.controller.ts      # Message CRUD
│   │   │   ├── digest.controller.ts       # Digest endpoints
│   │   │   ├── folder.controller.ts       # Folder management
│   │   │   ├── rule.controller.ts         # Rule engine
│   │   │   ├── json-exception.filter.ts   # Global error handler
│   │   │   └── storage/                   # PostgreSQL + migrations
│   │   └── .env.example
│   ├── connectors/      # Provider connector interfaces
│   ├── ai/              # AI service abstractions
│   └── web/             # React + Vite frontend
│       └── src/
│           ├── components/
│           │   ├── Layout.tsx             # App shell, sidebar, nav
│           │   ├── NotificationPanel.tsx  # Bell icon + digest + toasts
│           │   ├── ChatWidget.tsx          # Floating AI assistant
│           │   └── ui/                    # shadcn/ui components
│           ├── hooks/
│           │   ├── useNotifications.ts    # Polling, digest, toast mgmt
│           │   └── useTheme.tsx           # Dark mode persistence
│           └── pages/
│               ├── Inbox.tsx              # Infinite-scroll inbox with search
│               ├── ThreadView.tsx         # Email thread reader
│               ├── Search.tsx             # Dedicated search page
│               └── Settings.tsx           # Account connections, presets
├── docker-compose.yml   # PostgreSQL + pg_trgm
├── tsconfig.base.json   # Shared TS configuration
└── package.json         # Workspace root
```

### Data Flow

```
Email Providers (Gmail, Outlook, IMAP)
        │
        ▼
  Sync Services ───► PostgreSQL
        │                │
        ▼                ▼
  Organizer Service ──► Classifications & Digests
  (AI via LM Studio)     │
                         ▼
              API ───► React Frontend
```

## Quick Start

### Prerequisites

- **Node.js** >= 20
- **pnpm** >= 9
- **Docker** (for PostgreSQL)
- **LM Studio** (for AI features) — [Download](https://lmstudio.ai/)

### 1. Start PostgreSQL

```bash
docker compose up -d
```

### 2. Start LM Studio

```bash
# Open LM Studio, load a model (e.g., google/gemma-4-26b-a4b-qat),
# and start the local inference server on port 1234
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env with your OAuth credentials (Gmail, Outlook) if desired
# The defaults work for IMAP-only usage
```

### 4. Install & run

```bash
pnpm install
pnpm dev
```

- **Frontend:** http://localhost:5173
- **Backend:** http://localhost:4000
- **AI Server:** http://127.0.0.1:1234 (LM Studio)

## Configuration

### Environment Variables (`.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/missive` | PostgreSQL connection string |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed CORS origin |
| `PORT` | `4000` | Backend API port |
| `AUTO_SYNC_INTERVAL_MS` | `300000` | Auto-sync interval (ms) |
| `LM_STUDIO_BASE_URL` | `http://127.0.0.1:1234/v1` | LM Studio API endpoint |
| `LM_STUDIO_MODEL` | `google/gemma-4-26b-a4b-qat` | Model name for AI operations |
| `LM_STUDIO_TIMEOUT_MS` | `120000` | AI request timeout (ms) |
| `GMAIL_CLIENT_ID` | — | Google OAuth client ID |
| `GMAIL_CLIENT_SECRET` | — | Google OAuth client secret |
| `OUTLOOK_CLIENT_ID` | — | Microsoft OAuth client ID |
| `OUTLOOK_CLIENT_SECRET` | — | Microsoft OAuth client secret |
| `OUTLOOK_TENANT` | `common` | Microsoft OAuth tenant |

### Connecting Email Accounts

**Gmail/Outlook (OAuth):** Click "Add account" in Settings → authorize via OAuth.

**IMAP/POP3:** Use the IMAP form in Settings with:
- **Presets:** One-click fill for Gmail, Outlook.com, Yahoo, iCloud
- **Test Connection:** Validate credentials before saving
- **XOAUTH2:** Quick-connect using an already-authorized OAuth account

## Architecture Philosophy

Missive is designed as a **read-heavy, event-emitting layer** within a larger AI platform:

| Capability | Owned By |
|-----------|----------|
| Raw comms ingest, normalize, serve | **Missive** |
| Full-text search | **Missive** |
| AI classification & summarization | **Missive** |
| Entity extraction (→ events) | **Missive** |
| Graph relationships, entity store | **Pathway** |
| Memory (thread, decisions, org) | **Pathway** |
| Agent reasoning & action | **Cognition** |

Missive **emits events** → Pathway **ingests, relates, stores** → Cognition **reasons and acts**.

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for the full plan.

### Phase 1 — Foundation (Current)
- [x] Monorepo & TypeScript setup
- [x] Gmail + Outlook + IMAP sync
- [x] PostgreSQL storage with migrations
- [x] Unified inbox with infinite scroll
- [x] AI classification, folder organization, digest
- [x] Dark mode, notifications, search
- [ ] Additional connectors (Messenger, Slack, Discord)
- [ ] Entity extraction → Pathway event pipeline

### Phase 2 — Intelligence
- [ ] Deep Pathway integration (bidirectional)
- [ ] Webhook support
- [ ] Auto-classification rules engine
- [ ] Smart notifications
- [ ] Cross-entity graph queries

### Phase 3 — Autonomous
- [ ] Autonomous communication agents
- [ ] Team knowledge network
- [ ] Proactive insights
- [ ] Cross-platform conversation continuity

## Contributing

Please read [CONTRIBUTION_GUIDELINES.md](./CONTRIBUTION_GUIDELINES.md) for conventions on:

- Project structure & naming
- API design patterns
- Database migrations
- Connector development

### Quick Tips

```bash
# Build all packages
pnpm build

# Test all packages
pnpm test

# Format code
pnpm format
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Runtime** | Node.js 20+, TypeScript 5.7+ |
| **Backend** | NestJS (express platform) |
| **Frontend** | React 19, Vite 6, TanStack Query |
| **UI** | shadcn/ui, Tailwind CSS 4, Lucide icons |
| **Database** | PostgreSQL 16 (docker), custom migration system |
| **AI** | LM Studio (local, OpenAI-compatible API) |
| **Email (Gmail)** | `googleapis`, OAuth 2.0 |
| **Email (Outlook)** | Microsoft Graph API, OAuth 2.0 |
| **Email (IMAP)** | `imapflow`, `mailparser`, XOAUTH2 |
| **Auth** | OAuth 2.0 (Google, Microsoft), IMAP App Passwords |

## License

MIT — see [LICENSE](./LICENSE) for details.

---

<p align="center">
  <sub>Built with ❤️ by <a href="https://theaiinc.com">The AI Inc</a></sub>
</p>
