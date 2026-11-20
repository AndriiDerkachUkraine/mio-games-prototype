# AI-development evidence log

The prototype was built with **Claude Code** as the coding agent, driven by `CLAUDE.md` (invariants, architecture
rules, testing rules, expected workflow). The developer set direction, made the product and engineering decisions,
and gated every phase with a review request ("re-check everything, test what you can, keep the code clean").
Commits are made by the developer after reviewing each phase's diff.

## How the agent's output was verified

| Technique                                               | What it catches                                                 | Where                          |
| ------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------ |
| Integration tests on real Postgres                      | Guarantees that live in the DB (unique keys, CHECKs, row locks) | `test/*.spec.ts`               |
| Real concurrency (`Promise.all` of HTTP calls)          | Races, double credits, deadlocks                                | ingestion, wheel, ledger specs |
| Mutation checks: break a guarantee, expect red, restore | Vacuous tests that pass whatever the code does                  | per phase, below               |
| Coverage review of every uncovered line                 | Untested branches, dead or duplicated code                      | per phase, below               |
| Clean-clone run (`npm ci` → build → compose → tests)    | Works-on-my-machine gaps                                        | phase 1                        |
| HTTP smoke against the compose stack + log inspection   | Wiring, log levels, secret redaction                            | every phase                    |

## Phase 0 — plan, skeleton, schema

- **Planning.** The agent turned the assignment PDF into a requirements matrix, priorities and phases (`docs/PLAN.md`).
  Developer decisions: modular monolith on NestJS + PostgreSQL; Kysely over an ORM so that the SQL carrying the
  guarantees stays visible; separate repository and identity for this work.
- **Generated.** Schema with DB-enforced invariants, migrator, seed, compose, test harness.
- **Defects found in review and fixed.**
  - The migrator's comment claimed one transaction per file; the code used one for all — and created
    `schema_migrations` before taking the advisory lock (race between two starting containers).
  - `CLAUDE.md` claimed composite FKs make cross-tenant references impossible, but `spins` and `redemption_events`
    used simple FKs. Every tenant-owned reference was made composite.
  - "For later" config, unused dependencies and npm scripts pointing at missing files were removed.

## Phase 1 — signed webhooks, dedup, identity mapping, spin grants

- **Generated.** Adapter contract, two platform adapters with different wire formats and signature schemes,
  ingestion service, rules engine, 67 tests.
- **Verification.**
  - Mutations: signature check off → 3 red; freshness check off → 3 red; dedup removed → 2 red.
    The first two mutations initially reported "0 tests": they did not compile under `noUnusedLocals`.
    They were rewritten to compile, and that rule was added to `CLAUDE.md`.
  - Clean-clone run, database-down `/health` → 503 and recovery, graceful container stop.
- **Defects found and fixed.**
  - Structured log call used Nest's `Logger.log(obj, msg)`, which treats `msg` as the _context_; switched to `PinoLogger`.
  - Payload building blocks duplicated across adapters; extracted to shared schemas.
  - `occurredAt` parsed from both formats but never used; removed.
  - Coverage showed Platform B re-parsing the raw body as JSON to read its timestamp; the parsed body is now passed in.

## Phase 2 — player auth, server-authoritative spin, ledger

- **Generated.** Casino-signed JWT guard, HMAC-based unbiased segment picker, conditional spin claim,
  ledger posting with conditional debit, wallet API, 41 tests.
- **Verification.**
  - Mutations: token max-age ×1000, `exp` not required, HS512 allowed → each 1 red;
    spin claim without `status = 'AVAILABLE'` → 3 red; ledger debit without balance condition → 1 red, while the
    concurrent-debit test stayed green because `CHECK (balance >= 0)` still held — the intended second line of defence.
  - Distribution test tightened from `toBeCloseTo(p, 1)` (±0.05, would pass a 5% segment that never wins)
    to ±0.01 at 50k draws (~4.5σ).
- **Defects found and fixed.**
  - **Deadlock under concurrent play** (found by the 20-parallel-requests test, confirmed in the Postgres log):
    resolving a player with a no-op `ON CONFLICT DO UPDATE` locked the player row exclusively, while a concurrent
    spin transaction held the wallet row and needed `FOR KEY SHARE` on the player for its ledger FK check.
    Fixed by a plain `SELECT` first and `DO NOTHING` on first contact; rule recorded in `CLAUDE.md`.
  - Kysely column types: `Generated<ColumnType<…>>` made timestamps read as a wrapper type instead of `Date`
    (latent since phase 0, surfaced by the first endpoint returning a timestamp).
  - Reward segment type declared twice (DB types and validation schema); the schema is now the single source
    and jsonb is typed `unknown` until validated.

### Review pass after phase 2

- **Probing the running API** showed four different error shapes (Nest's `{statusCode, message, error}`, body-parser's
  `{statusCode, message}`, the health check's own shape, and ours). One global filter now returns `{ error, message }`
  for everything; unexpected errors become a generic 500 and are logged with their stack.
- **The new filter's own test caught a regression it introduced:** body-parser's 413 is not an `HttpException`,
  so it was turned into a 500. Client-safe Express errors (`expose: true`, 4xx) are now passed through.
- **A mutation exposed a test gap:** breaking the concurrent first-contact branch of player resolution was not caught
  by the webhook race test (requests rarely hit that window). A test racing webhooks and player-API calls for a brand
  new player now catches it.

## Phase 3 — Bonus Store, redemption and reward delivery

- **Generated.** Reward issuance contract (`issueReward` / `rewardStatus`, one `RewardOutcome` union), shared HTTP
  classification, outbound adapters (A synchronous, B asynchronous), the redemption job table with a leased worker,
  a pure delivery state machine, the mock casino with failure injection, 60 tests.
- **Developer decisions.** A timeout never triggers a refund; the casino's status endpoint is consulted before
  giving up, and anything still unknown goes to `MANUAL_REVIEW` with the coins kept debited. The redemption row is
  the job (no separate outbox table); HTTP calls run outside DB transactions.
- **Verification.**
  - Mutations, each caught: refund on an unknown outcome; no reconciliation (first attempt did not compile —
    rewritten); no lease fencing; a new casino reference per retry (5 red); no refund on rejection; claim ignoring
    leases; no idempotency on redeem; no crash isolation in the worker.
  - In Docker: both casinos end to end, and a real 2 s timeout where the casino issued but the answer was lost —
    retried with the same reference, one grant at the casino.
- **Defects found and fixed.**
  - The smoke script reused a player id and Idempotency-Key, so the "lost response" scenario silently replayed an
    earlier redemption (the system behaved correctly; the check did not test what it claimed). Re-run with unique ids.
  - Timeout detection used `instanceof Error`; `fetch` throws a `DOMException`, which fails that check in another
    realm (surfaced under Jest). Now checked by name.
  - Two copies of Express in the tree after adding it as a direct dependency; pinned to Nest's version (deduped).
