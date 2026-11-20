# Reliability and security (Part C)

Two rules drive every decision below:

- **Financially relevant effects happen exactly once.** Each one has a single idempotency anchor enforced by the
  database, so retries, races and redeliveries collapse into the first effect instead of repeating it.
- **Money never moves on a guess.** A rejected reward is refunded; an unknown outcome is retried, reconciled, and
  if it stays unknown a person decides. Coins are never returned for a reward the casino might have delivered.

Every scenario below has named tests that run against the real PostgreSQL (`npm test`). Each guarantee was also
checked by **mutation**: the protecting line was removed or weakened, the tests were run and had to fail, then the
code was restored (see [ai-log.md](ai-log.md)).

## Scenarios

| #   | Scenario                           | Mechanism                                                                                                                                                                                                                                                                                                                                                                              | Tests                                                                                                                                                                                                                        |
| --- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | **Duplicate deposit events**       | `UNIQUE (tenant_id, external_event_id)` on `inbound_events`; the event row and the spins it grants commit in one transaction. A redelivery gets `200 {status: "duplicate"}` so the casino stops retrying. Dedup is per tenant.                                                                                                                                                         | `ingestion.spec` › _C1_: redelivery; 10 concurrent deliveries → 1 spin; redelivered ignored/unsupported events                                                                                                               |
| C2  | **Concurrent spin requests**       | The spin is consumed by one conditional `UPDATE spins … WHERE status = 'AVAILABLE'`; concurrent callers block on the row lock and re-check, exactly one wins. The ledger credit is in the same transaction. Losers and replays receive the stored outcome, so the call is idempotent.                                                                                                  | `wheel.spec` › _C2_: 20 concurrent plays of one spin → 1 credit, identical answers; replay; concurrent plays of different spins                                                                                              |
| C3  | **Duplicate redemption requests**  | `Idempotency-Key` required; `UNIQUE (tenant_id, player_id, idempotency_key)`; the redemption row and the coin debit commit together. Same key → the original redemption (200); same key, different item → 422.                                                                                                                                                                         | `redemption.spec` › _C3_: repeated key; 10 concurrent requests → 1 redemption, 1 debit; key reuse; concurrent purchases never overdraw                                                                                       |
| C4  | **External API timeouts**          | A timeout is classified as _unknown_, never as failure. The retry reuses our `redemption.id` as the casino's idempotency reference, so a casino that did issue answers with the existing grant.                                                                                                                                                                                        | `redemption.spec` › _C4_: "issued but the answer was lost" and "never processed" → issued exactly once; `http-client.spec`                                                                                                   |
| C5  | **Failed reward issuance**         | An explicit refusal (4xx, or an async order that completes as rejected) → `FAILED` plus a compensating `REDEMPTION_REFUND` ledger entry in the same transaction as the status change.                                                                                                                                                                                                  | `redemption.spec` › _C5_: synchronous rejection, asynchronous rejection, wrong casino credentials                                                                                                                            |
| C6  | **Retries and eventual recovery**  | Exponential backoff with jitter. Jobs are leased (`FOR UPDATE SKIP LOCKED`); a crashed worker's job is reclaimed when the lease expires, and its late writes are rejected by the fencing token. Out of attempts, the casino's status endpoint decides: issued → `ISSUED`, no record → refund, unreachable → `MANUAL_REVIEW`. Operators resolve the review queue through the admin API. | `redemption.spec` › _C6_ (transient 5xx, reconciliation both ways, unreachable casino, crash recovery, lost lease, crashing attempt), background worker test; `delivery-decision.spec`; `admin.spec` › _manual review queue_ |
| C7  | **Tenant isolation**               | The tenant always comes from credentials: webhook URL + HMAC with that tenant's secret, JWT `iss` verified with that tenant's key, admin key hash. Every query is scoped by `tenant_id`, and composite foreign keys `(tenant_id, …)` make a row referencing another tenant's row impossible even for buggy code.                                                                       | `ingestion.spec` › _C7_; `wheel.spec` › _unauthorized spins_; `redemption.spec` › _isolation_; `admin.spec` › _tenant scope_; `schema-invariants.spec`                                                                       |
| C8  | **Invalid or unauthorized events** | HMAC over the exact raw bytes, compared in constant time; signed timestamp within ±300 s (replay); strict per-platform schemas; amounts parsed as text, never as floats. Unauthenticated → 401, malformed → 422, and nothing is stored in either case.                                                                                                                                 | `ingestion.spec` › _C8_: 11 unauthorized and 13 invalid variants                                                                                                                                                             |

### No duplicate rewards, no negative balances — defence in depth

| Layer       | Duplicate rewards                                                                                             | Negative balance                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Application | Conditional updates; idempotent replays return the stored result                                              | Conditional debit `balance >= amount` → `409 INSUFFICIENT_BALANCE`      |
| Database    | `UNIQUE` on event id, idempotency keys and ledger `idempotency_key`; spin `CHECK` requires a complete outcome | `CHECK (balance >= 0)` on `wallets` and `balance_after >= 0` on entries |
| Ledger      | Append-only (trigger rejects UPDATE/DELETE); one refund key per redemption shared by worker and operator      | Every entry records `balance_after`                                     |

The database layer was verified on its own: with the application-side balance condition removed, concurrent
debits still never went negative because the `CHECK` constraint held.

## Players cannot manipulate reward probabilities

- **Nothing the client sends influences the outcome.** The play endpoint takes a spin id and nothing else; a body
  claiming a segment or coin amount is ignored (`wheel.spec` › _server authority_).
- **Outcomes cannot be predicted or precomputed.** The draw is `HMAC-SHA256(SPIN_SEED_SECRET, spinId)`. The secret
  never leaves the server (minimum 32 characters, required at start-up) and spin ids are random UUIDs.
- **Outcomes cannot be re-rolled.** The result is deterministic per spin and stored on first play; replays return
  the stored result. There is no endpoint that discards a spin.
- **Weights are never exposed.** Players see `key`, `label` and `coins` only.
- **The draw is unbiased.** Rejection sampling over a 48-bit draw, verified statistically (`spin-outcome.spec`).
- **Changing the odds is an audited operator action.** Reward tables are immutable versions; each played spin
  records the version it was drawn from, so any outcome can be recomputed and checked later.

## Players cannot trigger unauthorized spins

- **Spins exist only as the result of a verified casino event.** `spins.source_event_id` is mandatory and is a
  composite foreign key to a recorded, signature-checked event of the same tenant. No player-facing endpoint
  creates spins.
- **Only the owner can play a spin.** The claim matches spin id, tenant and player; anybody else gets 404, and the
  spin stays available (`wheel.spec` › _unauthorized spins_).
- **Player identity comes from the casino.** A short-lived JWT signed with the tenant's key, `HS256` only (no
  `alg: none`, no algorithm confusion), mandatory `exp` and a server-side maximum age, `iss` must equal the tenant
  whose key verifies it (`player-auth.spec`: 13 rejected token variants).
- **Rules decide who earns what.** Thresholds and currencies are tenant configuration, so "1 spin per deposit"
  cannot be farmed with micro-deposits below the operator's minimum.

## Other security measures

- Admin keys are stored as SHA-256 hashes; a suspended tenant's webhooks, tokens and admin key stop working.
- Errors leave the API as `{ error, message }`; unexpected failures become a generic 500 and are logged with the
  stack, never returned (`api-errors.spec`).
- Caller-supplied `X-Request-Id` values are accepted only in a safe shape before being echoed into logs;
  `Authorization` and admin keys are redacted from request logs.
- Request bodies are capped (100 kB); oversized bodies get 413.

## Known gaps (deliberate for the prototype)

| Gap                                                               | Production approach                                                                                                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Secrets (webhook, token, reward API keys) stored in plain columns | Envelope encryption with a KMS; key versioning and rotation with an overlap window                                                                                                               |
| No rate limiting                                                  | Per-tenant and per-player limits at the edge (spins, redemptions, webhook bursts)                                                                                                                |
| Tenant scoping relies on code + composite FKs                     | Add PostgreSQL row-level security as a third layer                                                                                                                                               |
| Single global spin secret                                         | Per-tenant secrets with versioning; optionally commit–reveal for provably fair spins                                                                                                             |
| Admin keys are per tenant, not per person                         | SSO for operators, roles, per-user audit trail                                                                                                                                                   |
| Casino lost an order after acceptance, then the attempts run out  | Covered by reconciliation, but a casino that recreates a reward after we refunded would double-pay; a production contract should forbid late issuance after a status lookup returned "not found" |
