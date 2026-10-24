# Phase 2: recruitment staff-text limits

Worktree `D:/PublicWorktrees-20261021/night-audit-20261024-phase2`, branch `codex/night-audit-20261024-phase2`, base `0466aca29e9090e046e8affdf93760c9224144bd`. Separate phase 1 source/dependency freeze preserved.

## Change

The three recruitment field paths now share the existing API limits: create/internal note **2000** characters; rejection reason **500**. Public constants live in the already-exported shared recruitment module and are consumed by API boundary schemas and both web forms. API trimming/null semantics and limits remain unchanged.

The creation helper and stage form validate the trimmed text that their payload actually sends, showing a specific correction message before a request. New input uses matching HTML limits. No text is sliced or silently truncated; an over-limit historical initial value remains visible and must be edited before it can be saved. A later corrected submit clears the previous local error.

## Regression work prepared

- Web unit: accepted 2000-character create note passes unchanged; 2001 rejected without mutating the draft; internal note/reason exact boundary and +1, whitespace, blank and 4000-character historical values.
- Existing real API PATCH test file: note 2000/reason 500 save, +1 rejects without overwriting the stored value, null still clears. Added POST create case persists 2000 characters intact, rejects 2001 and confirms no extra candidate was created. Uses the isolated test fixtures and a temporary position/candidate cleaned by its own key; no production records.
- New actual-component Chrome fixture/spec: create, internal note and rejection reason at desktop/mobile widths. Checks matching HTML limit, retained over-limit legacy value, no request on local rejection, retained corrected draft after injected server rejection, successful retry with exact untruncated payload. All CRM requests intercepted, no providers or database.

## Verification checkpoint

All focused checks completed successfully using the **fresh phase 2 dependency installation**, whose npm-ci and Prisma-generation exit files were both verified as 0. Its root shared-package junction points to phase 2's own package; no old dependency/shared tree was built or changed.

| Check | Result | Raw evidence under `reports/night-audit-20261024/phase2-fields/` |
| --- | --- | --- |
| Own `npm run build:shared` | exit 0 | `shared-build.log`, `.exit` |
| Focused web tests: vacancyQueue, vacanciesScreenFixes, vacanciesResumeRendering | **75 passed / 3 files**, exit 0 | `web-focused.log`, `.exit` |
| Actual create/note/rejection form Chrome scenarios, 1440px and 390px | **6 passed**, exit 0 | `browser.log`, `.exit` |
| Real API + isolated PostgreSQL `vacancy-patch.test.ts` | **14 passed**, exit 0 | `api-boundaries.log`, `.exit` |
| Web TypeScript `tsc -b --pretty false` | exit 0 | `web-typecheck.log`, `.exit` |
| ESLint on four changed web source/test paths | exit 0 | `web-eslint.log`, `.exit` |
| `git diff --check` on owned files | exit 0 | recorded in specialist handoff |

The parent assigned the `audit_roles` database on its owned local port 15439 for the real API run, with synthetic test credentials/configuration. The API test used actual Express/auth/Prisma handling and checked persisted values/rejected request counts. That DB is released back to parent after the run. No providers were invoked. API imports emitted a pg query deprecation warning but no failed tests.

First browser authoring run had **2 passes / 4 harness failures** because the mocked contact-options omitted the required `clarification` object. `browser-r1-harness.log` is retained; the fixture was corrected and the complete six-case final run passed. This is not counted as an application defect or as baseline failure evidence.

The shared build was announced ready to the parent, import and upload specialists before their tests; only this worker built shared. Impact/where output is retained in `impact.log` and `where.log`. A first impact redirection used the wrong working directory and did not execute the script; the corrected root invocation produced the retained output. No commit, map regeneration, broad web/API suite or deployment was performed by this specialist.

## Limits / integration handoff

Scoped field behavior is verified across pure helper, actual browser components with intercepted responses, and actual HTTP/isolated PostgreSQL boundary execution. Browser mocks do not prove authorization or provider delivery. The existing API limit policy and historical rows are preserved, not expanded. Parent owns subsequent dependency updates, map/build/precheck/full-suite integration and review-ready commits. Baseline reproduction for this bug family is retained separately in the phase 1 `NEXT-FIELDS-READONLY.md` and generated-field evidence.
