# CRM overnight audit — 24 October 2026

Deadline: 08:00 Asia/Tashkent, 24 October 2026. Heartbeat `crm-08-00-24` continues this chat every 30 minutes until the deadline, then pauses itself. Execution requires the desktop app/host to remain available.

**Active NEW-source runtime:** `D:/PublicWorktrees-20261021/night-audit-20261024-final`, local branch `codex/night-audit-20261024-final`, OWN fresh dependencies. Phase2 remains frozen at5616 for its still-active cloud run and retains its raw evidence/watcher. Publish the final checkout's later reviewed HEAD explicitly to remote `codex/night-audit-20261024` for existing draft PR45; the original local branch stays behind as first-run evidence. The checkpoints below are chronological history; the final section is authoritative. Never install through the original worktree's primary node_modules junction.

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

## Source3305 validation result and next bounded package

Exact3305fdc7dfcbde3a7d79e7ea8b00c8650de92a1c/treee402abc84627e4a8aa1c2968773b11e9a6b6c081 was pushed to existing PR45. Local final precheck native0:305webfiles/1877tests, builds/guards/map/scripts passed (conditional/platform skips remain separate). Final real code-login/PG/browser8roles passed8/8 and80route/viewport visits. Generated postpatch CSV1000unchanged properties and8current UI/API boundary/draft controls passed. No exhaustive UI/provider acceptance is claimed.

Cloud40040133970 ended FAILURE at source-plan: Linux cmd/mklink missing in2stand tests; API jobs never started. CI-LINUX-STAND.md attributes this introduced CI problem and the nativefs fix; Windows14passed after correction, Linux verification pending. Sourcefreeze is now OPEN for the next bounded fixes. Never call this a completed green/red full API run.

Independent dependency collector after npm audit0 still reported1low build-time serialize-javascript7.0.7 advisory (GHSA-m5mm-p8h7-m29v),5unverified entries among1129registry-verified transitive entries. Primary advisory confirms fixed floor7.1.3 and attacker-controlled serialized function source precondition; no CRM exploit was executed/found. Normal named package update changed exactly1package to7.1.4 with native0. No override/runtime dependency changed. A new collector/build must confirm the updated state.

Active ownership after all previous scopes released: parent owns stand nativefs and build-only serialize update; finish_frontend owns confirmed assistant-audit Dushanbe filter fix (realHTTP/PG3RED8controls→28PASS in3files; typecheck/report finishing); finish_business owns confirmed invalid reports/ads month/date/range validation after minimal local-only plan approval and durableRED; upload_cleanup is completing bounded readonly lifecycle probes. Global shared schemas and losses-cohort formula remain unchanged. All tests use own fresh databases/fixtures; no production/provider/paid-generation operations.

Do not start the next complete API run until these sources are reviewed, committed and frozen. Original first full0466 run remains failed;3305cloud has no API verdict. The next ordinary test-only workflow should validate the corrected Linux plan and then run the API suite once on its new exact head.

## Third batch ready for consolidated validation — 05:00 Asia/Tashkent

All application/test/dependency writers have released their scopes. The package now contains24confirmed defect families, including3third-batch additions: AF01 assistant-audit inclusive Dushanbe bounds (28PASS/3files), NR02 report-period validation (final33new cases plus adjacent controls) and property/automatic seller partial-write atomicity (new10actual HTTP/PG cases;7adjacent files/63tests). Parent and independent specialist reviews found no introduced blockers in the actual diffs. Exact reproductions, root causes, fixes, regressions and limits are in their named PHASE2 reports and REVIEW-PERIOD-FIXES/REVIEW-PROPERTY-ATOMICITY.

Native map generation completed0 after all application changes. The nativefs stand correction has Windows14/14, and serialize-javascript7.1.4 collector r2 completed with0matching known advisories among1129registry-verified transitive entries,5unverifiable; broader maintainer coverage remains only3root tools. NR01 loss-flow/cohort metric and reminder/deadline policy remain unchanged and documented in OPEN-POLICY-QUESTIONS.md.

Freeze application source/tests/dependencies now for a review-ready commit, consolidated local precheck, then explicit push HEAD to existing remote codex/night-audit-20261024 and draft PR45. Dispatch ONE ordinary test-only ship-tests workflow for that exact new head,20machines/3workers; no npm run ship or deployment. Previous3305 cloud failed before any API worker, so it is not a completed API run. Capture its actual Linux plan, all20machine reports, official aggregate/native verdict and exact SHA; no partial green claim. Raw logs/pins remain ignored under reports/night-audit-20261024. All own DB clones and old evidence remain preserved. No production/provider/paid actions occurred.

## Active cloud run — 05:02 Asia/Tashkent

Committed third-batch source6fe52d6 followed by report-ending-only5616f8e. Exact frozen/pushed HEAD **5616f8e3e886c500d0eeebf5edda924757620a2d**, tree **c3c195542a4b5bea2d38c6f651d064a694b9b1c0**. Working tree was clean; secret hook and final whitespace check passed. The local consolidated precheck on this exact head finished native0 in2m49s:305webfiles/1877tests, shared/API/web builds, ESLint and all executed guards;136scripts=104PASS+32conditional/platformSKIP+0FAIL. API intentionally excluded from this precheck, not silently counted as passed.

Fast-forward push HEAD→remote codex/night-audit-20261024 succeeded. Existing draft PR45 was updated, stays OPEN/DRAFT/head5616. Ordinary test-only workflow **40042873456** was dispatched once at00:01:43UTC for exact5616,20machines/3workers: https://github.com/DalerJaborov/royal-home-crm-public/actions/runs/40042873456 . Initial snapshot at00:01:51UTC has plan IN_PROGRESS; no API verdict yet. PR Source checks also run independently, with no deployment. Do not dispatch a duplicate while this run is active.

Pins/logs: batch3-source-pin.json, batch3-precheck.log/.exit.txt, batch3-cloud-first.json and pr-body-batch3.md under ignored reports/night-audit-20261024. Keep application source/tests/dependencies frozen; reports may update. Next inspect terminal plan before API evidence, then download official api-tests-total (and all20machine artifacts), verify SHA/sourceChecks plus complete terminal assertion accounting with repository verdict helpers. Existing CI retry1 must be disclosed if it actually rescues cases. A prior failed or skipped matrix is never a green complete-suite result.

At~00:06UTC the exact5616 Linux source-plan is completed SUCCESS, including both precheck and test:scripts steps; the cmd/mklink blocker is resolved on actual Linux. All20matrix jobs were created (the captured snapshot had19inprogress/1queued); no terminal full verdict yet. `gh run view --job ... --log` cannot fetch even a completed job while the parent run is active in this CLI/backend; defer logs until terminal, do not mislabel that retrieval failure as a test failure. Read-only `gh run watch` is active in local exec session97072, interval45s, raw batch3-cloud-watch.log/.exit.txt. Resume that session if available, otherwise inspect its exit file and GitHub run before starting any watcher, never duplicate the workflow.

Exact local API file discovery (`vitest list --filesOnly --json`, no test execution) returned1489physical files, native0; retained batch3-api-discovery.json/.log/.exit.txt. Compare normalized file paths with the eventual aggregate, not Vitest nested-suite block counts. A bounded readonly specialist is probing ordinary client forms with ignored actual-component/contract fixtures; no app/default-test/dependency changes are authorized under this freeze. Any candidate must be independently confirmed before a later batch. Main report target NEXT-CLIENT-FORMS-READONLY.md.

At~00:11UTC source CI40042861567/precheck also completed SUCCESS on exact5616; PR45 remains OPEN/DRAFT/head5616. Full40042873456 has a FAILED completed machine17 while other jobs are still active, so no green full verdict. Downloaded that completed machine's artifact once to batch3-red-machine-17:715tests=714PASS+1FAIL, native1. Failed file customer-dm-attachment-postgres.test.ts, recognized shared publication case: the broad forbidden-substring regex matched the rendered reply on both existing CI attempts. The exact received match is truncated in the JSON, so the cause is NOT yet established. A hypothesis is harmless public district fixture labels containing randomUUID substring992; upload_cleanup owns a deterministic own-PG CONTROL/REPRO using unchanged actual pipeline and synthetic provider transport in NEW audit_dm_fixture. No guard/app/test change authorized yet. Wait terminal full, retain official aggregate/all20reports and logs, then diagnose before any next source changes or retry.

The readonly client-form pass rejected its initial money-step hypothesis after actual Chrome controls. It did reproduce a different same-form contradiction at1440/390: a valid new-place radius1250 from settings is blocked by native Next(step100), but normal review-step submission saves that exact1250 and shared schemas admit it. Source contract/actual browser evidence and minimal plan are being finalized for parent review; no fix accepted into5616. A separate readonly hiring-lifecycle pass has successful scoped own-PG controls and no confirmed new defect so far; report pending. These new passes do not change the frozen source or full-run attribution.

## Independent final-source lease — 05:20 Asia/Tashkent

The cloud run40042873456 is still checking immutable5616. All completed API machines except17 are green; machine6 remains in ffmpeg installation since00:04:55UTC and has NOT started dependency/migration/API steps. Its existing job timeout is45minutes. Do not cancel/duplicate or call it complete. Its watcher session97072 and all batch3 raw evidence stay in the PHASE2 directory. PR source CI40042861567 independently passed; root verified its exact-head receipt and offline API image artifact (Prisma7.10.1, networknone, mountsempty, imageea7ec317...), native verifier0. This is build/image evidence, not production verification.

The completed failed machine17's official job-log API was available despite gh run view's overall-run limitation. Full received at batch3-machine17-job.log3928–3936 identifies992 inside a PUBLIC district UUID segment9922, not a private field. An own-PG unchanged-pipeline probe deterministically reproduces public label992 FAIL versus alpha PASS, with0model calls. Root and independent specialist selected a stricter fixture-only oracle correction (planB), rather than alphabetizing/masking random public fixture labels. Exact three allowed lines must be built independently from known raw public fixture values; full equality plus original regex on residual exact-public-line removal forbids any additional private output. Actual private ownerContact/address absence and public district/shortId992 controls are required. No application privacy/transport guard or shared fixture helper change is authorized.

To preserve that pending5616 evidence while making progress, root created a separate PUBLIC worktree **D:/PublicWorktrees-20261021/night-audit-20261024-final**, branch **codex/night-audit-20261024-final**, exactly from5616. It has its OWN real node_modules: npmci native0/1048packages, build:shared0 and prisma:generate7.10.1native0, no lockfile change. Source/root instructions and WORKSPACES were read; no archived/private source or foreign checkout was used. Do not install or edit phase2 dependencies/source.

Active scoped writers in FINAL only: finish_frontend owns confirmed CF01 native radius constraint (normative durable14case Chrome RED before one-attribute step100→1 fix; min/max/int/defaults/settings/data preserved). upload_cleanup owns only the DM attachment test oracle planB plus deterministic real-PG/public-number and pure rejection controls. Both received READY; no full-suite/map/dependency/commit work delegated. Root owns independent review, docs/maps/commit/precheck/publication and later exact new-head complete API validation. New source is not in PR45 yet. The public remote branch remains5616 until a reviewed bounded package is ready.

Named readonly hiring-lifecycle HTTP/PG controls completed0 in own audit_vacancy with0provider/config/communication activity and exact owned cleanup; no new functional defect. MAIN NEXT-VACANCY-READONLY.md records remaining UI/concurrency/policy limits. MAIN NEXT-CLIENT-FORMS-READONLY.md has CF01 actual-browser/schema evidence and rejected money hypothesis; NEXT-DM-FIXTURE-READONLY.md has exact fixture attribution and superseded unimplemented planA. Parent should review/copy these sanitized reports into FINAL after the scoped corrections, preserving raw evidence in phase2. All existing database clones, sources and logs remain retained.

## FINAL package freeze — 05:40 Asia/Tashkent

All three scoped writers released source/tests/dependencies. FINAL now adds the25th confirmed family, CF01client radius: one attribute step100→1; durable identical14case Chrome1440/390 run4RED+10controls→14PASS,0skip/flaky,12actual retained payloads/0invalid events, app/browser-fixture typecheck and lint0. Existing contract100..10000integer meters, defaults/bounds/MatchingTab/state/rounding unchanged. Source-only money suspicion was rejected and is not counted.

Two additional TEST-ONLY repairs bring the separate fixture/oracle total to4. DM public-facts oracle: independently built exact3lines, full original residual negative regex and actual private ownerContact/address absence, deterministic PUBLICdistrict/shortId992 variants. Parent caught introduced static-name uniqueness trouble on retry; owned UUID suffix and a two-preparation PG control fix it. New oracle33cases/3files passed, then corrected final16case file passed separately. The golden helper/application/guards are unchanged. Schedule weekly-limit oracle: exact first cloud failure was recovered from passed-case failureMessages (secondGLOBALtick1vs0). Clean30repeat control passed; controlled owned second-client baselineRED/scopedGREEN proves the global-counter mistake. One durable case now checks its own actual showing IDs/weekly_limit/exactone ownoriginate, cleans only captured competitor IDs,44cases pass withretry0; nullable-only access followup is separately recorded. No call/clock/application policy changes. Actual competing old-cloud row identity remains unknown.

Parent independently read both actual diffs, API/cloud artifacts, browser RED/GREEN stats/payloads, scheduler/wait helper and ownership cleanup. Reports FINAL-CLIENT-RADIUS, FINAL-DM-PUBLIC-ORACLE, FINAL-SCHEDULE-FIXTURE and REVIEW-FINAL-* record scope/limits. Sanitized readonly client/DM/hiring/schedule reports are copied into FINAL. Native map generation0 after all changes. No schema/dependency changes in this batch; OWN final fresh install remains independent.

The old5616 workflow **40042873456 completed FAILURE** at00:18:55UTC. All20machine reports present,19exit0/17exit1;1489physical files exactly match independent discovery;14074terminal assertions=14070PASS+1FAIL+0SKIP+3TODO. Slow machine6 eventuallypassed in14m05s. Root remergedall20reports byte-structure-equal to official aggregate and verifiedRED using normal acceptance helper; receipt batch3-red-complete-validation.json in PHASE2, native evidence-verifier0 means RED verified, NOT tests green. Aggregate SHA256139fb17a828931fc886361a1412d51396fa5f105a5d05ff977b4a144984ab5fb. One existingCIretry1 rescued the now-repaired schedule fixture; exact received public992falsepositive and actualretryassertion are retained. Watcher97072 ended native1; artifact/log download sessions31220/33995 ended0. No jobs remain active in that old run. Full report FULL-API-5616.md.

Next root stages/checks ALL new files for whitespace/secrets BEFORE commit, records exact newHEAD/tree, runs consolidated precheck, then explicitly pushes FINALHEAD to existing remote codex/night-audit-20261024/PR45 and requests ONE ordinary test-only20machine/3worker full API run for this new source. Never npm run ship/merge/deploy. Freeze application/defaulttests/dependencies through that run. New readonly native-number variant probes run only in stable PHASE2 on managed5212; new candidates require a later plan and must not edit this frozen source. Source/latestfull status remains pending until its actual terminal artifact is verified.
