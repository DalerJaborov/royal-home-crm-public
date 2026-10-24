# Next pass: ordinary tasks, calendar and reminders (read only)

Source pin: `0466aca29e9090e046e8affdf93760c9224144bd`, first audit worktree. No application source, regression tests, dependency files or database records were changed. No HTTP server, cron, notification transport, model or external provider was started. This pass did not inspect or retry the stopped security task.

## Routing and evidence level

Started with `docs/product-map.md`: `/calendar` → `apps/web/src/pages/Calendar.tsx`; calendar API → `apps/api/src/routes/calendar.ts`; `meeting-reminders` five-minute schedule → `apps/api/src/cron.ts` → `lib/meetingReminders.ts`. Followed task creation/completion, assistant task rescheduling and the shared showing-mutation controls. BUSINESS.md / API-ROLES.md / NEXT-JOBS-READONLY.md did not already record the findings below.

Ignored probe: `reports/night-audit-20261024/readonly-task-probe.mjs`; output `.log`, recorded native exit **0** in `.exit.txt`. It extracts the actual TypeScript function/branch bodies through the TypeScript AST and executes them with an in-memory query adapter. It imports the existing compiled shared validation schema. No actual Prisma client, database, HTTP route, notification send or AI call executes. An exit 0 here means assertions of the observed behavior held; it is **not** a patched test result or end-to-end proof. The adapter implements only the predicates used in the current branch, not general Prisma semantics.

## Confirmed task-state defect: cancelled history can consume a reschedule request

Exact path: `apps/api/src/ai/assistant.ts:741–770`, especially the selection at 750–752 and single-field update at 755. The declared tool at 356–366 accepts `clientId` and `newDate`; there is no task ID by which the model could choose another row after deciding to invoke this tool.

Cancellation contract is explicit: `lib/showingBooking.ts:827–839` retains the old `nextActionDate` and leaves `completedAt` null for history, clears `nextAction` to remove the meeting from tasks/calendar, and sets `declinedAt`. `lib/showingMutation.ts:109` performs that update; existing `showing-mutation-postgres.test.ts:155` retains the corresponding expected cancelled state. `lib/tasks.ts:20–23` defines a task as `nextAction != null` on a non-deleted client.

Reproduction in the pure branch replay:

1. A legitimate client has one cancelled SHOWING: `nextAction=null`, `completedAt=null`, an old retained `nextActionDate`, and `declinedAt` set.
2. Invoke the actual `reschedule_task` branch with that client's ID and a new valid date.
3. Actual: selection matches the cancelled row because it checks only non-null date / null completion. It changes the cancelled history's date and returns `{ok:true, task:null}`. `nextAction` stays null, so no live task is restored or moved in calendar/reminders.
4. Control variant: one live CALL plus a cancelled SHOWING with the later retained date. `orderBy nextActionDate desc` selects the cancelled row; the live CALL remains unchanged while success is returned.

Expected from the existing tool and cancellation contract: rescheduling a planned task must choose a currently live task. If only cancelled history exists, report no planned task. Do not silently rewrite a cancellation's historical appointment date and claim a task was moved. This does not require an “undo cancellation” feature or policy change.

Suggested next bounded regression: actual tool execution on an isolated database with cancelled-only and live-plus-cancelled fixtures, asserting returned status, unchanged cancellation history and correct live task selection. Any eventual selection fix should preserve existing ownership and deleted-client gates and decide ambiguity explicitly rather than guessing from the model's prose.

## Confirmed behavior with a strong regression candidate: moving a reminded task keeps the old reminder suppression

Same reschedule branch updates only `nextActionDate` (`assistant.ts:755`). The probe starts with an ordinary live CALL having `remindersSent=["1h"]`, representing an already dispatched previous reminder. Rescheduling returns success and preserves that list. The **actual extracted** stage predicate from `meetingReminders.ts:314–321` rejects the task at the new one-hour window because `!task.remindersSent.includes("1h")` is false. The empty-list control at the same new time selects a reminder.

Expected scheduling behavior would normally be to arrange the reminder for the new appointment, as the canonical showing-reschedule implementation already does: `lib/showingMutation.ts:88` clears reminder/confirmation state; existing `showing-mutation-postgres.test.ts:95–106` asserts that reset. This pass confirms the suppression behavior in the ordinary assistant task path, but did not run the real worker or transport and did not establish a separate owner instruction explicitly governing repeat reminders after an ordinary CALL task moves. Keep that distinction before applying a policy-sensitive reset to every task type. For SHOWING, use the canonical lifecycle rather than only resetting this one array: confirmation and pending-summary state also belong to rescheduling.

## Date-only completion: behavior verified, deadline contract still unresolved

Frontend `AddInteractionModal.tsx:346–356` explicitly sends a date without time as bare `YYYY-MM-DD` and says the server interprets it as “on this day”. Shared `schemas.ts:382–394` documents the same sentinel. `interactionCreateSchema` accepts the probe's ordinary CALL task with a date and no time. `meetingReminders.ts:44–46` identifies it as having no exact time; the overdue reminder paths also skip it. Calendar `Calendar.tsx:223–231` keeps its calendar day under today's tasks until the date changes.

Actual completion uses `interaction.nextActionDate < now` without a date-only distinction (`routes/interactions.ts:514–515`), then `completionEventKind` at 466–469. Pure actual-source execution shows:

| Stored input / completion time, Asia/Tashkent | Actual completion kind | `hasExactTime` |
|---|---|---|
| Bare 2026-10-24; completed 24 October 09:00 | `task_overdue` | false |
| Bare 2026-10-24; completed 24 October 23:00 | `task_overdue` | false |
| Explicit 24 October 15:00; completed 14:00 | `task_on_time` | true |
| Explicit 24 October 15:00; completed 16:00 | `task_overdue` | true |

The bare date becomes UTC midnight / local 05:00, which is treated as a real deadline by completion scoring. This is a verified inconsistency between the supported “day without hour” representation and completion classification. **No explicit owner requirement or task-specific test establishing an end-of-day deadline was found in this bounded pass.** Do not count it as an approved score-policy fix or change historical scores automatically. Clarify the intended date-only deadline or find the governing specification, then add both date-only and explicit-time controls before changing the predicate. `kpi.ts:115–126` uses completion within the day for its separate CRM-discipline metric; it is additional context, not proof that Royal Score must use the same rule.

## Reviewed controls and limits

- Calendar separates in-range / overdue caps, merges by ID and applies explicit Dushanbe day bounds. Existing `calendar-overdue-does-not-crowd-month.test.ts` demonstrates its intended cap behavior; that test was read, not rerun here.
- Completion uses an atomic `completedAt:null` claim and score-source deduplication. The existing showing-reminder tests cover overdue score kinds and duplicate ticks; they do not establish the date-only deadline contract.
- Reminder delivery stages, working/alarm-hour gates, subject-agent task ownership, automatic task tags and canonical showing cancellation/reschedule were traced in source. Their entire behavior was not executed and is not marked complete coverage.
- No new PostgreSQL, browser, mobile, provider delivery or production evidence. No fixes, deployment, full-suite run or dependency update performed by this worker. Preserved all existing first-package and phase2 evidence.
