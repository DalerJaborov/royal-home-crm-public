# Independent review of final user-flow followups

Read-only review by the business specialist, against FINAL's actual working diff after base13a9219 and released writer evidence. No runtime repeats, source/test edits or production operations by this reviewer. This review is independent for Calendar and the separate useFinance/ExpensesWorkspace followup; it is **not** independent review of the ClaudeExpenseTable correction, which this reviewer authored.

## Calendar completion error (TU01)

Application diff scope approved: new `complete.isError` branch in Calendar.tsx shared `mutationNote`, rendering the existing Error message/fallback in the same quiet/crit alert pattern as adjacent cancel/reschedule branches and invoking `complete.reset()` on acknowledgement. `mutationNote` already renders in both page layouts. `useCompleteTask` still calls the same PATCH endpoint and invalidates task views only on success; the change does not mark a failed task complete, invalidate on failure, alter the task list/cache, or add a request on acknowledgement. No introduced application blocker found.

Read baseline via `git show HEAD:apps/web/src/pages/Calendar.tsx` and actual `hooks/useCalendar.ts` caller. Original note handled only cancel/reschedule error state, while three completion button paths called the same completion mutation. Existing policy/API were not changed. Shared observer error visibility rather than per-task ownership is the established adjacent UX pattern; no speculative policy finding is raised.

Durable browser source inspected: `tests/e2e/night-calendar-complete.spec.ts`, `tests/fixtures/night-calendar-complete.{tsx,html}`, `playwright.night-calendar-complete.config.ts`. Actual Calendar/hooks/QueryClient, AGENT fixture, synthetic intercepted HTTP; 1440/390 variants check failed completion error, retained task, acknowledgement/no added request, explicit successful retry/removal; success control and failed reschedule retaining date/reason. Unexpected API/foreign requests and page errors are recorded and asserted empty. Spec does not claim full-shell/real API/PostgreSQL coverage.

Independently read raw `reports/night-audit-20261024/calendar-complete-final/red.json` and `green.json`: RED expected4/unexpected2/flaky0/native1; GREEN expected6/unexpected0/flaky0/native0. Decoded first green evidence records exactly two complete PATCH requests, body=null, and empty unexpected/external/page errors. Writer reported strict TS/lint0 and port5214 stopped; this reviewer did not rerun them.

### Introduced fixture durability issue raised during review

The initial new spec and fixture hardcoded task date/selected date2026-10-25 without pinning the browser's clock. `Calendar.tsx` computes real `todayKey`, then moves tasks earlier than today into `overdueTasks` instead of `tasksByDay`. From2026-10-26 the selected-day planned-task locator would fail before the completion assertions. This is a deterministic source-level test-fixture issue, not an application regression or production finding. Parent approved the narrow test correction; the writer now calls `page.clock.setFixedTime(new Date('2026-10-24T07:00:00.000Z'))` at spec line12, before navigation at line48. Application clock/policy unchanged.

Independently read final `clock-green.json`: expected6, unexpected0, skipped0, flaky0; `clock-green.exit.txt`=0. Writer reports explicit final regression TS0 and stopped port5214; original RED/GREEN preserved separately. Final spec SHA256 `572edc49d3d38c3957c26e9a6c3c390f41cea22380ae71cfff4de5e608d11a46`. **Calendar followup approved after this correction; no unresolved introduced blocker found.** App SHA256 `b01fa046714a6c81e824d23b7053754e811a07ccdf2e2004ff29815b4e8dab54`. No runtime repeated by this reviewer.

## Separate active ExpensesWorkspace archive caller (NFL-01 variant)

Writer released the actual final source for review. Scope **approved**, no introduced application blocker found. This is a caller variant of the existing NFL-01 family, not a new finance policy or independent second family.

Actual diff:

- `hooks/useFinance.ts:126–133`: accepts legacy string or `{id,version?}`; string/absent version retain the original URL, explicit version0 is retained by `version === undefined`, not lost to truthiness. Existing success metadata and invalidation callback are unchanged. Repository search finds one production caller, ExpensesWorkspace; its caller is updated together. No API/version requirement or access policy changed.
- `components/finance/ExpensesWorkspace.tsx:314,344,399`: dedicated deleteVersion ref is assigned from the row when the confirmation opens, then passed with ID to the existing mutation. It stays stable while actual query refreshes update the displayed row. Editing has its separate openingVersion ref. Cancel/reopen captures the new version. Existing actionLock serializes the mutation; working/disabled/dismissible guards, error rendering inside the still-open confirmation and success closure are retained. A409 therefore does not close/remove the row or claim success. Capture uses no asynchronous side effect and adds no cleanup lifecycle.

Existing API contract was independently verified earlier via real own PostgreSQL/HTTP: stale `?version=0`→409 with corrected250 active, omitted version→204/archive. This review does not repeat it. The backward-compatible hook deliberately preserves the latter legacy form; the active caller now uses the former correctly.

Read actual durable `tests/e2e/night-expense-workspace.spec.ts`, fixture TSX/HTML and config. Actual workspace/QueryClient/query/mutation hooks on own5215, synthetic intercepted transport. Stale cases at1440/390 open confirmation on100/version0, refetch real page query with corrected250/version1, then assert exact `?version=0`,409 error inside the confirmation, rendered corrected row and active synthetic state. Fresh archive and readonly controls remain. New `hooks/__tests__/useDeleteExpense.test.ts` invokes the actual hook mutationFn through a React render and verifies legacy string, explicit zero and absent-version-object URLs; it does not replace the function under test. Existing success/invalidation implementation is unmodified.

Read raw JSON independently: `expense-workspace-browser-red.json` expected4/unexpected2/skipped0/flaky0; `expense-workspace-browser-green.json` expected6/unexpected0/skipped0/flaky0. Read original hook RED log2fail/1pass and final unit log3files/15PASS. This reviewer did not rerun them. Browser foreign origins are aborted; that fixture does not collect/assert an external-origin count, so this report claims external transport blocked, not an observed zero-attempt count. No actual DB cleanup is needed for intercepted browser fixtures. Owned real-PG evidence/cleanup remains in the earlier named reports, not credited as a new run.

Diff whitespace check passed. Reviewed source SHA256: useFinance.ts `7a1488bbf4959b99247bdeb42bdd90ab1f3eadb7d1314fe8d1379ac90d76da5d`; ExpensesWorkspace.tsx `34f3f2ba0004fd51cb28996f2325325cf3ec82733dbe78dc2ffaa504dce2d85d`. Writer reports targeted lint0; its web typecheck was still finishing at source release, so no final typecheck verdict is invented here. This is a scoped code approval; parent retains final whole-package validation.

## Limits

No repeated runtime checks, exploit/security stream, new app-policy decisions, full suite, deployments or production interactions. Browser evidence is intercepted transport and scoped components/pages. Review does not certify every user flow, every role or all background/restore interleavings.
