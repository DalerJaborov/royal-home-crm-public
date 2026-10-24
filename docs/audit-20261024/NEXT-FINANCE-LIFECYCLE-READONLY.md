# Expense archive preservation — bounded read-only pass, 24 October 2026

## Result

One confirmed ordinary UI caller defect, **NFL-01**: the expense table omits the opening version from deletion even though the server and shared mutation hook already support optimistic concurrency. A stale confirmation therefore archives a subsequently corrected expense. This is soft deletion, not physical loss; restoring is possible. It hides the corrected paid expense from active lists/accounting until restored. No application fix was authorized or applied in this pass.

Read BUSINESS.md and COVERAGE.md first. Product map `docs/product-map.md:182` maps `/api/v1/expenses` to `apps/api/src/routes/expenses.ts`. Selected previously unexecuted ordinary table archive/concurrent edit/restore combination; excluded rate, accounting period and recurrence calculation families already covered. Reading subscription code is not claimed as executed subscription coverage. Stopped exploration after the confirmed candidate, as requested.

Runtime/source: retained PHASE2 `5616f8e3e886c500d0eeebf5edda924757620a2d`; FINAL remained frozen under the parent. The table file is byte-identical in FINAL at inspection time. Only ignored probe files in PHASE2 and this MAIN report were written; no default tests, source, dependencies, maps, commits or production were changed.

## NFL-01 reproduction and existing contract

Source chain:

- `apps/web/src/components/finance/ClaudeExpenseTable.tsx:32`: captures the confirmed row, then calls `remove.mutateAsync(row.id)`; confirmation at line 43 displays the captured expense's name and amount.
- `apps/web/src/lib/claudeFinanceApi.ts:87`: accepts either a string ID or `{id,version}`; only the latter generates `?version=...`.
- `apps/api/src/routes/expenses.ts:240–245`: DELETE includes version and `deletedAt:null` in its atomic write predicate only when a version query is supplied. Otherwise it updates by ID alone.
- Existing editor path `ClaudeExpenseSheet.tsx:102` supplies `{id:editing.id,version:editing.version}`. Existing `expense-workspace.test.ts:60–69` asserts stale versioned deletion must reject and preserve the correction. We reuse this existing preservation rule; no new finance policy is inferred.

Synthetic real HTTP/PostgreSQL sequence:

1. DIRECTOR creates a paid OFFICE expense: amount=100, version=0; this is the row captured by a table confirmation.
2. A separate ordinary versioned PATCH corrects it to amount=250, note=Corrected..., version=1; HTTP 200.
3. Send the exact table-equivalent request, `DELETE /api/v1/expenses/:id`, without a version.
4. **Actual:** HTTP 204; stored amount remains 250 but deletedAt becomes non-null and version=2. The newer correction is archived despite confirmation describing the earlier snapshot.
5. **Expected under the existing versioned-delete contract:** HTTP 409/EXPENSE_VERSION_CONFLICT and corrected expense stays active. Control with identical steps but `?version=0` returns 409 and preserves active amount=250.

The ignored regression deliberately asserts the expected 409 on step 4 and fails `expected 204 to be 409`; it also prints a sanitized readback `{openedAmount:"100",openedVersion:0,http:204,storedAmount:"250",storedVersion:2,archived:true}`. No speculative timing barrier is needed: the deterministic user sequence captures the stale snapshot before the newer edit.

## Executed evidence and controls

Own NEW `audit_finance_lifecycle TEMPLATE audit_template`, existing own PostgreSQL container on 127.0.0.1:15439. No other DB reset/deletion. Real Express/Supertest/Prisma/PostgreSQL, synthetic DIRECTOR and expenses. Throwing global fetch guard asserted zero external requests; no providers, real calls or Telegram exports were invoked. Vitest 4.1.12; retry 0.

Ignored PHASE2 artifacts: `reports/night-audit-20261024/finance-lifecycle.config.ts`, `finance-lifecycle.test.ts`, `finance-lifecycle-red.log`, `finance-lifecycle-red.exit.txt`.

**Native exit 1: 1 failed / 2 passed**, 3 distinct cases, no retry:

| Case | Result and evidence |
| --- | --- |
| Ordinary fresh versioned archive → restore | PASS: active list excludes, archive includes, paid pivot becomes 0; restore preserves all stored business fields exactly except expected version/updatedAt, same ID, pivot becomes 100 |
| Stale versioned delete after amount/note correction | PASS: HTTP 409, corrected amount 250 retained active |
| Exact table-equivalent stale delete | RED: HTTP 204, corrected expense archived; expected 409 |

Cleanup awaited exactly the eight own best-effort audit writes, removed only audit rows with the captured actor ID, captured expense IDs, and captured actor ID. Final readback in this own DB: Agent=0, Expense=0, AuditLog=0. Default test Settings were created only in the own isolated database; no production/configuration actions occurred.

## Minimal proposed repair, pending parent decision

Change only the table's confirmed deletion call to `remove.mutateAsync({id:row.id,version:row.version})`, matching the existing editor and hook contract. Preserve existing error rendering and successful delete/undo behavior; keep the server's deliberate legacy ID-only compatibility unchanged. The current expense DTO already contains version and frontend Expense declares it. No new server policy is needed.

Durable frontend regression: in `ClaudeExpenseTable.test.tsx`, provide a fixture version, use a writable role, open the row deletion confirmation and confirm; assert the mutation receives exactly `{id,version}` from the displayed/captured row. Add a rejected-409 control to verify the error surfaces and no success/undo feedback is recorded. Existing real API stale-version control already exercises the atomic predicate; retain this ignored two-client/edit-sequence reproduction for independent confirmation. Run only the affected frontend file and proportionate existing expense API group if parent authorizes a patch. No repair or GREEN claim is made here.

## Limits and source pins

Actual browser interaction was not executed; table→hook linkage is source evidence, while request/state behavior is actual HTTP/PostgreSQL evidence. All ordinary/admin roles, receipt restoration, recurrence edit/materialization and every destructive combination are not covered. No security or production conclusions follow. Unversioned legacy DELETE intentionally remains supported; the defect is the current version-aware table dropping its available snapshot version.

SHA256 pins: table `ab85d958ddf0bed144620304568994c45bac8cb02d885c2a5d5b6e1b0a03673b`; hook `db80a18488b871bd316cd1b79f3ca40ca791c0763c704c40fac9e826536925b3`; expense routes `a7369d5f6afe1c167535464ac3000675ca20123b7d64e40afcc12a7d1cc3e931`. No tests/probes remain active; runtime/source released to the parent.
