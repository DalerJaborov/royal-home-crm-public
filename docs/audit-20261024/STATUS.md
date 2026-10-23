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

## Current checkpoint — 03:44 Asia/Tashkent

- First source commit b20bc69603f66acbbfe31cb3ab9ddc5d32a1f043 is LOCAL ONLY. Native precheck exit0: 304 web files/1867tests;104scriptpassed/32conditionalSKIP/0failed. Root's final exact-spec role browser run8/8,80 route/viewport visits, exit0.
- First git push failed before TCP connection; subsequent normal API and git readonly probes also failed. No PR/cloud run created and no changes to network configuration. Retry ordinary access only after a meaningful interval or restored connectivity, not a blind retry loop.
- Independent pinned frontend baseline proof completed in retained separate worktree: API5assertionfail/4controls versus patched9pass; Chrome6fail/2controls versus patched8pass; extra direct Escape/skip probes2fail baseline/2pass patch. See FRONTEND-BASELINE.md and retained baseline-validation logs/hashes.
- Independent API patch review found no introduced defect in the named6sourcefiles; residual existing filesystem TOCTOU and local-only JWT/stream semantics documented in REVIEW-API.md.
- Independent BUSINESS review found lock-order deadlocks introduced/exposed by the new reservation FORUPDATE. Publication HOLD. Business author has changed stage-changing PATCH to lock Property first, preserving CAS and reservation-snapshot protection. New durable2case realHTTP/cron regression is being verified with adjacent suites. Attribution of the second variant to original87 versus patch is still under investigation; do NOT count it as a new original bug without baseline proof.
- Active specialists in this runtime: finish_business owns final lock fix; finish_api owns review/baseline attribution; finish_frontend finished baseline proof. Their runtime may be absent after heartbeat; recover by reports and files before respawning.

## Immediate next work

1. Finish lock correction, preserve its red/green evidence, ensure no temporary red proof test remains unexplained in the default suite. Do not suppress a confirmed bug; record any unresolved finding explicitly.
2. Regenerate map, typecheck changed API, run proportional related checks, and save a second local commit preserving b20 baseline.
3. Freeze corrected source and run consolidated API once. Prefer test-only exact-head GitHub workflow when reachable; otherwise ordinary foreground local suite on OWN audit_parent with4workers is available. Do not start while source is changing. Do not count interrupted attempt as suite failure/success.
4. Create draft PR only after normal GitHub connectivity is restored and source checks pass. No ship/merge/deploy.
5. Continue risk-based pending areas with installed skills. At08:00 close out honestly and stop/delete the heartbeat, retaining all audit evidence/databases.

## Freeze checkpoint — 03:48 Asia/Tashkent

Independent review completed. The introduced deadlock family is corrected with6lines in stage PATCH; final5files/28tests passed, API build native0 and map:check native0. Exact original87 baseline separately reproduces stale-state variants without cron errors, whileb20 has deadlocks. REVIEW-BUSINESS.md contains attribution and final conditional approval. No temporary red proof file remains in the default main suite. Frontend baseline proof and eight-role final pass are complete.

Parent is saving the corrective commit, then starting the single complete local API suite on the exact corrected HEAD because ordinary GitHub TCP remains unavailable. While this suite runs, freeze application source and regression tests; reports may be updated. Full-suite source pin, exit file and output will be under reports/night-audit-20261024/api-full-local-final*. Do not start another full suite or claim completion from partial output. If the exec session ID is unavailable after heartbeat, inspect these files and the own process before deciding whether it ended; do not duplicate it. The prior deliberately interrupted full attempt was api-full-r1, not this final run.

## Active checkpoint — 04:07 Asia/Tashkent

- Frozen first package HEAD0466aca29e9090e046e8affdf93760c9224144bd; complete API suite began22:45:11UTC on own audit_parent with4workers. Session13377, raw api-full-local-final.log and exit.txt remain authoritative; no terminal result yet. Application source/tests/dependencies in this worktree remain frozen.
- A second owned worktree D:/PublicWorktrees-20261021/night-audit-20261024-phase2 (branch codex/night-audit-20261024-phase2) starts at0466aca. It has independent real node_modules: npm ci, prisma:generate and build:shared exited0. Never run dependency updates through the first worktree's junction.
- Readonly second-pass reports NEXT-JOBS-READONLY.md and NEXT-FIELDS-READONLY.md document5 confirmed families: cleanup deletes a resumed upload, explicit unsupported import currency becomes TJS, downloaded property template misses required windows, quoted CSV delimiter detection fails, recruitment form limits exceed API boundaries. Generated1004 failing inputs are variants, not1004bugs. Phase2 specialists own upload, CSV/import, and recruitment boundaries respectively. New audit_upload_phase2 DB is isolated on the same own loopback15439 container.
- Upload cleanup has a new actual HTTP/PG/disk RED regression; import19cases and recruitment component/browser/API checks are underway. No phase2 final-green or full-suite claim yet.
- One security subagent stopped with a protective cyber filter. Its unfinished NEXT-API-READONLY findings remain unverified; do not retry the blocked exploitation task or promote it to coverage.
- Lockfile advisory scan (npm audit --omit=dev) found12 affected package entries:1critical/8high/3moderate. This is advisory/version evidence, not12 CRM exploit reproductions. See DEPENDENCIES.md. The skill collector is running separately; metadata coverage and unavailable data must remain explicit. No dependency updates yet.
- Normal git ls-remote succeeded again at~04:03. Earlier preconnect failures remain retained. No push/PR/cloud run yet; publication may resume after review. No merge/ship/deploy authorized.

## Phase2 package checkpoint — after dependency update

All5 phase2 families have targeted GREEN evidence before dependency updates: import36tests/6files, upload49/6files, recruitment75web/3files+14realAPI+6Chrome. Reports and independent import review live in phase2 docs/audit-20261024. Upload was narrowed after parent review to cleanup-only row revalidation; broad streaming/route changes were discarded. The120second filesystem/transaction residual is explicit.

Phase2 dependencies were then updated in its OWN real node_modules using the reviewed normal semver-compatible audit plan, no --force. Update exit0 (4added/8removed/42changed); Prisma generation7.10.1 exit0; independent npm audit JSON exit0 with0reported advisories. PHASE2-DEPENDENCIES.md records versions and scope. A post-update map/precheck and targeted API compatibility group are running. Earlier targeted greens do not prove the updated dependency tree.

The frozen first full API run has at least one failing test and one skipped legacy-file setup; no green suite claim. FULL-SUITE-TRIAGE.md separates observed log output from fixture hypotheses (missing real Response.clone and missing owned eligible agent). Wait for terminal diagnostics, reproduce on a fresh own DB and correct fixture isolation only if confirmed. Never delete unattributed UNKNOWN/ADMITTED attempts or weaken application policy to make tests green.

Additional readonly specialists are inspecting task/reminder date/state behavior and settings failed-save drafts. These are new pending areas; no additional bugs or fixes have been accepted yet.

## Complete first run and publication checkpoint

The first full API run completed native1 after1911.3seconds:1482files,13985tests =13934passed+2failed+46skipped+3TODO, three failing physical files including one setup failure. Exact diagnosis/evidence: FULL-API-FIRST-PACKAGE.md and FULL-SUITE-TRIAGE.md. Original shards copied from the runner temp directory to the own ignored evidence folder. Main source freeze may now end; no old-green claim is permitted.

Ordinary push of0466aca succeeded and draft PR45 was created and attached: https://github.com/DalerJaborov/royal-home-crm-public/pull/45. Its description explicitly reports the failed full run and next-batch pending state. No merge/ship/deploy. Phase2 source is not in this PR head yet.

Two further application families confirmed: assistant task rescheduling selects cancelled showing history (real runTool/PG RED2fail6controls→25PASS in4files after minimal TASK_WHERE fix), and actual CompanySection failed-save rollback loses its draft in Chrome1440/390 (2RED,4canonical/newer-edit controlsPASS). Task fix is ready in phase2; settings provenance fix remains active. Reminder-repeat and date-only deadline observations are NOT accepted policy changes.

Phase2 precheck built shared/API/web and passed frontend tests/other executed checks but exited1 at audit:mocks due two new incomplete test mocks; both mocks were corrected preserving exports and guard rerun0, new upload5cases passed under updated dependencies. Final consolidated precheck must follow all active changes. Post-update compatibility evidence:15files110PASS plus3files12PASS; mammoth issue does not reproduce in fresh install.

## Active runtime moves to phase2 for final validation

All three specialists released their source/tests. Phase2 now contains7 additional confirmed application families (CSV/import3, upload1, recruitment limits1, live task selection1, settings draft rollback1), compatible advisory updates and2 fixture-only isolation repairs. Settings actual Chrome8/8, unit14/14, typecheck/lint0; task25/4files; fixture129distinctcases plus71foreign-preservation controls are green. Independent import/async and parent settings reviews are complete with documented limits.

Use **D:/PublicWorktrees-20261021/night-audit-20261024-phase2** as the active runtime from here; it owns its real fresh dependency install. This original worktree retains the first frozen source/dependency evidence and must not run npm install through its primary-node_modules junction. The original public source and other databases remain preserved. Read phase2 docs/audit-20261024/STATUS.md after its packaging checkpoint; final source pin/map/precheck/cloudfull and PR45 update are still pending. The parent will publish the final own branch head to the existing remote codex/night-audit-20261024 without merging the PR or deploying.

## Final phase2 source freeze

This phase2 copy is now the active runtime. Seven new families, dependency updates and fixture repairs are committed locally, rebased only on the own first-package documentation commits; no public/private foreign history was rewritten. Source application commit1b1178c and fixture-ending cleanup204479e follow dependency94e418d. Final map generation exited0. The complete working tree was clean before this documentation checkpoint.

Next: commit this index/checkpoint, record actual full40-character HEAD/tree in ignored evidence, run final consolidated precheck and eight-role local smoke, then publish to existing remote codex/night-audit-20261024/PR45 and dispatch test-only ship-tests for that exact head. No source/test/dependency edits while those checks run. Reports may update without converting partial output into a verdict. No merge/ship/deploy.
