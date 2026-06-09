# Missive ROADMAP

## Architecture Boundary
| Capability | Owner |
|---|---|
| Raw comms ingest, normalize, serve | **Missive** |
| Full-text search over raw comms | **Missive** |
| AI summary, classification | **Missive** |
| Entity extraction (raw → emit) | **Missive** |
| Graph relationships, entity store | **Pathway** |
| Thread memory, decisions, action items | **Pathway** |
| Knowledge memory, org memory | **Pathway** |
| Orchestration, event routing | **Pathway** |
| Agent reasoning & decision making | **Cognition** |
| Action execution | **Cognition** |
| Agent state, decision logs | **Cognition** |

## Phase 1 — Foundation (MVP)
- [x] Monorepo setup (pnpm workspaces, TypeScript)
- [x] Core types and interfaces defined
- [x] API surface specified
- [x] In-memory storage layer
- [ ] Gmail connector (OAuth + sync)
- [ ] Outlook connector (OAuth + sync)
- [ ] Unified inbox UI
- [ ] Search UI
- [ ] AI summarization
- [ ] AI classification
- [ ] PG storage (migration ready)

## Phase 2 — Connect
- [ ] Facebook Messenger connector
- [ ] Slack connector
- [ ] Discord connector
- [ ] CRM connector plugin system
- [ ] Help desk connector plugin system
- [ ] Connector management UI
- [ ] Entity extraction → Pathway event pipeline
- [ ] Pathway integration: Missive events → Pathway graph

## Phase 3 — Intelligence
- [ ] Deep Pathway event integration (bidirectional)
- [ ] Scheduled sync and polling
- [ ] Webhook support
- [ ] Auto-classification rules engine
- [ ] Smart notifications
- [ ] Cross-entity graph queries (via Pathway)
- [ ] Cognition agent integration (first agent: comms triage)

## Phase 4 — Autonomous
- [ ] Autonomous communication agents
- [ ] Team knowledge network
- [ ] Proactive insights
- [ ] Cross-platform conversation continuity
- [ ] Custom AI workflows
- [ ] API for third-party agents
- [ ] Real-time collaboration

## Success Metrics
- Connected accounts per user
- Messages synced
- Daily active search usage
- AI summaries generated
- Pathway events emitted
- Cognition agent actions triggered
- Time saved per user