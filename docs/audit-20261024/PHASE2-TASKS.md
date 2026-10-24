# Phase 2: cancelled task selection in assistant rescheduling

Status: minimal source fix and focused PostgreSQL regression validation complete. Parent integration remains separate; no production claim.

## Defect and cause

`ai/assistant.ts::reschedule_task` selected any incomplete Interaction with a non-null date. A cancelled showing intentionally retains its original date and null `completedAt` for history, but has `nextAction=null`, which removes it from live task lists. The selection therefore treated cancelled history as a planned task, changed its old appointment date and returned `{ok:true,task:null}`. A cancelled row with a later date also consumed the request when a genuine live CALL existed.

Expected: choose a currently live task using the shared task predicate; if only cancelled history exists, report no planned tasks and retain its history.

## Minimal fix

Spread the existing `TASK_WHERE` into the reschedule selection. This is the same shared predicate used by calendar and the assistant's upcoming-showing list. No selection order, reminder-reset rule, date-only deadline, model behavior or scheduling lifecycle was otherwise changed. The source change is one predicate addition and its comment.

## Reproducible validation

New `apps/api/tests/assistant-task-reschedule-live.test.ts` calls the **actual exported `runTool`** and uses the dedicated real PostgreSQL database `audit_tasks`. Its sole mock suppresses the unrelated background anomaly notification, retaining the module's actual other exports. No model/provider transport is called.

- RED before the source change: `task-selection-red.log`, recorded native Vitest exit 1, **2 failed / 6 controls passed**. Cancelled-only returned success with a null task; the cancelled-later case selected the cancelled showing instead of the live CALL.
- GREEN after the source change: `task-selection-green.log`, recorded native Vitest exit 0, **4 files / 25 tests passed**: new selection regressions 8; existing assistant tools 7; assistant rights/gaps 7; task-reschedule anomaly 3.
- Controls cover ordinary live CALL and SHOWING, completed-task exclusion, foreign ownership, unaccepted and deleted clients. The live-task controls explicitly retain existing ancillary reminder state, so this patch does not silently adopt a new repeat-reminder policy.
- `npm run audit:mocks` passed without changing the guard or baseline. `git diff --check` passed on the owned source/tests.

This run uses the parent's updated phase2 dependencies; Vitest identifies itself as 4.1.12. It is distinct from the earlier pure-source/in-memory discovery probe in the frozen first worktree and from the earlier upload package's original dependency run. Full build, map generation, complete suites, final source pin and publication are parent integration responsibilities.

## Scope and remaining uncertainty

The read-only discovery report `NEXT-TASKS-READONLY.md` in the first worktree separately records reminder suppression after moving a previously reminded task and the date-only completion-score inconsistency. Those policy-sensitive behaviors are not changed or claimed fixed here. No browser, paid generation, real notification delivery, live configuration or production validation occurred.
