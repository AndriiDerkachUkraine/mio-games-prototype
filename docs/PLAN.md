# Implementation plan

This is the working plan the prototype was built from. It was drafted together with an AI assistant
(Claude Code) from the assignment PDF and then reviewed and adjusted by hand; see `docs/ai-log.md`.

## 1. Requirements traceability

| ID    | Requirement                                                         | How it is addressed                                                                                                                  | Evidence                       |
| ----- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| A1    | Multi-tenant SaaS, tenant isolation                                 | Tenant resolved from credentials only; `tenant_id` on every row; composite FKs `(tenant_id, player_id)`                              | tests + `docs/architecture.md` |
| A2    | Casino integration layer, different external APIs                   | Adapter registry: inbound parser/verifier + outbound reward client per platform                                                      | `src/modules/integrations`     |
| A3    | Player identity mapping                                             | `players (tenant_id, external_player_id)` unique; created lazily on first event / first session                                      | code + tests                   |
| A4    | Event ingestion, validation, dedup, processing                      | HMAC + timestamp window → schema → `inbound_events` unique → rules, in one transaction                                               | tests                          |
| A5    | Gamification rules engine                                           | `gamification_rules` (trigger, currency, min amount → N spins), evaluated on normalized events                                       | code                           |
| A6    | Virtual currency ledger                                             | Append-only `ledger_entries` + `wallets` projection with `CHECK (balance >= 0)`                                                      | tests                          |
| A7    | Reward redemption and delivery                                      | Redemption row = durable job; leased worker; state machine; retries; reconciliation; refunds                                         | tests                          |
| A8    | Admin configuration                                                 | Tenant-scoped admin API: reward table versions, store items, redemption review                                                       | code                           |
| A9    | Observability, auditability, security                               | Structured logs with correlation id; raw event store, ledger, redemption history; HMAC, JWT, hashed keys                             | code + docs                    |
| A10   | Diagram, decisions, modules vs services                             | `docs/architecture.md`                                                                                                               | docs                           |
| B1–B8 | End-to-end flow                                                     | E2E test per casino + `scripts/demo.sh`                                                                                              | tests                          |
| B9    | Two platforms, different event schemas and reward APIs, shared core | Platform A: flat JSON, cents, synchronous issuance. Platform B: nested JSON, decimal strings, asynchronous issuance + status polling | tests                          |
| C1    | Duplicate deposit events                                            | Unique inbound event; duplicate answered `200 {duplicate:true}`                                                                      | test                           |
| C2    | Concurrent spin requests                                            | Conditional update on spin status; replay returns the stored outcome                                                                 | test                           |
| C3    | Duplicate redemption requests                                       | `Idempotency-Key` unique per player; replay returns the original redemption                                                          | test                           |
| C4    | External API timeouts                                               | Ambiguous outcome → retry with same reference; casino dedups by reference                                                            | test                           |
| C5    | Failed reward issuance                                              | Definitive rejection → `FAILED` + compensating refund entry                                                                          | test                           |
| C6    | Retries and eventual recovery                                       | Exponential backoff; lease expiry recovers jobs of crashed workers; reconciliation before refund                                     | test                           |
| C7    | Tenant isolation                                                    | Cross-tenant access attempts return 401/404                                                                                          | test                           |
| C8    | Invalid or unauthorized events                                      | Bad/missing signature, stale timestamp, malformed payload, non-positive amount                                                       | test                           |
| C9    | No duplicate rewards / no negative balances                         | DB constraints + idempotency keys (see `CLAUDE.md`)                                                                                  | tests                          |
| C10   | Anti-manipulation of probabilities / unauthorized spins             | `docs/reliability-and-security.md`                                                                                                   | docs                           |
| D     | AI-native development evidence                                      | `CLAUDE.md`, `.claude/`, `docs/ai-log.md`, commit trailers                                                                           | docs                           |
| E1–E6 | Scaling questions                                                   | `docs/scaling.md`                                                                                                                    | docs                           |
| E7    | First 90-day plan                                                   | `docs/90-day-plan.md`                                                                                                                | docs                           |
| X     | Docker Compose, README, sample requests                             | `docker-compose.yml`, `README.md`, `http/`, `scripts/demo.sh`                                                                        | files                          |

## 2. Priorities

**P0 — required for a credible submission**

- Compose + seed (two operators, reward table, store items, rule).
- Webhooks for both platforms: signature, validation, dedup, identity mapping, spin grant.
- Player session token, spin, ledger, wallet.
- Store, redemption, worker, issuance via both adapters, retries, refunds, status API.
- Tests for every Part C scenario + E2E for both casinos.
- README, architecture diagram, sample requests, AI log, scaling answers, 90-day plan.

**P1 — strengthens the result**

- Admin API (reward table versioning, store items, manual review queue).
- Reconciliation through casino status endpoint before refunding; `MANUAL_REVIEW` escalation.
- Correlation-id logging, demo script driving the mock casinos.
- Dedicated AI review pass with fixed findings recorded in the AI log.

**P2 — only if everything above is done**

- Postgres row-level security as defence in depth, `/metrics`, rate limiting.
- Webhook callbacks from Platform B instead of polling; spin expiry and daily caps.

**Out of scope (documented, not built):** real casino integrations, UI, message broker, Kubernetes,
currency conversion, admin UI.

## 3. Phases

| #   | Phase                                                                                                  | Done when                                             |
| --- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| 0   | Repo, agent instructions, this plan, NestJS skeleton, compose, migrations, seed                        | `docker compose up` → `/health` 200; smoke test green |
| 1   | Tenancy + HMAC, inbound adapters A/B, normalization, dedup, players, rules → spins                     | C1, C7, C8 tests green                                |
| 2   | Player token, weighted pick, spin, ledger, wallet                                                      | C2 + distribution/determinism tests green             |
| 3   | Store, redemption, worker, mock casino, outbound adapters, state machine, retries, refunds, status API | C3–C6 + both E2E tests green                          |
| 4   | Admin API, logging polish (P1)                                                                         | —                                                     |
| 5   | AI review pass, fixes, AI log entries                                                                  | findings fixed, suite green                           |
| 6   | README, architecture, reliability, scaling, 90-day plan, AI log, samples; clean-clone run              | fresh clone works by following README                 |

## 4. Key decisions (details in `docs/architecture.md`)

1. **Modular monolith on PostgreSQL.** Correctness relies on transactions, unique/check constraints and row locks in one database.
   No Kafka/Redis in the prototype: a durable job table with `FOR UPDATE SKIP LOCKED` covers delivery.
2. **Synchronous, transactional event processing.** Verify → store event → map player → evaluate rules → grant spins, atomically.
   The evolution path to inbox + queue is described in `docs/scaling.md`.
3. **Deterministic, server-authoritative spins.** `HMAC(secret, spin_id)` → unbiased index over weights; the reward table version is stored with the outcome.
4. **Append-only ledger + balance projection,** updated in the same transaction with a conditional debit.
5. **Redemption state machine:** `PENDING → (AWAITING_CONFIRMATION) → ISSUED | FAILED (+refund) | MANUAL_REVIEW`.
6. **Platform B uses status polling** rather than callbacks: one less inbound channel to secure in the prototype.
7. **Mock casino as a separate small app** with a control endpoint to inject failures (5xx, timeout, lost response, rejection).
