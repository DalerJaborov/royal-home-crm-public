# NFL-01 variant: mounted ExpensesWorkspace drops the delete snapshot version

Confirmed ordinary mounted UI variant of **the existing NFL-01 family**, not an additional bug-family count. This read-only discovery changed no application/default test/dependency. A subsequent FINAL source lease is separate.

## Actual path and contract

`apps/web/src/pages/Finance.tsx:507` mounts `components/finance/ExpensesWorkspace.tsx`. Its `ExpenseRow` uses the sole caller of `hooks/useFinance.ts::useDeleteExpense` (line126). Delete passes only `e.id` at340; the hook accepts only an ID and produces unversioned DELETE. In contrast, edit captures its opening version and passes it to its existing mutation. Delete opening only sets a boolean; it does not preserve a version snapshot.

The existing API contract at `apps/api/src/routes/expenses.ts:240–254` accepts an optional version: a stale supplied version rejects409/EXPENSE_VERSION_CONFLICT, whereas omitted version deliberately retains legacy compatibility and archives the current row by ID. No mandatory-version server policy is proposed. `NEXT-FINANCE-LIFECYCLE-READONLY.md` already records actual own HTTP/PostgreSQL evidence:100/v0→PATCH250/v1; DELETE?version=0 preserves active250 with409, while ID-only DELETE returns204 and archives250/v2. This variant reuses that evidence without pretending to run another real-PG test.

## Mounted browser reproduction

PHASE2 source5616, installed Chrome1440/390, actual ExpensesWorkspace/ConfirmDialog/hooks/QueryClient and application styles. Only own synthetic intercepted transport was used; no PostgreSQL/provider/configuration operation. Controlled transport mirrors the independently verified API optional-version contract.

1. Actual expenses query returns synthetic100/version0; open the ordinary Delete confirmation.
2. Synthetic server state is corrected to250/version1. Call the real QueryClient's exact expenses-query refetch; the mounted underlying row visibly changes to the corrected note while the confirmation remains open.
3. Click the ordinary confirmation button. Actual hook sends DELETE with empty query string: no version at all.
4. Mirrored compatibility branch archives amount250/version2; the actual workspace refetch removes the row and displays its empty state.

Expected under the existing version-aware UI contract: preserve the version from confirmation opening and send version0; the actual API would reject409 and leave corrected250 active. The baseline confirmation names the category and does not display the numeric amount; this report does not claim that it retained an amount label after refetch.

Ignored PHASE2 harness: `reports/night-audit-20261024/expense-workspace-readonly/` contains fixture/config/spec, browser JSON/native exits and decoded `passed-evidence.json` with exact two stale DELETE payload/state records.

- Initial diagnostic `browser.json`:4 ordinary controls pass (fresh archive and read-only at both widths). Two stale cases reached the expected empty-query DELETE but failed only because the probe's final empty-state text locator was initially wrong; that locator failure is not an application finding.
- Corrected ignored locator, rerun only stale cases: `browser-stale-r2.json`, native0,2 diagnostic reproductions pass/0flaky/skip. Both retain `{opening:100/v0, DELETE search:"", server:250/v1, final archived:true/250/v2}`. The four unchanged controls were not rerun.

These are discovery assertions of observed faulty behavior, not a patched normative GREEN. No API policy, live deployment, real user archive or production result is claimed.

## Minimal repair proposal

Extend the existing hook input to backward-compatible `string | {id:string;version?:number}` and include version when defined, including zero. Capture the expense version when confirmation opens, then pass that captured version on confirmation; do not read only the latest refetched `e.version`. A dedicated ref or safely shared opening ref is sufficient. Preserve existing synchronous action lock, error display, list invalidation and legacy/server compatibility. Do not import a higher-level finance API helper into this lower-level hook, as that module already imports useFinance.

Durable normative browser cases at1440/390: stale opening/refetch must send version0 and surface409 while corrected250 remains active; fresh version0 archive remains successful; read-only view sends no mutation. Add a narrow legacy-string hook control if needed. This is the same NFL-01 root cause and scope as the table caller repair.

Unchanged source SHA256: ExpensesWorkspace `57CFAF0802F804198AC9AF5F75D83D710BA96A85EEBF67394E267533698AFF62`; useFinance `C5654F62113E4BB25E476AD554FDEA85CBC65F7AD965474F649DD8EFABA2DDCF`; expense API `A7369D5F6AFE1C167535464AC3000675CA20123B7D64E40AFCC12A7D1CC3E931`.
