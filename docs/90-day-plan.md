# First 90 days — engineering plan

Goal: **a live pilot with the first casino by day 90**, on a platform that can take the next integrations without
rework. The prototype in this repository is the starting point, not something to rewrite.

## Days 1–30 — foundation and the first real integration

| Track                  | Outcome                                                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery              | With the CEO/product: the pilot casino and its platform, the MVP feature cut, success metrics; the casino's real API docs and sandbox access                                                       |
| Delivery pipeline      | CI on every PR (type check, tests against PostgreSQL, mutation sampling on money-moving modules); IaC for staging and production; managed PostgreSQL with point-in-time recovery; secrets in a KMS |
| Observability baseline | OpenTelemetry traces and metrics, log aggregation, error tracking, first SLOs: webhook acknowledgement latency, delivery success, review-queue size                                                |
| First real adapter     | The pilot platform's adapter behind the existing contract; a conformance kit extracted from today's per-platform tests (signatures, replays, duplicates, status mapping, idempotent issuance)      |
| Hiring                 | Backend and frontend engineers in the pipeline from week one; first hire onboarded by day 30                                                                                                       |

Exit criteria: staging receives real sandbox events from the pilot casino end to end; every PR is gated by CI.

## Days 31–60 — product surface

| Track                | Outcome                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Player experience    | Embeddable widget and SDK for the casino front end: wheel, wallet, Bonus Store, redemption status                           |
| Operator back office | UI over the admin API: reward tables with an odds preview, store items, rules, review queue, basic reports                  |
| Missions v1          | Transactional outbox of normalized events; missions as progress trackers over them, sharing the ledger and reward catalogue |
| Hardening            | Per-tenant rate limits, row-level security, ledger reconciliation job, alerting and on-call runbooks                        |
| Second integration   | Started early: it is what proves the adapter contract and conformance kit                                                   |

Exit criteria: an internal "casino" plays the full loop through the widget on staging; the review queue can be
worked from the back office without SQL.

## Days 61–90 — pilot

| Track            | Outcome                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Launch readiness | Load test at 10× the pilot's expected event rate; penetration test; game RNG documentation; data-protection review                 |
| Pilot            | Shadow mode first (events processed, nothing shown), then a small share of players, then the full casino                           |
| Learning         | Funnel and retention dashboards with the casino: deposit-to-spin, spin-to-redemption, delivery success                             |
| Next steps       | Decide on running delivery as a separate deployment and on the inbox in front of ingestion, based on pilot data; discovery for PvP |

Exit criteria: the pilot casino's players use the wheel and store in production; deliveries meet the SLO; no manual
ledger corrections.

## Risks to manage from day one

| Risk                                                 | Mitigation                                                                                                |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Casino API documentation differs from reality        | Sandbox first, recorded fixtures, conformance kit, a simulator for what the sandbox cannot do             |
| A casino cannot guarantee idempotent reward issuance | Contractual requirement; if impossible, reconciliation-only mode with mandatory review before any refund  |
| Hiring slips                                         | Scope the MVP to what three engineers can ship; AI-assisted workflow for tests, reviews and documentation |
| Regulatory surprises by market                       | Legal review of reward mechanics per jurisdiction before each casino goes live                            |
