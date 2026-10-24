# Ordinary calendar task UI — bounded read-only pass

Source/runtime: stable phase2 `5616f8e3e886c500d0eeebf5edda924757620a2d`. This pass changed no application/default-test/dependency/map files, database state, provider settings or production. Prior `NEXT-TASKS-READONLY.md` was read first: assistant rescheduling, reminder repeat policy and date-only scoring were excluded. Product map `/calendar` points to the actual `Calendar.tsx`; ordinary CALL tasks expose completion, while editing here is SHOWING rescheduling. No task-reopen UI/hook/route was found in this bounded trace; no reopen behavior is claimed tested.

## TU01 — task completion failure is invisible (confirmed browser candidate, no fix)

Reproduction: ordinary synthetic AGENT opens Calendar day 25 October, sees a scheduled CALL task, clicks **Сделано**. Intercepted `PATCH /api/v1/interactions/:id/complete` returns a structured non-success JSON error. Actual task remains visible, the button stays available, and no error text or `role=alert` appears. Expected: show the mutation error, as the same page already does for failed showing cancellation/rescheduling, so the user understands completion failed. No claim of successful completion, data corruption, duplicate scoring or API defect is made.

Root cause, source: `pages/Calendar.tsx:335–360` renders `cancelShowing.isError` and `rescheduleShowing.isError` only. `useCalendar.ts:15–21` propagates completion rejection through the TanStack mutation; there is no local error notification. `Calendar.tsx:377` calls that mutation. Both actual desktop and mobile layouts consume the shared `mutationNote`, so one small presentation change can cover both.

Evidence is actual mounted React Calendar, actual task hooks, actual API transport parser, installed Chrome at **1440×1000** and **390×1000**, with strictly synthetic intercepted HTTP. Role is **AGENT**, not DIRECTOR. No API handler/PostgreSQL/notification worker/provider is executed. Runtime is a focused page fixture with AppLayout's `data-screen=calendar` presentation prerequisite and MemoryRouter; it is not a complete shell/navigation/production test.

Raw: phase2 `reports/night-audit-20261024/task-ui-readonly/`. `browser.json`/native **1** contains the initial mobile normative RED and its two GREEN controls, plus three desktop harness failures caused by missing shell screen attribute. `layout.json`/native **1** isolates and records the resulting desktop `rh2 screens display:none`; this is rejected as a harness failure. After adding only the fixture's actual shell attribute, `desktop.json`/native **1** has **one normative completion-error RED + two GREEN controls**. Therefore usable evidence totals **2 genuine RED, 4 GREEN**, zero browser exceptions or unexpected intercepted endpoints. Decoded `complete-error-1440.json`, `complete-error-390.json` retain complete observed body text, empty alert arrays and one outgoing PATCH. Failure traces are retained in managed Playwright output. No default tests were modified.

Exact current probe command, from phase2 root:

```powershell
npx playwright test --config reports/night-audit-20261024/task-ui-readonly/playwright.config.ts
```

The current ignored fixture contains the shell correction and actual Day tab navigation; original raw logs remain distinct. Managed Vite uses port **5213**, no detached helper. It stops with the test runner.

## Meaningful controls (executed once per width)

- Completion success: one PATCH succeeds; subsequent actual query invalidation/refetch removes the completed task from the visible list. This distinguishes the missing error presentation from a broken transport or query harness.
- Showing edit: a one-character reason disables Save and causes no request; a valid revised reason and date enable Save. While delayed PATCH is pending, Save is disabled. On a rejected response the page displays the actual rescheduling error and retains the exact date and reason. Submitted 26 October 16:35 local is `2026-10-26T11:35:00.000Z`, without altering day/time policy.
- Pending dismissal observation: showing edit Cancel remains enabled during saving. This was only observed; no separate new defect is accepted, and no destructive-dismiss scenario was executed after TU01 confirmation. Completion button stays enabled while pending, but the server already has an atomic completion claim; this pass does not label that a scoring defect.

## Minimal proposed package

Add a completion branch to the existing shared quiet critical alert with `complete.isError`, the actual Error message/fallback, and **Понятно → complete.reset()**. Preserve API, roles, score policy, pending controls and task lifecycle. Promote durable browser regression with positive error visibility oracle at both widths and preserve completion-success/showing-edit draft controls. Repeat RED on unchanged target source before the presentation fix, then GREEN. Parent independently reviewed the relevant omission and received both-width browser findings; source changes await its lease. Source reading alone is not counted as runtime coverage.
