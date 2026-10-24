# NFL-01 variant: preserve ExpensesWorkspace's delete opening version

Scoped source fix and focused validation passed. This is another active UI caller of the **existing NFL-01 family**, not another bug-family count. No API policy or accounting rule changed.

## Confirmed ordinary sequence

`Finance.tsx:507` mounts the actual ExpensesWorkspace. Its sole `useDeleteExpense` caller passed only the expense ID, and the hook accepted only that string. Unlike editing, opening the delete confirmation captured no version.

The retained MAIN `NEXT-EXPENSE-ARCHIVE-VARIANT-READONLY.md` records actual mounted Chrome1440/390 discovery in PHASE2: open100/version0, correct the synthetic server to250/version1, refetch the real expenses QueryClient query, then confirm. The underlying row visibly updates while the dialog stays open; the actual hook still sends unversioned DELETE and the mirrored API compatibility branch archives250/version2. That discovery uses synthetic transport only. Existing NFL-01 actual HTTP/PostgreSQL409/unversioned204 controls remain separately documented in `NEXT-FINANCE-LIFECYCLE-READONLY.md`; they were not rerun or mislabeled as new PG evidence.

## Minimal correction

- `hooks/useFinance.ts::useDeleteExpense` accepts backward-compatible `string | {id:string;version?:number}` and adds the version query only when defined, including zero. Existing ID-only behavior and invalidations remain available.
- `components/finance/ExpensesWorkspace.tsx::ExpenseRow` captures a dedicated deleteVersion ref when the ordinary delete button opens its confirmation. Confirmation sends that captured version, even if the row's props have since refreshed. Edit's separate openingVersion, action lock, working state and existing error handling remain unchanged.
- No new UI error path was needed: the existing409 error already renders visibly inside ConfirmDialog. No shared helper, server guard, global mandatory-version policy, accounting/restore behavior or provider changed.

The two application diffs are seven insertions/three deletions in total; no unrelated source rewrite. Before editing, where/impact checks for both files exited0 and reported no API/shared source change. Only this hook's single active caller required migration.

## Durable validation

Tracked browser config/spec/fixture: `playwright.night-expense-workspace.config.ts`, `tests/e2e/night-expense-workspace.spec.ts`, `tests/fixtures/night-expense-workspace.html/.tsx`. Real component, ConfirmDialog, hooks, QueryClient, CSS and installed Chrome at1440/390; managed loopback Vite5215 and intercepted synthetic transport only. An explicit background refetch drives the stale case. Fixed2026-10 inputs do not rely on today's date for the acceptance assertions.

- `expense-workspace-browser-red.json/.exit`: native1, **2 stale failures/4 fresh/read-only controls pass**,0flaky/skip. Both stale requests actually omitted the expected?version=0. The desired assertions were not changed between this RED and GREEN.
- `expense-workspace-browser-green.json/.exit`: native0, **all6 pass**,0flaky/skip. Each stale case sends the opening version0 after refetch, receives mirrored409, visibly shows the original API conflict text inside the still-open confirmation, and retains active corrected250/version1. Fresh archive and read-only no-write controls remain successful. The transport's optional-version CAS mirrors the independently verified existing API; this is not a new real-PG run.
- `expense-workspace-hook-red.log/.exit`: actual hook mutationFn baseline **2 failed/1 legacy-string control passed**, native1. Object inputs were treated as IDs by the old implementation. `expense-workspace-unit-green.log/.exit`: **3 files/15 tests passed**, native0: new hook3 plus existing workspace amount/action-lock10 and shell2. The hook controls invoke its actual configured mutationFn with a mocked API, covering string compatibility, version0 and optional absent version. Hook invocation is captured through a tiny SSR component to obey React's hooks rules; it is not a full browser mutation lifecycle test.
- Web `tsc --noEmit` native0 and targeted ESLint native0; logs `expense-workspace-typecheck.log`, `expense-workspace-lint.log`. Owned diff check passed.

Ignored FINAL evidence is under `reports/night-audit-20261024/expense-workspace-*`. An initial browser command failed before test startup because its output path was relative to the wrong directory; it is excluded from validation. Earlier PHASE2 discovery's initially incorrect empty-state locator is likewise separated from the corrected two stale browser reproductions.

## Source pins and limits

Released SHA256: useFinance `7A1488BBF4959B99247BDEB42BDD90AB1F3EADB7D1314FE8D1379AC90D76DA5D`; ExpensesWorkspace `34F3F2BA0004FD51CB28996F2325325CF3EC82733DBE78DC2FFAA504DCE2D85D`; durable browser spec `2AB9ED2B6800C4883A58221EDC4AC8076EFFA08F7010ACC1824E0D6BDE7C9D2D`.

Source/tests/processes released to the parent. No production DB/provider write, actual call, live configuration, dependency mutation, full suite, map generation, commit or release occurred in this subtask. Parent owns independent review and final frozen package validation; unchanged legacy ID-only compatibility is intentional.
