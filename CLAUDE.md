# CLAUDE.md — agent instructions for the MIO Games prototype

You are working on a vertical slice of MIO Games: a multi-tenant gamification SaaS for online casinos.
Read `docs/PLAN.md` (requirements traceability + phases) before changing anything.

## Non-negotiable invariants

These are the reason this codebase exists. Never weaken them, and never "fix" a failing test by relaxing one.

1. **No duplicate rewards.** Every financially relevant effect has exactly one idempotency anchor:
   - inbound event → `UNIQUE (tenant_id, external_event_id)` on `inbound_events`
   - spin outcome → conditional `UPDATE spins … WHERE status = 'AVAILABLE'`
   - coin movement → `UNIQUE (tenant_id, idempotency_key)` on `ledger_entries`
   - redemption → `UNIQUE (tenant_id, player_id, idempotency_key)` on `redemptions`
   - outbound issuance → our `redemption.id` is sent to the casino as its idempotency reference
2. **No negative balances.** Debits are conditional updates (`balance >= :amount`) and `wallets.balance` has `CHECK (balance >= 0)`.
3. **Ledger is append-only.** Corrections are compensating entries. A DB trigger rejects UPDATE/DELETE.
4. **Tenant comes from credentials, never from the request body.** Webhook → URL tenant + HMAC with that tenant's secret.
   Player API → casino-signed JWT verified with that tenant's key. Admin API → tenant admin key.
   Every query is scoped by `tenant_id`; composite FKs make cross-tenant references impossible.
5. **Spin outcomes are server-authoritative.** The client only names a spin id. Weights live on the server;
   the outcome is `HMAC(SPIN_SEED_SECRET, spin_id)` mapped onto the active reward table (unbiased, deterministic, auditable).
6. **A timeout is not a failure.** Never refund after an ambiguous outbound call; retry with the same reference,
   and before giving up reconcile through the casino's status endpoint. Unresolvable → `MANUAL_REVIEW`.

## Architecture rules

- Modular monolith (NestJS). Modules: `tenancy`, `integrations`, `ingestion`, `players`, `rules`, `wheel`,
  `ledger`, `store`, `redemption`, `admin`.
- **All casino-specific shapes live in `src/modules/integrations/<platform>/`.** Core modules only see
  `InboundParseResult` (normalized events), `RewardDescriptor` and `IssueResult`. Adding a casino = adding an adapter + registering it.
- Money-moving code runs inside one DB transaction and relies on DB constraints, not on read-then-write checks.
- Expected failures are `DomainError`s with a stable code, mapped to HTTP by one exception filter; controllers stay thin.

## Testing rules

- Tests hit the **real Postgres** (`mio_test` database). Never mock the database: the guarantees under test live there.
- Every reliability scenario from Part C has a named test. Concurrency is tested with real parallel requests.
- External casinos are the in-process mock (`src/mock-casino`) driven through its `/__control` endpoint.
- Run scoped: `npx jest --runInBand test/<file>.spec.ts`. Full suite: `npm test`.

## Conventions

- TypeScript strict. English everywhere. Comments explain _why_, not _what_.
- SQL migrations are plain, forward-only files in `migrations/`.
- Keep controllers free of business logic; keep adapters free of business rules.

## Workflow expected from the agent

1. Restate the task and list touched invariants before coding.
2. For anything that moves coins or spins: write the failing test first.
3. Implement the smallest change; run the scoped tests; then `npm run typecheck`.
4. Self-review the diff against the invariants above and report what was verified and how.
