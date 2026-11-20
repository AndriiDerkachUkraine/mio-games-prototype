# MIO Games — vertical slice

A working prototype of MIO Games' core loop: two simulated casino operators with different integration APIs feed
deposit events into one multi-tenant platform, players earn a Wheel of Fortune spin, win coins that are recorded in
a ledger, and redeem them in a Bonus Store for rewards that MIO asks the casino to deliver — with the duplicates,
races, timeouts and failures of Part C handled and tested.

| Assignment step                                                     | Where it happens                                                                    |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1. Casino Platform A sends a successful deposit event               | `POST /v1/integrations/casino-a/events` (Platform A format, HMAC-signed)            |
| 2. MIO validates and processes it                                   | signature + replay window, schema, dedup, identity mapping — one transaction        |
| 3. The player receives one spin                                     | `gamification_rules`: deposit ≥ 10.00 → 1 spin                                      |
| 4. Deterministic, server-authoritative reward from a weighted table | `POST /v1/me/spins/:id/play` — `HMAC(secret, spinId)` over the active table version |
| 5. Coins recorded in the ledger                                     | append-only `ledger_entries` + `wallets`, same transaction as the spin              |
| 6. Redeem coins in the Bonus Store                                  | `POST /v1/me/redemptions` with `Idempotency-Key`                                    |
| 7. Issuance through the casino adapter                              | delivery worker → Platform A (sync) or Platform B (async) reward API                |
| 8. Final status tracked and exposed                                 | `GET /v1/me/redemptions/:id` with full status history                               |

Casino B runs the same loop with a different event schema, signature scheme, units and an asynchronous reward API.

## Quick start

Requirements: Docker with Compose v2, and Node.js 22+ for the demo and the tests.

```bash
docker compose up --build -d   # PostgreSQL, migrations + seed, mock casino, API
npm ci
npm run demo                   # both casinos end to end, then the failure scenarios; exits 1 on any surprise
```

| Service                                                 | URL                                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------- |
| MIO API                                                 | http://localhost:3100 (`/health`)                                           |
| Mock casino (reward APIs, simulator, failure injection) | http://localhost:4100                                                       |
| PostgreSQL                                              | `localhost:5433`, user/password `mio`/`mio`, databases `mio` and `mio_test` |

To poke at the API by hand, open [`http/mio.http`](http/mio.http) in WebStorm/IntelliJ, or read the captured
requests and responses in [docs/api-examples.md](docs/api-examples.md).

## Tests

```bash
docker compose up -d postgres
npm ci
npm test                       # 230 tests against the real PostgreSQL (mio_test), under a minute
```

The suite runs against the real database on purpose: idempotency, balance and isolation guarantees live in
constraints and row locks. Every guarantee was also mutation-checked — the protecting line was weakened and a named
test had to fail. `npm run typecheck` and `npm run format:check` complete the CI-style checks.

## API

| Audience     | Endpoints                                                                                                                                                                                                                                  | Auth                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Casino → MIO | `POST /v1/integrations/:tenantId/events`                                                                                                                                                                                                   | HMAC signature of the tenant's platform     |
| Player       | `GET /v1/me/spins`, `POST /v1/me/spins/:id/play`, `GET /v1/me/wallet`, `GET /v1/store/items`, `POST /v1/me/redemptions`, `GET /v1/me/redemptions[/:id]`                                                                                    | `Authorization: Bearer <casino-signed JWT>` |
| Operator     | `GET/POST /v1/admin/reward-tables`, `GET/POST /v1/admin/store-items`, `PATCH /v1/admin/store-items/:id`, `GET /v1/admin/rules`, `PATCH /v1/admin/rules/:id`, `GET /v1/admin/redemptions?status=`, `POST /v1/admin/redemptions/:id/resolve` | `X-Admin-Key`                               |
| Ops          | `GET /health`                                                                                                                                                                                                                              | —                                           |

Errors are always `{ "error": "CODE", "message": "…" }`. Mock casino helpers (not part of MIO):
`POST /__simulate/:tenantId/deposit`, `POST /__simulate/:tenantId/player-token`,
`POST /__control/:platform/failures`, `GET /__control/:platform/grants`.

### Development credentials (public on purpose)

| Tenant     | Platform     | Currency | Webhook secret                | Player-token secret                | Admin key                |
| ---------- | ------------ | -------- | ----------------------------- | ---------------------------------- | ------------------------ |
| `casino-a` | `platform-a` | EUR      | `dev-casino-a-webhook-secret` | `dev-casino-a-player-token-secret` | `dev-casino-a-admin-key` |
| `casino-b` | `platform-b` | USD      | `dev-casino-b-webhook-secret` | `dev-casino-b-player-token-secret` | `dev-casino-b-admin-key` |

## Documentation

| Document                                                             | Contents                                                                                     |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)                         | Part A: diagrams, modules, key decisions, modules vs services, coverage of each Part A topic |
| [docs/reliability-and-security.md](docs/reliability-and-security.md) | Part C: every scenario with its mechanism and tests, anti-manipulation, known gaps           |
| [docs/scaling.md](docs/scaling.md)                                   | Part E: production readiness, 10 operators, new game features, team, AI automation           |
| [docs/90-day-plan.md](docs/90-day-plan.md)                           | Part E: the first 90 days                                                                    |
| [docs/ai-log.md](docs/ai-log.md)                                     | Part D: how AI was used, decisions, verification, defects found per phase                    |
| [docs/api-examples.md](docs/api-examples.md)                         | Sample requests and responses captured from the running stack                                |
| [docs/PLAN.md](docs/PLAN.md)                                         | The plan the work followed: requirements traceability, priorities, phases                    |
| [CLAUDE.md](CLAUDE.md)                                               | Instructions the coding agent worked under                                                   |

## Technology choices

| Choice                              | Why                                                                                                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript, NestJS 11               | Modules with explicit boundaries and dependency injection map directly onto the modular-monolith design; one language for API, worker and tests                |
| PostgreSQL 17                       | The guarantees are relational: transactions, `UNIQUE`/`CHECK`/composite FKs, `FOR UPDATE SKIP LOCKED` for the job queue — no extra broker needed at this stage |
| Kysely + plain SQL migrations       | Type-safe queries while keeping the SQL that carries a guarantee readable as SQL; no ORM hiding locks or upserts                                               |
| Zod                                 | One schema per payload for validation and types: platform wire formats, request bodies, configuration, jsonb columns                                           |
| pino (nestjs-pino)                  | Structured JSON logs with a correlation id per request                                                                                                         |
| Jest + supertest on a real database | Concurrency and constraint behaviour cannot be tested against mocks                                                                                            |
| Docker Compose                      | One command for the whole stack, including the mock casino                                                                                                     |

## Assumptions

- One successful deposit of at least 10.00 in the operator's currency grants one spin; operators can change the
  threshold, currency and spin count. Pending and failed deposits are recorded but grant nothing.
- Coins are integers and do not expire. Fiat amounts use two-decimal currencies and are never parsed as floats.
- Every wheel segment pays coins; non-coin prizes go through the Bonus Store.
- The casino authenticates its players and hands the front end a short-lived JWT signed with the tenant's key
  (`iss` = tenant, `sub` = casino player id). MIO never handles player credentials.
- A casino's reward API must be idempotent on the reference MIO sends (the redemption id). The mock casinos are.
- Platform B confirms asynchronous rewards through a status endpoint that MIO polls; no inbound callback.
- One region and one database; dev secrets are committed on purpose and are not used anywhere else.

## Priorities and what is not built

Priorities followed [docs/PLAN.md](docs/PLAN.md): first everything the workflow and Part C require, with tests for
each guarantee; then the admin pieces that close real gaps (versioned reward tables, configuration, and the exit
from `MANUAL_REVIEW` so coins cannot stay stuck); then documentation.

Deliberately not built, with the production approach in [docs/scaling.md](docs/scaling.md) and
[docs/reliability-and-security.md](docs/reliability-and-security.md#known-gaps-deliberate-for-the-prototype):

- tenant onboarding, operator accounts with roles, and any UI (player widget, back office);
- an inbox in front of webhook processing, a message broker, a `/metrics` endpoint and tracing export;
- secrets encryption with a KMS, row-level security, rate limiting;
- Platform B callbacks (polling covers completion), spin expiry and daily caps.

## Project layout

```
src/
  modules/
    integrations/   casino adapters (platform-a, platform-b), contract, HTTP classification
    ingestion/      webhook endpoint
    players/        identity mapping, player JWT guard
    rules/  wheel/  ledger/  store/  redemption/  admin/  tenancy/
  mock-casino/      simulated casino APIs, failure injection, demo simulator
  common/           errors, crypto, validation, shared schemas
  db/               Kysely types, migrator, seed
migrations/         plain SQL, forward-only
test/               integration and unit tests (real PostgreSQL)
scripts/demo.mjs    end-to-end demo, plain HTTP
http/mio.http       runnable requests
docs/               architecture, reliability, scaling, 90-day plan, AI log, API examples
```
