---
description: Review the current phase before it is committed (the gate used after every phase of this project)
---

Review everything changed since the last commit as a reviewer who has not seen it before. Do not commit.

1. Read every changed and new file in full, including tests. Look for duplicated logic or schemas, dead code,
   exports nobody uses, comments that restate the code, comments longer than a line or two, and comments or
   docs that claim something the code does not do.
2. Check the diff against the invariants in `CLAUDE.md`: idempotency anchors, tenant scoping, conditional
   money updates, no HTTP inside DB transactions, no unnecessary row locks.
3. Run `npm run format:check`, `npm run typecheck` and the full suite twice (`npm test`); flaky means broken.
4. Run coverage and explain every uncovered line: add a test, delete the code, or justify it as defensive.
5. For each guarantee the phase introduced, run a mutation: weaken the protecting line, confirm a named test
   fails, restore the file byte for byte. A mutation that does not compile proves nothing; rewrite it.
6. Exercise the change over real HTTP against `docker compose up --build`, including at least one failure path,
   and read the logs it produced.
7. Report findings first, then fixes, then what was verified and how. Record real defects in `docs/ai-log.md`.
