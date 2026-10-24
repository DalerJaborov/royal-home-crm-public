# AF-01: assistant audit calendar boundaries

Source baseline3305fdc7dfcbde3a7d79e7ea8b00c8650de92a1c; parent reopened the failed cloud PLAN freeze before these edits. No frontend/shared-schema/default/policy change. Only `apps/api/src/routes/ai.ts` imports and reuses existing `activityPeriodBounds(from,to)` when constructing assistant-audit createdAt bounds; permission, list/count, ordering and pagination stay on their existing path.

## Reproduction and root cause

The UI correctly sends calendar-date YYYY-MM-DD. Shared query-schema contract requires extending the end date to end-of-day; assistant route documents the same date semantics as activity, which already normalizes both bounds to Dushanbe. The assistant route instead used parsed UTC-midnight Date values directly. Same-day selection became gte=lte05:00 Dushanbe; firstfivehours and most of the selected ending day disappeared. This is one calendar-boundary family.

Earlier source/adapter and actual component browser evidence remains separate:10day40cases with30 counterexamples; Chrome1440/390 two REDs +four clear/error controls. See main `NEXT-AUDIT-FILTERS-READONLY.md` and phase2 ignored `reports/night-audit-20261024/audit-filter-readonly/`.

## Actual HTTP/PostgreSQL RED → GREEN

Created NEW `audit_filters` from existing own `audit_template` on own loopback15439 container after confirming name absent and template haszero connections. No existing database reset/drop/termination. Tests use actual Express app, authentication/permission middleware, shared schema, Prisma and PostgreSQL; synthetic agents and audit rows only. No model/provider calls. Fixture cleanup targets created agent IDs; the retained own clone is not deleted.

New tracked regression: `apps/api/tests/assistant-audit-calendar-range.test.ts`,11 cases. Same-day leap-day2040-02-29 includes midnight,04:59:59.999,05:00,05:00.001,noon,23:59:59.999 Dushanbe and excludes adjacent days. Separate from-only/to-only cases exercise both defects. Controls cover clearing dates, selected-agent/list-count parity, invalid dates/agent/page rejection, ordinary agent403, and53-row50/3 pagination without duplicate IDs. Fixture selection is scoped by own created agentId; no dependency on unrelated seeded records.

- Before route edit: actual HTTP/PG **3 RED +8 PASS, native1**. Same-day received1 expected6; from-only omitted midnight/early; to-only omitted post05:00/noon/end. Raw `api-red.log`/`api-red.exit` retained.
- After minimal fix: **28 PASS /3files, native0**: new11 +existing activity-summary12 +activity-feed-query5. Raw `api-green.log`/`api-green.exit` retained.
- Command from apps/api: `npx vitest run tests/assistant-audit-calendar-range.test.ts tests/activity-feed-query.test.ts tests/activity-summary.test.ts --maxWorkers=1`, with DATABASE_URL pointing only at own audit_filters, synthetic JWT/encryption keys, NODE_ENV=test and TEST_ENV_PIN=1.
- API `npx tsc --noEmit`: native0. `git diff --check` native0. Read-only fixture cleanup readback:0 audit-calendar log rows and0 test-audit agent rows; own audit_filters clone retained.
- API/root ESLint is not configured in this repository; attempted targeted command exits2 because eslint.config is absent. No configuration/dependency was added and no lint-pass claim is made.

Dependency execution gate was honored: no API/pure/browser run during parent's brief serialize-javascript update; resumed only after READY. Actual focused runs use parent's updated fresh phase2 dependencies. No shared build needed.

## Scope and remaining validation

Only route, regression, this report and journal entry are authored for AF01. No API/provider writes outside own fixtures, UI edit, sharedschema change, dependency mutation, fullsuite, map regeneration, commit/push/merge/deploy. Parent owns final package review/map/precheck/cloud validation. Real isolated HTTP/PG confirms the contract violation and fix; production incidence and real user logs remain uninspected.
