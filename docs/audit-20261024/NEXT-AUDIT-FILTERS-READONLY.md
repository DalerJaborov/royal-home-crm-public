# Assistant audit calendar filters — read-only follow-up

Source pin: frozen phase2 `3305fdc7dfcbde3a7d79e7ea8b00c8650de92a1c`. No application/default-test/dependency edits, live log reads, database changes, configuration or provider calls. Evidence is isolated in phase2 ignored `reports/night-audit-20261024/audit-filter-readonly/`. Main report only is written here.

## Finding AF-01: selected calendar day is reduced to a UTC instant

The inclusive calendar-day contract is explicit in source, not a proposed product change:

- `packages/shared/src/querySchemas.ts:276`: UI sends date-only `to`; routes must extend it to end-of-day. `assistantAuditQuerySchema` extends this schema.
- `apps/api/src/routes/ai.ts:175`: assistant-audit period/pagination are documented as using the same period semantics as activity.
- `apps/api/src/lib/activityFeed.ts:31` documents Dushanbe calendar-day boundaries, the prior first-five-hours omission and end-day truncation; actual `activityPeriodBounds` normalizes both ends.
- `apps/web/src/pages/settings/SystemTab.tsx:552`/564 labels date fields «Период с»/«по», sends YYYY-MM-DD unchanged, and renders row timestamps in Asia/Dushanbe.

Actual assistant-audit handler parses date-only values to UTC midnight and uses them directly as `createdAt.gte/lte` (`ai.ts:184`–189), without the calendar normalization. Selecting both dates2026-10-24 emits `from=2026-10-24&to=2026-10-24`; both DB bounds become2026-10-24T00:00:00.000Z. Only an event at exactly05:00:00 Dushanbe can match. Noon and other events of that selected day disappear. With only `to`, the selected day's events after05:00 disappear; with only `from`, its firstfivehours disappear. These are variants of one missing-boundary-normalization family.

Expected same-day Dushanbe bounds from the existing activity implementation: start2026-10-23T19:00:00.000Z, inclusive end2026-10-24T18:59:59.999Z.

## Executed actual-source evidence

`actual-route.mts` finds the real registered assistant-audit callback, page-size constant and client-summary helper using TypeScript AST; executes their transpiled source with the actual imported shared schema. The Prisma substitute receives and records actual handler `findMany`/`count` arguments, then applies mathematical gte/lte/agentId to synthetic rows. It never opens a database. Expected bounds use actual `activityPeriodBounds`, independently anchored by the source contract above.

40 deterministic cases:10 dates across year/month boundaries and leap day, with same-day/from-only/to-only/unfiltered variants. **30 contract failures,10 unfiltered controls pass**. Each selected-day dataset has six in-day boundary/noon rows and two outside rows. Same-day actual result contains only the exactUTC-midnight row instead of allsix. Native exit1 denotes these failed contract assertions, not harness startup. `results.json` retains exact comparison bounds, IDs, route hash and five source hashes.

Additional7 controls: invalid from/to/agent/page return400 before any adapter call; page2 uses skip50/take50 and returns no rows while total8; nonmatching valid agent returns zero; unfiltered request returns all8. Invalid inputs are not silently accepted. Nodev24.20.0; source3305 runtime only.

Command from phase2 root: `npx tsx reports/night-audit-20261024/audit-filter-readonly/probe.mts`.

## UI and same-module observations

Mounted Chrome actual AssistantAuditSection with synthetic ADMIN UI permissions, synthetic profile/agents endpoints, and audit responses produced by the actual callback above: **6 cases,2 RED inclusive-date failures +4 GREEN clear/error controls, native1**. At both1440px and390px the unfiltered noon event is initially visible; selecting both calendar dates removes it while the exact05:00 event remains. Captured browser query and actual callback list/count arguments agree. Clearing the end-date restores the noon event; intercepted500 shows the explicit failure alert. This demonstrates the UI→query→actual-handler contract with synthetic storage, and cannot establish real middleware authorization or PostgreSQL behavior; those remain explicitly separate.

Source-only adjacent checks: filter changes reset page1; query responses for prior filters are ignored by effect cleanup; Pagination uses response `data.page` and the existing common component, so earlier requested-page load-more work is not repeated. Empty state appears only with loaded empty data. On request failure an explicit alert says the list does not prove no events. No separate new pagination/error bug is counted.

## Fix scope proposal and limits

Minimal follow-up: reuse existing `activityPeriodBounds(from,to)` for assistant-audit's createdAt boundaries; preserve page/agent filter and permission middleware. Add isolated API boundary regressions for early/noon/end-day/outside rows, from-only/to-only, and list/count consistency. Source remains frozen during cloudfull; no fix performed in this pass.

Not claimed: production incidence, real audit rows, complete Settings/role coverage, real PostgreSQL execution, broad date-schema changes, or any policy change. Thirty failing inputs are one family, not thirty bugs.

## Final evidence inventory

Ignored phase2 folder: `reports/night-audit-20261024/audit-filter-readonly/` contains actual-source runner `actual-route.mts`, pure runner `probe.mts`, complete `results.json`, `probe.log`/`probe.exit`, original mounted fixture/config/spec, `mounted.log`/`mounted.exit`, retained `browser-results/` traces, error-context and actual-route attachments. `mounted-r1-harness.log` is a discarded ESM harness-loading failure, repaired only by adding a local ignored package.json with type=module; no dependency installed and no app manifest changed. This error is not counted as bug evidence.

Mounted command from phase2 root: `npx playwright test --config reports/night-audit-20261024/audit-filter-readonly/playwright.config.ts`. Playwright managed Vite5200 lifecycle finished. No detached server, application source/test/dependency mutation, full suite, map, commit or production access. Source pin remains3305; reviewed source-byte hashes retained in results.json. Source contract confirmed; isolated real-PostgreSQL regression is still required before a follow-up fix is accepted.
