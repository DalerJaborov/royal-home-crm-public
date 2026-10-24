# NFL-01 — preserve the expense table's confirmed version

The table now calls the existing delete mutation with `{id:row.id,version:row.version}` from the captured confirmation row. A correction made after that confirmation opens therefore reaches the existing API optimistic-concurrency predicate and returns 409, keeping the corrected expense active. This changes one caller expression in `apps/web/src/components/finance/ClaudeExpenseTable.tsx:32`; the hook, API, DTO/schema, legacy ID-only compatibility, normal delete/restore and role policy are unchanged.

## Confirmed baseline and scope

Parent authorized this narrow followup after the bounded MAIN report `docs/audit-20261024/NEXT-FINANCE-LIFECYCLE-READONLY.md`. Retained PHASE2 source `5616f8e` real HTTP/PostgreSQL probe created amount100/version0, corrected it to250/version1 and sent the exact table-equivalent ID-only DELETE. It returned204, stored corrected250 but archived it/version2. The same stale delete with `?version=0` returned409 and kept250 active. Fresh archive/restore preserved all business fields and removed/reincluded the paid amount in pivot. The three-case probe produced1 normative RED +2 controls PASS, native1, no retry. Soft archive is reversible; no physical deletion is claimed.

Own new `audit_finance_lifecycle` used only loopback15439 and synthetic records. Exact cleanup removed only captured expense/actor IDs and own eight audit writes; final Agent/Expense/AuditLog=0. External fetch guard passed0 calls. Raw evidence remains ignored in PHASE2 `reports/night-audit-20261024/finance-lifecycle-{red.log,red.exit.txt}`, probe/config alongside them. Parent independently reviewed the source/contract. No API rerun was needed for the one caller correction.

`npm run where -- --file apps/web/src/components/finance/ClaudeExpenseTable.tsx` was inspected before the call edit. Relevant existing component tests and the new actual-component browser regression were selected; no full precheck or suite was independently run.

## Durable actual-component browser regression

New fixture `apps/web/tests/fixtures/night-expense-archive.tsx` renders the actual table, QueryClient, real expense page/mutation hooks, auth store and actual Toaster. It does not replace the mutation hook or component implementation. `night-expense-archive.html`, `tests/e2e/night-expense-archive.spec.ts` and `playwright.night-expense-archive.config.ts` provide the scoped Chrome run on own port5213. All API requests are intercepted; unexpected API/foreign-origin requests abort and fail assertions. No live server/provider/database is reached by this browser fixture.

Each case executes at1440×1000 and390×1000:

1. **Stale confirmation:** open original100/version0 confirmation. Change synthetic server to corrected250/version1 and refetch through the actual page query while the dialog retains its original captured expense. Confirm. Exact actual request must be DELETE `?version=0`; existing-contract interceptor returns409. Actual error text appears, corrected row remains rendered and active, no success/undo toast appears. The interceptor mirrors the real API's ID-only compatibility: an omitted version succeeds204, so the original caller fails normatively rather than receiving a fabricated409 regardless of request.
2. **Fresh archive/undo:** correct `?version=0` request succeeds204, row disappears, actual success toast offers Undo; clicking actual Undo sends PATCH restore and brings back the same100 expense. No unexpected request.
3. **Readonly:** row and view control remain visible; delete controls absent and no mutations.

The stale case's query refresh is explicit test orchestration through its QueryClient, not an assumption that a409 triggers application refetch. The hook's error path remains unchanged; this demonstrates retention of an already refreshed corrected row and the captured confirmation's older version. Real DB preservation is separately proved by the PHASE2 HTTP controls.

## Results and exact evidence

| Evidence | Result | FINAL ignored artifact under reports/night-audit-20261024 |
| --- | --- | --- |
| Original caller, actual component/hooks in Chrome | 2 stale regressions FAIL on omitted query version;4 fresh/readonly controls PASS; native1 | expense-table-red-browser.log / .exit.txt; failure traces in expense-table-red-browser/ |
| Patched caller, first browser run |6/6PASS; native0 | expense-table-green-browser.log / .exit.txt |
| Final browser test strengthened with explicit fresh `?version=0` assertion | **6/6PASS**, native0,11.1s | expense-table-final-browser.log / .exit.txt |
| Existing ClaudeExpenseTable.test.tsx |3/3PASS; native0 | expense-table-unit.log / .exit.txt |
| Strict TS check of new browser fixture/spec/config and imported source |PASS; native0 | expense-table-browser-types.json / .log / .exit.txt |

The added fresh-query assertion was made after the initial GREEN, following parent review. No source rollback/repeated baseline was performed solely for that stronger passing control; the original omitted-version normative RED is retained. Six browser cases are six distinct cases, not twelve by summing repeated runs. `git diff --check` passed on the changed source. No dependency/shared build changes were made. Managed Playwright Vite/browser processes terminated normally.

Released SHA256: source table `80c29c2cb01440fbc4a64683fd8ddcff72bd6b034e5056c40857f69de32ac312`; final browser spec `bed883aad90ecb8e89a5e619bf3d92353a18cf1caa57c8e0d7452e3e3ffb8d60`; fixture TSX `81a16718de18784daa513dc39ccfdc6297e7973297e0d3cc3850e1bcf0b3320b`.

## Limits

This is actual Chrome component/hook evidence with synthetic intercepted transport, plus separate real PostgreSQL/HTTP contract evidence. It is not an end-to-end production/UI-route acceptance test. Other expense callers may require separately confirmed same-family corrections; this source change touches only ClaudeExpenseTable. No claims about all destructive/restore combinations, providers, physical mobile devices or production data. No merge/deploy/full-suite action was performed by this worker. Parent owns final integration/freeze and whole-package checks.
