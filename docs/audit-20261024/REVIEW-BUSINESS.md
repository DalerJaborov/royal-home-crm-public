# Independent differential review of business fixes

Reviewed snapshot: `87aecdb..b20bc69603f66acbbfe31cb3ab9ddc5d32a1f043`. Method: installed `differential-review` skill with methodology, adversarial and reporting guidance. Risk-first, surgical review of monetary writes and reservation concurrency. No application source changes by reviewer; proof fixtures only, on own isolated `audit_roles` PostgreSQL database.

## Decision

**CONDITIONAL: verify the follow-up stage-lock fix before publishing.** One medium-severity regression family, with held and ordinary-stage variants, is confirmed in the new stronger reservation lock. Separate stale-state behavior is reproduced on the exact original baseline. No new expense-rate/accounting or commission calculation defect was established in the reviewed changes. This is a limited review, not a global approval.

| Class | Count | Status at original snapshot |
| --- | --- | --- |
| Introduced medium concurrency regression family | 1 | RB-1/RB-2 variants, actual PostgreSQL deadlocks |
| Preexisting medium stale-state family | 1 | Exact baseline, two state variants |
| New critical/high vulnerability established | 0 | No claim of complete security coverage |

Five changed runtime files reviewed: `routes/expenses.ts`, `routes/finance.ts`, `routes/deals.ts`, `lib/financeAutomation.ts`, `lib/dealReservation.ts` (+34/-8 lines). Surrounding payment lifecycle, monetary conversion, stage transition, transaction and timeline code was inspected. The rest of the 61-file package was outside this review.

## RB-1: New held-expiry lock inverts the rejection transaction order

**Severity:** medium (valid director request or hourly expiry transaction can fail); **confidence:** confirmed runtime; **introduced by:** `b20bc69`, `dealReservation.ts:84–104`.

Entry points are the hourly `releaseExpiredReservations()` job (`cron.ts:1607`) and authorized `PATCH /api/v1/deals/:id`. An expired `PENDING_APPROVAL` deal is enough; no unauthenticated access or policy bypass is required. Normal simultaneous director activity can trigger the defect.

At the reviewed snapshot the expiry transaction takes Property `FOR UPDATE` and then updates the held Deal. The director's rejection updates the Deal at `deals.ts:1186` and renews the Property at `deals.ts:1220`. These form Property→Deal and Deal→Property lock orders.

Actual proof uses real Express HTTP and real PostgreSQL transactions: pause the director request after its Deal update; start actual expiry; observe a blocked backend using `pg_stat_activity`/`pg_blocking_pids`; then resume the director request. PostgreSQL aborts the expiry's `tx.deal.updateMany()` with a Prisma write-conflict/deadlock error. In the observed run HTTP returned 200 and expiry returned 0 after reporting the error. The database may choose a different victim; the proof does not claim that every occurrence fails the HTTP request or corrupts data.

- Initial diagnostic: `reports/night-audit-20261024/review-business-lock-order.log` (test assertion only checked final user state, so its passing result is NOT a successful no-deadlock regression).
- Durable red: `reports/night-audit-20261024/review-business-lock-order-red.log`, one test failed on `reportCronRowError` being called with the actual deadlock.
- Regression source handed to business author: `apps/api/tests/deal-reservation-reject-race.test.ts`.
- Requested fix: consistent Property-before-Deal order for the rejection path, preserving the same transaction and rollback semantics. Author owns application fix and final green evidence.

The test's barrier deliberately accepts any blocked backend in its own database. After a safe fix, the expiry may wait on Property rather than Deal, so the harness remains valid. The expected outcome is legitimate user operation succeeds, reservation stays reserved and cron reports no failure.

History check: `git show 87aecdb:apps/api/src/lib/dealReservation.ts` and blame show the baseline held branch did NOT lock Property before updating Deal; this specific held-branch cycle is introduced. Existing rejection code comes from cleaned public bootstrap `0c6887d`; private history was not imported or examined.

## RB-2: Ordinary stage changes have a related introduced timeline FK cycle

**Severity:** medium; **confidence:** actual runtime deadlock; **classification:** same introduced lock-strength regression family as RB-1. Initial source-only suspicion that this cycle predated the patch was rejected after actual baseline validation.

The same controlled interleaving with an initial `NEGOTIATION` deal and HTTP promotion to `CONTRACT_SIGNED` causes the expiry's unheld branch to deadlock at `dealReservation.ts:131`, `tx.deal.update()`. HTTP stage writes hold Deal and then write their timeline with Property association, requiring a Property FK key-share lock. Expiry holds Property while waiting for Deal. PostgreSQL aborted the expiry in the observed run; the HTTP operation returned 200.

Evidence: `reports/night-audit-20261024/review-business-stage-lock-red.log` (one failed no-cron-error assertion). Although baseline expiry wrote Property before Deal, its non-key Property UPDATE is compatible with the timeline FK key-share lock; the new explicit `FOR UPDATE` is stronger. Source ordering alone did not establish attribution. Exact immutable baseline validation below demonstrates different stale-state failures without this deadlock. Fixing only director rejection does not establish ordinary stage transitions are safe.

The business author combined both proof variants into parameterized `apps/api/tests/deal-reservation-reject-race.test.ts` and removed the separate temporary stage test. The proposed final fix takes Property `FOR UPDATE` before Deal for every actual stage change, covering the FK cycle as well as explicit rejection renewal. `reports/night-audit-20261024/business-lock-order-final-green.log` records five files / 28 passed on that follow-up working state; this is author evidence, independently read, not an extra reviewer rerun.

## Exact baseline attribution

The coordinator supplied an isolated validation worktree at `D:/PublicWorktrees-20261021/night-audit-20261024-baseline-validation`, verified HEAD `87aecdb`. Runtime implementation paths remained unmodified. Generated Prisma output was prepared separately and a fresh `audit_baseline` database cloned from the audit template; no production or author business database was used. Only regression tests were copied into that baseline checkout.

Both actual HTTP/cron interleavings fail baseline state assertions: rejection leaves a stale non-null `reservationExpiredAt` after renewing the reservation; ordinary promotion allows expiry to return 1 and cancel the promoted deal. These are preexisting stale-state behaviors, distinct from the two b20 deadlocks. The standard no-cron-error assertion passes on the held baseline variant before the stale-state assertion fails. Logs: `review-business-lock-baseline.log`, and instrumented `review-business-lock-baseline-attribution.log` records cron errors and final stage before assertions. This is baseline execution, not an inference from lock order.

Final exact state capture (`review-business-lock-baseline-state.log`) proves both baseline variants have `cronErrors: []`: PENDING_APPROVAL rejection finishes CONTRACT_SIGNED / Property RESERVED with a fresh reservedAt but stale non-null reservationExpiredAt; NEGOTIATION promotion is overwritten to CANCELLED / Property AVAILABLE, reservedAt null, expiry released=1. Both requests returned 200 before assertions. Baseline proof source is retained as ignored `reports/night-audit-20261024/review-business-baseline-proof.ts`; no temporary failing proof remains in the main default suite. These original state variants extend BUS-06 and should not inflate the audit's defect-family count.

Original stale-reservation fixes and the final consistent stage-lock order are both needed: a no-deadlock baseline does not mean original state behavior was correct. Final snapshot acceptance must retain fresh-renewal cases and both stage interleavings.

## Other review conclusions and rejected suspicions

- Expense PATCH computes final status/currency/date from request plus stored state. Currency switches drop the prior currency rate; explicit USD planned rates survive payment; an unpaid USD plan without rate remains null; moving to PAID captures a rate. The write still checks the opening/current version and clears stale category data. No validation or permission removal observed.
- Paid accounting month now follows the effective retained payment date; historical paid rows with unknown dates remain separately editable. This matches existing create/pay behavior. Payment dates are calendar dates at UTC midnight; no demonstrated timezone regression.
- Recurring auto-pay captures a rate once per creation; its `autoKey` and recurring-marker transaction remain intact. `processWorkspaceRecurringExpenses()` already has a separate captured-rate path, so adding the legacy path does not duplicate a new payment. No existing rows are silently backfilled.
- Completed-deal repricing now uses the incoming sold price for both amount-from-percent and percent-from-amount; adjacent split calculations already use incoming values first. No proven new rounding/share invariant failure. This review did not exhaust all combinations of explicit shares and manual payout history.
- Forecast month regex narrows 00/13–99 without dropping existing optional/default semantics. No new access-control behavior.
- A separate stage-promotion experiment paused expiry after the held-stage read and awaited the whole HTTP request inside the transaction. It hit the 5-second transaction timeout and then the request completed. That harness artificially prevented progress and did NOT prove a stale-stage cancellation; its log `review-business-held-stage-red.log` is diagnostic only, despite its name. Proof source was moved to ignored `reports/night-audit-20261024/review-business-held-stage.proof.ts`. RB-2 uses the correct concurrent barrier instead.

## Callers, blast radius and test limits

- `releaseExpiredReservations`: one production caller, hourly cron. Its helper is private, one internal call from that scan. Four relevant Deal PATCH transaction classes inspected: complete, cancel, revive, ordinary stage/rejection. Completion/cancellation/revival already touch Property before their final Deal update; ordinary/rejection needed specific concurrency review.
- `processRecurringExpenses`: one production caller, finance cron (`cron.ts:2927`), which first invokes workspace recurrence. Both payment engines and monetary conversion were inspected.
- Expense edit route has the concrete browser hook `useSaveClaudeExpense` in `claudeFinanceApi.ts:84–85`; adjacent pay and undo hooks use their dedicated endpoints. Frozen monetary conversion `expenseCentsToTjs` has references in 10 runtime files, so preserving captured rates affects reports/exports/forecasts beyond the editor.
- Existing author evidence was read, not rerun as new independent success: business green 71 and final 42 tests overlap. New reservation tests at the original snapshot covered stale `reservedAt` renewal before transaction start; they did not cover the two inverse lock schedules found here.
- No full suite, browser, cloud runner, provider send or production probe was repeated. Test fixtures are synthetic; external credentials remain absent. Final fixed-source green, map/build/guards and whole-package integration remain author/coordinator responsibilities.

This report records the pinned snapshot findings. Follow-up author edits and new green evidence require a new commit/snapshot reference before final acceptance; they are not silently treated as part of the original review.

Follow-up source review: the author added six lines at the start of the Deal PATCH transaction, taking Property `FOR UPDATE` only when the incoming stage differs. This establishes the same order before the Deal write and associated timeline FK, while keeping metadata-only edits and existing stage/version predicates intact. Reviewed `deals.ts` SHA256: `6c654770faa5e6472771d45f663f8a53ea112b68b19c0a0778d6f9f7bcd5da08`. This addresses both demonstrated deadlock variants; author 28-test green evidence covers both original state variants as well. Recommendation for this narrow follow-up is APPROVE subject to coordinator's final snapshot/build/integration gates. No further actionable regression established in this scoped review.
