# Calendar validation for report periods (NR-02)

Status: approved narrow plan implemented, targeted RED/GREEN complete; parent review/integration pending. No complete-suite or production claim. NR-01 loss-cohort semantics remain policy-uncertain and unchanged.

## Defect and boundaries

Actual HTTP + owned PostgreSQL at baseline `3305fdc` confirmed that advertising accepts month 2026-13 as January 2027, month 2026-00 as December 2025, and February 30 as March 2 while retaining the impossible original label. Advertising and ordinary reports also return 200 for inverted effective periods. The source cause is shape-only validation followed by JavaScript calendar normalization, plus missing effective-order validation.

The product map and exact baseline source/HTTP evidence are in main-worktree `docs/audit-20261024/NEXT-REPORTS-READONLY.md`. Parent authorized only this boundary correction after durable RED, preserving Date/ISO support, Dushanbe expansion, existing range caps and all unrelated policies.

## Minimal source changes

- `lib/reportPeriod.ts` reuses installed Zod 4 calendar validation. Day labels reject impossible dates; month labels require 01–12 without a new year ceiling. Ordinary-report preprocessing validates the original ISO calendar prefix before Date coercion can normalize it, while retaining Date objects and otherwise existing coercion support.
- `routes/ads.ts` retains its extendable period object schema; all six existing resolvePeriod users receive the same calendar fields. Reversed explicit periods return the existing null path, consistently mapped by each caller to structured 400 before business report queries. Month boundaries use the exact ISO-labelled year and setUTCMonth rather than Date.UTC's special 0–99-year normalization.
- `routes/reports.ts` derives a LOCAL query schema, leaving shared dateRangeQuerySchema and its feed/audit `.extend` consumers unchanged. After existing Dushanbe day expansion, an inverted effective range throws ZodError handled as structured 400 by the existing app middleware; the existing MAX_RANGE cap follows unchanged.

Advertising's six handlers are report/board/trend/leaderboard/creatives/reconcile. Ordinary report changes apply only to funnel/agents/sources through parseRange. Security-review digest and frontend activityPeriodBounds were not changed. No global shared schema, dependency, model/provider call, loss percentage formula or notification behavior was edited.

## Reproducible validation

New durable `apps/api/tests/reports-period-validation.test.ts` uses actual authenticated app routes and real own `audit_reports` PostgreSQL; external fetch is a throwing spy and is asserted unused. No Prisma aggregate mocks. The normal API test setup owns its default Settings reset in this isolated test database; no production/live configuration was touched.

1. `reports-period-red.log` + `.exit.txt`: native **1**, original new file **22 failed / 8 controls passed (30 cases)** before app changes. Every regression expected 400 but received 200. Ads invalid-month validation is checked across all six handlers; ordinary impossible date/date-time/order across all three handlers.
2. `reports-period-green.log` + `.exit.txt`: native **0**, **5 files / 66 passed**: new30, ads-routes30, reports-money-needs-finance4, subject-agent1, departed-agent1.
3. Added three compatibility controls after that run: ordinary December→January, Date-object/no-year-ceiling input, and reverse raw instants within one expanded local day. `reports-period-final-controls.log` + `.exit.txt`: native **0**, final new file **33/33 passed**. Other files were not repeated without cause. Thus 69 distinct relevant cases passed across the final affected-file run and unchanged adjacent evidence, not a 69-test single process.

Other valid controls retain leap/same-day advertising dates, December→January advertising bounds, ordinary ISO timestamps, Dushanbe inclusive day endpoints, default windows and the unchanged 60×31-day range cap. Reverse raw timestamps within the same expanded local day remain accepted because their effective calendar window is ordered. Direct helper Date-object control includes year 1800, demonstrating no expense-schema year ceiling was borrowed.

Logs are ignored under phase-2 `reports/night-audit-20261024/`; Vitest 4.1.12, Prisma client/adapter/CLI 7.10.1. `git diff --check` passed for all owned files. No full suite, map regeneration, dependency edit, commit or source publication by this worker.

## Final review pins and limits

SHA-256: ads.ts `6a3dcad2e216fc62ab9a1de08e214debaed4351b825c66aecd913a54c51429dc`; reports.ts `3765e382d9e4d60decf3a306bac92c07e2f2ce336b19db6178ec11da90f7cb46`; reportPeriod.ts `c808b3cbd27e86d6f8756c7ac217525b4437ebc1e213dfd9be2bda68b0e0c53a`; durable test `0e07c8b3d1db39bce2acb6c1f10afb4d175d2e45b06e121d9004b5a8577e8162`.

The 22 failing inputs are variants of one boundary-validation family, not 22 separate bugs. Loss-flow/cohort percentage choices, unrelated date consumers, arbitrary locale-format parsing, browser validation and production data remain outside this patch. Parent owns consolidated compile/precheck/frozen-source checks and final review.
