# FINAL CF-01: client radius native validation

Own FINAL public worktree/branch: `D:/PublicWorktrees-20261021/night-audit-20261024-final`, `codex/night-audit-20261024-final`, baseline5616f8e3e886c500d0eeebf5edda924757620a2d. Parent explicitly granted this independent source lease after FINAL fresh dependency/shared/Prisma readiness. Old phase2 source/tests/dependencies remain untouched and frozen for their separate cloud run.

## Problem and minimal fix

The client contract accepts integer radii100..10000m; the client form seeds configured1250 and preserves stored1250. Native Next used step100 and blocked1250, while the same form's ordinary review-step submission accepted/preserved1250. Root independently reviewed code/comment, actual schema controls, raw browser payloads for1440/390 and executed readonly specs before authorizing the fix.

**Only application change:** PlaceRadiusInput `step={100}` → `step={1}` in `apps/web/src/components/ClientFormModal.tsx:61`. Existing values, integer API/shared validation, min100/max10000, defaults, state, blur clamping, MatchingTab and global native validation remain unchanged. No rounding1250 to1200/1300. Rejected fractional-budget hypothesis is not part of this bug/fix.

Before edit: `npm run where -- --file apps/web/src/components/ClientFormModal.tsx` native0; `node scripts/impact-tests.mjs --for=apps/web/src/components/ClientFormModal.tsx` native0. The impact helper explicitly reports no backend/shared change; that is not full frontend coverage. Logs retained.

## Durable regression: real components and native form

Tracked config/fixture/spec: `apps/web/playwright.night-client-radius.config.ts`, `tests/fixtures/night-client-radius.html`, `tests/fixtures/night-client-radius.tsx`, `tests/e2e/night-client-radius.spec.ts`.

Real ClientFormModal/Rh2Sheet/hooks/application CSS in installed Chrome at1440/390. Synthetic intercepted profile/settings/district/client responses only; all external map/font requests aborted consistently. Managed Vite5211 lifecycle. No detached server, PostgreSQL, live client, provider or production operations.

Normative positive oracle: actual Next advances, native invalid-event list stays empty, one native submit fires, form.noValidate remainsfalse, and eventual actual payload preserves radius. This does not copy the readonly diagnostic invalid expectation into desired behavior. Fraction1250.5 alone expects native rejection without advancing, request or rounding.

14 identical cases before/after source fix:

| Scenarios at both widths | Cases | Baseline | Patched |
| --- | ---: | --- | --- |
| New configured1250, stored1250 | 4 | RED: actual Next cannot advance | PASS |
| New1200/min100/max10000 | 6 | PASS | PASS |
| Fraction1250.5 rejects unchanged | 2 | PASS | PASS |
| Ordinary review-stepbar1250 payload unchanged | 2 | PASS | PASS |

**RED native1:4 failed +10 passed,0flaky/skip. GREEN native0:14 passed,0flaky/skip.** No test/spec mutation between RED and GREEN. Original component SHA256f8f3de169069d24aa548d12d7e479f16a227833ed267f784bad9dc0442a4c770 matches5616 and original readonly proof. Raw RED copied separately before GREEN.

Command from apps/web: `npx playwright test --config playwright.night-client-radius.config.ts --reporter=json`. GREEN additionally sets an own ignored output directory to preserve RED traces. JSON reports retain full native assertions and12 successful actual client-write attachments; decoded `green-write-01.json`…`green-write-12.json` all have0invalid events. New/stored native-next paths have2 submits total after final save; the test independently asserts1 immediately after Next. Stepbar paths have1 final submit.

## Focused checks and evidence

- Web `npx tsc --noEmit`: native0.
- Browser fixture/spec/config explicit TypeScript scope using ignored config extending actual web config: native0. Initial scope-only failure omitted existing vite-env.d.ts; corrected ignored config includes that existing declaration, no app/dependency changes. Initial diagnostic retained separately.
- Targeted ESLint for component/fixture/spec/config: native0.
- `git diff --check`: native0 for the authored change.

Ignored evidence: `reports/night-audit-20261024/client-radius-final/` contains where/impact logs/exits, RED/GREEN JSON and native exits, separate red-browser-results traces/error-context, GREEN output,12 decoded write payloads and index, type/lint logs/exits, manifest with baseline and final source/test SHA256. Source fix is exactly one attribute; durable tests cover its actual business contract.

No fullsuite, map regeneration, dependency mutation, API/shared edit, commit/push/merge/ship/deploy. Parent owns independent review and final consolidated validation. Local browser proof does not claim real HTTP/PostgreSQL or production activation for CF-01.
