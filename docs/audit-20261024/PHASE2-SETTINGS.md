# Phase 2 settings draft retention

Confirmed bug: failed settings saves could erase the submitted input after an optimistic render. Mounted baseline actual CompanySection/hooks at1440/390:2 RED rollback assertions,4 GREEN canonical-success/newer-edit controls. Original proof retained in `reports/night-audit-20261024/settings-readonly/mounted-baseline.log`, native1, `browser-results/` traces. Synthetic GET/PATCH only; no DB/providers/live settings.

## Fix

Default optimistic cache writes and request cancellation remain. `useUpdateSettings` captures the actual structurally shared cache snapshot returned by QueryClient and marks optimistic/rollback/confirmed provenance in a WeakMap. Nothing is serialized or persisted. No-op identities are not treated as new optimism; latest provenance replaces old provenance; confirmed responses clear stale tags.

Each mounted form records which fields were already edited before an observed optimistic snapshot, keyed weakly by that exact original cache identity. On that snapshot's rollback, only previously dirty fields are protected. Pristine optimistic fields roll back normally. Successful canonical responses and edits made while awaiting the response continue through the original refill comparison. Baseline still advances after rollback.

Shared hooks accept optional original source identity, documented as the actual query-cache settings object, not the derived form mapping. Wired all11 general-settings sync consumers in7files: Agency, Discipline, Leads, Matching, Money(two), System, Team(four). SMS uses a separate settings key and non-optimistic mutation; OpenAI covers uses its own query key/PUT with success invalidation; Profile has a different source. These consumers remain on the original no-source behavior.

## Focused evidence

- Actual mounted ignored harness after fix:8/8 Chrome GREEN, native0,1440/390. Submitted draft survives400; canonical response accepted; newer edit survives success; actual RoyalScore toggle changes optimistically before the response and returns to saved state after400.
- Promoted tracked harness revalidated after path/import changes:8/8 GREEN, native0. Files: `apps/web/playwright.night-settings.config.ts`, `tests/fixtures/night-settings-rollback.html`, `tests/fixtures/night-settings-rollback.tsx`, `tests/e2e/night-settings-rollback.spec.ts`. Managed Vite5199 lifecycle; all API requests intercepted, unexpected endpoint fails harness. Command from `apps/web`: `npx playwright test --config playwright.night-settings.config.ts`.
- Pure focused suite:14/14 GREEN across existing serverFormSync7 and new rollback7. Includes dirty/pristine mixed rollback, newer edit, canonical success, independent identities with same values, actual QueryClient structural sharing/no-op/reused identities, confirmed marker cleanup. Command from `apps/web`: `npx vitest run --config vitest.config.ts src/lib/__tests__/serverFormSync.test.ts src/lib/__tests__/serverFormRollback.test.ts`.
- Final targeted ESLint native0 including helpers/hooks/callers/new unit/browser files.
- Final web TypeScript `npx tsc --noEmit`: native0. Initial2 type errors were missing explicit QueryClient generic annotations in new unit test, corrected; initial failure retained separately.

Logs and exits under phase2 ignored `reports/night-audit-20261024/settings-readonly/`: `unit.*`, `eslint.*`, `tsc.*`, `mounted-patched.*`, `mounted-tracked.*`. Initial harness startup/path failures are retained separately and are not bug evidence. Existing rejected async Company submit still emits its existing ApiError; this change preserves draft without changing error/product policy.

No API/shared/dependency edits, complete suites, map regeneration, commits, push, merge or deployment by this task. Parent independently reviewed the helper/hooks,11caller wiring and7new pure cases; no concrete introduced defect found in that named scope. Full package validation remains parent's responsibility. First-load draft candidate and assistant-audit end-date candidate remain unchanged and separately documented in main `NEXT-SETTINGS-READONLY.md`.
