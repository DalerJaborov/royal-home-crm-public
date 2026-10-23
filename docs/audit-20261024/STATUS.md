# CRM overnight audit — 24 October 2026

Deadline: 08:00 Asia/Tashkent, 24 October 2026. Heartbeat `crm-08-00-24` continues this chat every 30 minutes until the deadline, then pauses itself. Execution requires the desktop app/host to remain available.

## Baseline and boundaries

- Own worktree: `D:/PublicWorktrees-20261021/night-audit-20261024`, branch `codex/night-audit-20261024`.
- Fresh public baseline: `87aecdb` (origin/main fetched 23 October around 21:52 UTC). Primary main was `96e9e08`; do not switch or advance it.
- No ship/merge/deploy, live configuration, paid generation, real provider sends or production test records. Preserve all foreign checkouts and databases.
- All findings must distinguish source review, mocked execution, isolated database, browser and production evidence. No claim of zero bugs or complete coverage from a green suite.

## Work distribution

1. Parent: full inventory/coverage, shared schemas, background jobs, test infrastructure, isolated database and browser setup, integration/review/report.
2. `api_roles`: API role/ownership/validation and attachments/settings/staff/tasks/recruitment; report API-ROLES.md.
3. `business_rules`: finance/deals/clients/properties data and business rules; report BUSINESS.md.
4. `frontend_roles`: ordinary/admin screen states, field handling, session/data loss, desktop/mobile; report FRONTEND.md.

## Method and next passes

- Generate a machine inventory from product map plus source and test files; use explicit states rather than implied completeness.
- Follow reproducible failure → cause → regression → minimal fix → related checks.
- Vary cases: authorized/forbidden roles, missing/extra/invalid fields, empty/large data, dates and numbers, duplicate requests, failure/retry and concurrent edits.
- Review specialists independently, run required map/build/guards and relevant API/web checks; complete consolidated suite once ready.
- Save sanitized evidence and review-ready commits/draft PR. At deadline report confirmed findings/fixes/check counts/limitations and next work.

## Current progress — 03:31 Asia/Tashkent

- Three specialists completed the first pass; API and business reports are saved. Frontend report is being finalized. All source edits remain in the own worktree.
- Confirmed/fixed families: seven business defects (see BUSINESS.md), three API/authorization/file-retention defects (API-ROLES.md), three frontend families (FRONTEND.md pending), and the stand dependency-routing defect. Parent review/consolidated validation is still in progress; no production fix claim.
- API specialist: final recovered runs cover 10 distinct files / 77 tests. Original incomplete livevoice green is excluded; use api-roles-recovery-*-green logs.
- Business specialist: money/month run 8 files / 71 tests, final adjacent deal/reservation run 9 files / 42 tests. Counts overlap; do not add them as unique tests.
- Frontend: 53 focused tests previously green; recovered API-copy subset 9 green and six Chrome component-fixture cases green (1440/390). Pagination caller wiring has been extended; build/review pending.
- Stand routing regression: 14 tests green. Dependency links now resolve the public primary checkout and own shared overrides.
- Real HTTP/browser role smoke running via playwright.night-live.config.ts against audit_web. First five roles passed when this note was written; final result pending. The fixture imports app.ts only, no cron/worker.
- Own container crm-night-audit-20261024-pg on loopback15439; own databases audit_template/audit_roles/audit_business/audit_web/audit_parent. Original migration attempt failed during DB startup; retry after pg_isready succeeded. All migrations applied to own template and clones.
- npm run precheck -- --no-tests running, full output reports/night-audit-20261024/precheck-r1.log.
- A local complete API attempt was deliberately interrupted (native exit1, before any reported shard/test result) after discovering the documented ~hour local runtime. It is NOT a completed failing test suite. Prefer a single exact-commit GitHub ship-tests workflow_dispatch after review-ready commit; this runs tests only, no ship/merge/deploy.

## Installed audit skills

User explicitly authorized GitHub installations and additional required tools while asleep. Ten skills installed globally using skill-installer: Trail of Bits variant-analysis, property-based-testing, differential-review, sharp-edges, supply-chain-risk-auditor, mutation-testing, post-patch-validation; OpenAI security-best-practices, security-threat-model, gh-fix-ci.

Pinned upstreams: trailofbits/skills 196a9073ab10d35bacf111f945e02c00b2c6883a, openai/skills 49f948faa9258a0c61caceaf225e179651397431. Skill instruction hashes/installation record: C:/Users/Daler/.codex/skill-installations/audit-20261024.json. Upstream licenses/attribution retained. Installation does not mean their tools were executed or that all support code was security-audited. variant-analysis references read for the parent routing sweep; no additional hardcoded main-tree assignment found in scripts.

Automatic approval review rejected a Windows hidden background server launch with only "blocked by policy". No such launch performed. The safer local browser fixture uses Playwright's managed webServer lifecycle instead. Do not try another detached helper to bypass that rejection.

## Immediate next work

1. Finish frontend report/typecheck, local seven-role browser smoke and precheck. Fix any concrete validation failures.
2. Regenerate map after final source edits; independently inspect every diff and evidence group, update coverage with actual subset.
3. Save sanitized review-ready commit and draft PR. Run one exact-head consolidated API suite using workflow_dispatch (test-only). Keep its exact SHA/report separate from production.
4. Continue a new risk-based pass across pending areas with installed skills, without repeating completed checks needlessly. At 08:00 close out honestly and stop/delete the heartbeat.
