# TU01 — show task completion failures

Base: `13a921914f5622b1a7b6ed4f6b954756fe28c4c3`, final worktree. Application change is solely the completion-error branch in `apps/web/src/pages/Calendar.tsx`'s existing shared `mutationNote`: critical alert, actual Error message / Russian fallback, and **Понятно** to reset the error. The same branch appears in desktop and mobile layouts. API/hooks, task lifecycle, pending controls, permissions and score policy are unchanged.

An ordinary agent clicking **Сделано** previously got no visible feedback when completion failed; the task remained. Actual mounted Chrome with synthetic intercepted HTTP reproduced the omission on 1440×1000 and 390×1000. Parent independently reviewed the missing branch before granting the narrow final source lease. Initial read-only report is in main audit `NEXT-TASK-UI-READONLY.md`; its unrelated initial desktop harness failures remain separate.

## Durable regression and exact evidence

Tracked runner: `apps/web/playwright.night-calendar-complete.config.ts`; fixture HTML/TSX under `apps/web/tests/fixtures/night-calendar-complete.*`; spec `apps/web/tests/e2e/night-calendar-complete.spec.ts`. Managed Vite on **5214**, `reuseExistingServer:false`, installed Chrome, **AGENT** role. Actual Calendar / useCalendar hooks / api parser / query invalidation execute. Every API endpoint is synthetic and intercepted; unexpected routes and external origins are rejected and recorded. No database, API handler, providers, cron, calls or production configuration execute. Fixture supplies AppLayout's desktop screen attribute and MemoryRouter; full shell navigation is outside this test.

From final `apps/web`:

```powershell
npx playwright test --config playwright.night-calendar-complete.config.ts --reporter=json
```

- **Durable baseline RED:** unchanged Calendar SHA256 `f811b8d6015cbaa23763ef4a9f86970c0c1ad232fdb69e76165de6c83171372f`; native exit **1**, **2 normative failures + 4 passing controls**. Both failures assert that actual completion error must be visible in `role=alert`, not that the broken behavior should persist. Exact failure: no alert element after the synthetic structured 500 response.
- **Patched GREEN:** same six spec cases, fixture and config, native exit **0**, **6 PASS**, zero skipped/flaky/unexpected. Both completion-error cases show the returned text, acknowledgment removes the error while retaining the task and causing no request, and deliberate retry succeeds and removes the task through actual refetch. Independent completion-success controls also remove it.
- Both showing-edit controls retain entered date/reason after rejected save; short reason disables Save before request, pending Save is disabled, and exact local-time → ISO request is retained. They protect neighboring mutation rendering and editable draft behavior; repeat-reminder/date-only deadline policies are excluded.

Raw ignored evidence: `reports/night-audit-20261024/calendar-complete-final/`: `red.json`, `red.stderr.log`, `red.exit.txt`, retained `red-browser-results/` (copied before the second Playwright run); `green.json`, `green.stderr.log`, `green.exit.txt`; six decoded `green-evidence-*.json`, each with empty unexpected/external/browser-error arrays; `manifest.json` source/test/config SHA256 pins. Managed port 5214 was checked absent after completion.

`where` and `impact` completed native **0** before the edit (web-only change, no API impact tests selected). Targeted ESLint native **0**. `npx tsc --noEmit -p apps/web/tsconfig.json` native **0**; separate ignored TypeScript project extending that config and including the new fixture/spec/runner plus actual `src/vite-env.d.ts` native **0**. Both logs/exits are recorded under the evidence directory. Diff whitespace check passed (one existing unrelated STATUS line-ending warning). No full suite, dependency mutation, map regeneration, commit, push, merge or deployment by this worker. Parent owns final package integration/release decisions.

## Independent review follow-up: deterministic fixture clock

Independent reviewer correctly identified a durability gap in the browser fixture: its planned task/day are 25 October, while Calendar intentionally groups dates before real today into overdue. After 25 October, the test's setup would no longer find the selected-day task. This is a **test harness issue, not a CRM defect**. Each case now sets only browser Date to `2026-10-24T07:00:00.000Z` with Playwright `page.clock.setFixedTime` before navigation. No application change or policy change. Original RED/GREEN logs and manifest remain unchanged.

Exact final six with that clock pin: **6 PASS, native 0**, zero skipped/flaky/unexpected, external origins or browser errors; explicit regression TypeScript check native **0**. Separate raw `clock-green.json`/stderr/exit, decoded `clock-green-evidence-1..6.json`, `typecheck-clock.log`/exit and `manifest-clock.json` retain the new test SHA256 and unchanged app/fixture/runner pins. Managed port 5214 stopped again. Full baseline six was not repeated for this setup-only change.
