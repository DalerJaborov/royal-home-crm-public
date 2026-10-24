# Independent review — phase-2 upload cleanup and task selection

Conclusion: **approve these narrow source changes for parent integration, with the filesystem timeout limitation below retained explicitly**. No actionable introduced defect was confirmed in this bounded read-only review. Finding counts: critical 0, high 0, medium 0, low 0. Review risk is medium because filesystem deletion is irreversible and PostgreSQL cannot roll it back. This is not a complete CRM, full-suite or production verdict.

## Scope and baseline

Reviewed the uncommitted phase-2 diff against `0466aca` for:

- `apps/api/src/lib/videoUploadCleanup.ts`: +15/-5 lines; candidate-row lock/reload, exact retention recheck, cancellation counters.
- `apps/api/src/ai/assistant.ts`: +2/-1 lines; shared TASK_WHERE in reschedule selection.
- New complete tests `video-upload-cleanup-race.test.ts` and `assistant-task-reschedule-live.test.ts`; corresponding worker reports and retained RED/GREEN logs.

Read supporting source in `routes/properties/videos.ts`, `localVideoStorage.ts`, `tasks.ts`, `showingBooking.ts`, `routes/ai.ts`, schema/migrations and the existing session policy controls. Git blame/log show both replaced blocks originated in public bootstrap `0c6887d`; baseline source was read without checkout/reset. No application/test edits, tests, providers, DB writes or deployment were performed during this review. Only this report was created.

Production blast radius: cleanup has one source caller, the daily tracked cron at `cron.ts:1444–1457`; reschedule is one branch of runTool, called by the assistant tool loop at `assistant.ts:1135`, reached through the existing authenticated AI route (`routes/ai.ts:104`). Tool declaration/progress-label references are not additional executors. Public route authorization was not changed.

## Upload lock and eligibility reasoning

At `videoUploadCleanup.ts:69–81`, the candidate scan is no longer the deletion authority. Cleanup locks one VideoUploadSession row, reloads it under that lock and re-evaluates eligibility. The recheck at 75–76 is exactly the complement of the original policy: updatedAt <=48h cutoff, or updatedAt <=24h cutoff with an empty parts array. Equality boundaries and the 50-session candidate cap remain unchanged. Missing or newly fresh rows skip without cancellation/failure counts or push.

Actual accepted PUT source is `routes/properties/videos.ts:1075–1119`: scope/ownership and part validation precede disk write; the metadata UPDATE at 1113 precedes its success response. The schema's updatedAt is `@updatedAt` (`schema.prisma:8820`). Therefore, a metadata UPDATE committed before cleanup's lock is visible on reload; an uncommitted UPDATE makes cleanup wait. If cleanup holds the row first and deletes it, a subsequent PUT metadata UPDATE fails rather than acknowledging acceptance. This protection depends on the existing success ordering, not just a fresh-date check outside exclusion.

No new lock-order cycle was found on inspected paths. The transaction takes only its session row, reads only that row, removes its directory, and deletes that row. It does not then lock Property/Agent or assemble a completed video. Session schema/migrations have parent Property/Agent FKs and no child relation/trigger that requires a second application row lock during this delete. Competing routes' standalone session UPDATE/DELETE wait on this row; cleanup does not need a row they hold. Author push occurs after transaction commit. This source analysis is bounded; no universal deadlock-freedom claim is made.

Failure/counter ordering is correct for the confirmed case: abort returning false increments failed and leaves the row; sessions increments only after successful transaction completion, so renewed/missing/failed candidates are not counted as cancellations. A disk failure still has a retryable row and no cancellation push. The actual recursive removal may partially remove files before returning an error: retaining the row is guaranteed by this branch, preserving every byte after arbitrary partial filesystem failure is not. An unexpected DB/transaction error propagates to the cron catch, so a normal result is not falsely returned in that case.

## Upload evidence checked, with layers separated

Retained `upload-cleanup-red.log` shows baseline native failure: the actual PUT returned 200 after candidate scan, but cleanup reported sessions=1 instead of 0. The other four new cases were skipped in that RED run; they were not baseline-proven failures.

`video-upload-cleanup-race.test.ts:133–211` uses real PostgreSQL and local bytes, actual authenticated HTTP PUT/RAW complete, and scheduling hooks. The five final cases separately demonstrate:

1. Accepted PUT after stale scan: 200, zero cancellations/failures, session and newly accepted part survive.
2. Uncommitted timestamp renewal: real pg_stat_activity/pg_blocking_pids waiter, cleanup then sees committed timestamp and skips. This case directly exercises a metadata transaction, not an HTTP PUT.
3. Cleanup owns the row first: actual PUT writes, then waits on metadata UPDATE and receives an error after deletion. The expected P2025 log is evidence of refusal to acknowledge success; it is not a polished recovery UX or accepted-upload preservation case.
4. Actual RAW completion after scan: HTTP 201, independent completed bytes `ab` and PropertyVideo survive; missing session is skipped.
5. Explicit false-return disk-failure simulation: row and real existing part remain. The hook bypasses removal for this case; it is not an actual OS partial-rm-failure reproduction.

Retained `upload-narrow-green.log` plus `.exit.txt` show native 0, six files/49 passed with Vitest 4.1.11: new race5, existing policy7, multipart16, HANDOFF8, duplicate RAW2, local storage11. Policy tests explicitly cover fresh sessions, old sessions, empty24h/nonempty48h distinction, push/no-push and failure retention. The HANDOFF tests are related workflow/role/assembly controls, not a new cleanup-vs-HANDOFF concurrency proof. Subsequent `upload-mock-r2-green.log` and `.exit.txt` independently show native 0, new race5 passed under Vitest 4.1.12 after narrow mocks were corrected to preserve actual exports. The broader discarded lock-design logs do not validate this final source.

## Task selection and history

`assistant.ts:741–756` preserves the client availability/ownership/date checks, nextActionDate non-null, completedAt null, descending selection order and date-only UPDATE. The added shared `TASK_WHERE` (`lib/tasks.ts:20–23`) requires nextAction non-null and client.deletedAt null. Deleted clients already fail the preceding availability guard; the useful addition prevents date-retaining non-task history from being selected.

This matches actual cancellation semantics documented and implemented in `showingBooking.ts:823–844,889–919`: cancelled showing keeps its historical nextActionDate and incomplete status but clears nextAction. The patch does not erase history, revive cancellation, mark it completed or change reminder state. A cancelled row already present at selection is excluded; a genuine CALL/SHOWING remains selectable. This also preserves declinedAt on a still-live task rather than treating any decline alone as cancellation.

The eight new real-PG tests call actual runTool, mocking only the unrelated anomaly background notification. `task-selection-red.log` + `.exit.txt`: native 1, two confirmed cancelled-history failures / six controls passed. `task-selection-green.log` + `.exit.txt`: native 0, four files/25 passed on Vitest 4.1.12 (new8, assistant tools7, rights/gaps7, anomaly3). The new tests verify unchanged historical dates/decline/notes, selection of a live CALL despite later cancelled history, live CALL/SHOWING, completed exclusion, foreign ownership, deleted/unaccepted clients, and unchanged ancillary reminders.

## Residual limits and useful followups

- **120-second filesystem timeout:** `fs.promises.rm` is not cancelled by Prisma transaction expiry. If removal outlives the 120000ms transaction, the DB lock can release/roll back while filesystem work continues. That timing can again expose a writer to a continuing delete. No retained proof covers this boundary; the fix is the confirmed normal-duration stale-snapshot race, not atomicity between DB and filesystem. A future focused fault-injection test and a durable cleanup claim/rename protocol would be appropriate before claiming universal protection.
- Completion while already assembling, crash windows, explicit cancellation races and orphan handling are not serialized by this patch. An accepted RAW complete after the initial scan is proven; every possible interleaving is not.
- Assistant selection and UPDATE remain separate operations. A cancellation or ownership change after selection can race the existing ID-only update; this existed at baseline and is not solved or introduced by TASK_WHERE. A later concurrency task would need a guarded update/transaction proof, not a broader reading of these tests.
- Previously discussed reminder re-emission and date-only completion scoring remain policy-sensitive and unchanged. No browser, provider delivery, production or exhaustive coverage is asserted. Parent owns final pinned build/full-suite/integration decisions.
