# AI-development evidence log (Part D)

The prototype was built with **Claude Code** (Anthropic, Claude Opus) as the coding agent. The developer set the
direction, made the decisions listed below, reviewed every phase and made every commit by hand after reading the
diff. This log records what the agent did, how its output was checked, and the defects that checking found.

## How AI was used

| Activity             | What the agent did                                                                                                  | Evidence                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Plan                 | Turned the assignment PDF into a requirements matrix, priorities and phases before any code                         | [PLAN.md](PLAN.md)                |
| Generate code        | Wrote the schema, modules, adapters, mock casino, demo script and documentation, phase by phase                     | git history: one commit per phase |
| Create tests         | Wrote invariant-first integration tests on real PostgreSQL, concurrency tests, unit tests for pure logic            | `test/`, 230 tests                |
| Review               | Re-read every phase as a reviewer: duplication, dead code, misleading comments, invariant violations, coverage gaps | phase sections below              |
| Find and fix defects | Mutation checks, concurrency tests, HTTP smoke runs and clean-clone runs surfaced real bugs, fixed before commit    | "Defects" in each phase           |

## Agent instructions and workflow configuration

- [`CLAUDE.md`](../CLAUDE.md) — the agent's standing instructions: non-negotiable financial invariants, architecture
  rules, testing rules, expected workflow. Two rules were added mid-project after real defects (no unnecessary row
  locks on hot paths; mutations must compile to count).
- [`.claude/commands/review-phase.md`](../.claude/commands/review-phase.md) — the review gate run after every
  phase, codified as a reusable command.
- Phase loop: plan the phase → write invariant tests first for anything that moves coins or spins → implement →
  run scoped tests and type check → review gate → developer reads the diff and commits.

## Representative prompts

Translated from Ukrainian and shortened; the developer's own words, not paraphrased intent.

1. _"Don't do anything yet — study the file in detail and work out what has to be done."_
2. _"Check everything once more, in detail, set the priorities and put together an execution plan."_
3. After every phase: _"Re-check everything, test what you can, make sure the code is clean — no duplication, no
   unnecessary comments, comments not too long. Check everything very carefully."_
4. On the admin API scope: _"Why not just build all of it?"_ — the agent argued for a narrower scope (below); the
   developer agreed and deferred the rest.
5. _"Don't commit anything yourself."_

## Decisions: who proposed, who decided

| Decision                                                                       | Proposed by                                         | Decided by                                                   |
| ------------------------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------ |
| Phases, priorities (P0/P1/P2) and what to leave out                            | Agent                                               | Developer approved; asked for a review gate after each phase |
| Modular monolith on NestJS + PostgreSQL                                        | Agent                                               | Developer                                                    |
| Kysely + plain SQL migrations instead of an ORM                                | Agent, when asked "what is best?"                   | Developer                                                    |
| Admin API scope: the review-queue exit plus configuration, no full back office | Agent, after the developer asked why not everything | Developer                                                    |
| A timeout never refunds; reconcile, then manual review                         | Agent (stated in `CLAUDE.md` from phase 0)          | Developer approved                                           |
| Separate repository and identity; commits made only by the developer           | Developer                                           | Developer                                                    |

## How the agent's output was verified

| Technique                                               | What it catches                                                       | Where                                             |
| ------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------- |
| Integration tests on real PostgreSQL                    | Guarantees that live in the database (unique keys, CHECKs, row locks) | `test/*.spec.ts`                                  |
| Real concurrency (`Promise.all` of HTTP calls)          | Races, double credits, deadlocks                                      | ingestion, wheel, ledger, redemption, admin specs |
| Mutation checks: break a guarantee, expect red, restore | Vacuous tests that pass whatever the code does                        | every phase, below                                |
| Coverage review of every uncovered line                 | Untested branches, dead or duplicated code                            | every phase, below                                |
| Clean-clone run (`npm ci` → build → compose → tests)    | Works-on-my-machine gaps                                              | phases 1–3 and the final check                    |
| HTTP smoke against the compose stack + log inspection   | Wiring, log levels, secret redaction                                  | every phase                                       |

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

## Phase 4 — tenant admin API

- **Scope decision (developer).** Not a full back office: only what closes a real gap or demonstrates a design point —
  admin-key auth scoped to the tenant, versioned reward tables, store items, deposit rule, and the exit from
  `MANUAL_REVIEW` (without it, coins of an unresolvable delivery would stay debited forever). Tenant onboarding,
  roles and an admin UI are documented as next steps instead.
- **Generated.** Admin guard, controller with body validation, feature operations kept in their own modules
  (publish in `wheel`, items in `store`, rules in `rules`, review in `redemption`), 35 tests.
- **Verification.** Mutations, each caught: review close not conditional on `MANUAL_REVIEW`; publish without the
  per-tenant lock; admin key of a suspended tenant accepted; rule update not scoped to the tenant (first attempt
  did not compile — rewritten); no refund on a review decision. In Docker: a redemption driven into
  `MANUAL_REVIEW` by the real retry schedule, then refunded by an operator; a second decision answered 409.
- **Defects and cleanups.**
  - A schema edit broke the `.refine` chain (stray semicolon); caught by the type check before any test ran.
  - A scripted import rewrite aborted half-way (shell escaping inside Node); redone with an explicit file list.
  - Duplicates removed: zod issue formatting (3 places), the currency regex (2), `z.uuid()` (4), the redemption
    status list, and the refund posting (worker and operator now share one helper and one idempotency key).

## Phase 6 — demo, sample requests, documentation

- **Generated.** A casino simulator in the mock casino (signed deposit webhooks and player tokens over plain HTTP,
  reusing the adapters' signing code), `scripts/demo.mjs`, `http/mio.http`, API examples captured from the running
  stack by a script, and the architecture, reliability, scaling, 90-day and README documents.
- **Verification.** The demo doubles as a smoke test (exits non-zero on any failed check); every Mermaid diagram
  was run through the Mermaid parser; every relative link in the docs was checked to resolve; numbers quoted in
  the docs were recounted from the test runner.
- **Defects found and fixed.**
  - The simulator looked tenants up with `id in DEV_TENANTS`, so `toString` counted as a tenant; now an own-property
    check, with a test.
  - Docs overstated or misstated facts: "12 invalid variants" (13 by count), a "conformance kit the platforms already
    pass" (it does not exist yet — reworded as planned work), a claim that `mio.http` runs in the VS Code REST
    client (its response handlers are JetBrains-only), and a guessed test count.
  - The captured API examples contained duplicated calls; deduplicated and the omission explained.

## Final review before submission

- **How.** A read-only duplicate scanner over 4-line windows of `src/`, `test/` and the demo (a third-party clone
  detector could not be downloaded in this environment), a scan for exports nobody imports, a listing of every
  comment, then every file re-read.
- **Found and fixed.**
  - The redemption-to-API mapping existed twice (player and admin views); now one `toRedemptionView`.
  - The store-item input type existed twice (seed and repository); now one `NewStoreItem`.
  - A schema comment repeated the one in `db.provider.ts`.
  - The mock casino answered a retry with a refusal when the reward had already been granted under that
    reference, which would make MIO refund a delivered reward. A correct casino returns the existing grant first;
    the mock now does, and a test (red with the old order) pins it.
- **Not changed, with reason.** Exported types used only in their own file are part of public method signatures;
  the remaining uncovered lines are defensive branches (a guard used without its decorator, a database outage
  during claiming).
