# CRM overnight audit package, 24 October 2026

This source package starts at public baseline `87aecdb`. The FINAL source addresses28confirmed defect families across application behavior and test-stand routing (14first-package,7phase2,3third-batch,1client-radius,2ordinary user-flow and1absence-return family), compatible dependency advisory updates and4separately attributed fixture/test-oracle repairs. Targeted user-flow regressions and independent reviews are complete; the latest frozen-package consolidated verdict remains pending. No production release or exhaustive zero-bug claim is made. Continue the explicitly pending scope in COVERAGE.md/STATUS.md.

## Findings

| Group | Confirmed defect families | Evidence |
| --- | --- | --- |
| Business rules (7) | Missing payment-time exchange rate; premature plan rate; inconsistent paid accounting month; missing recurring auto-pay rate; impossible forecast months; stale reservation expiry; commission recalculated from previous sold price | BUSINESS.md; isolated real PostgreSQL and HTTP regressions |
| API/privacy (3) | Bulk candidate mutation racing live-call claims; deleting a file retained by another portfolio; live audio surviving account/permission revocation | API-ROLES.md; isolated PostgreSQL contention, real files and HTTP streams |
| Frontend (3) | Lost write response described as a definite failure; pending deal form can dismiss; repeated load-more can skip a page | FRONTEND.md; mocked transport plus actual components/hooks in Chrome at desktop and 390px |
| Test tooling (1) | Public-worktree stand pulls dependencies from archived private checkout | agent-stand primary-root regression; 14 Node tests passed |

No schema migration was added. Phase2 updates compatible dependency versions and preserves Prisma/client/adapter alignment. The central stream-close API remains the revocation authority; the new registry avoids introducing a dependency cycle. Bulk application locks use stable ID order, matching the single-item call-claim authority. Reservation expiry now matches the scanned reservation under its row lock. Money fixes preserve explicit rates, historical null dates and existing cents rounding.

## Phase2 findings and focused evidence

| Family | Result | Evidence |
| --- | --- | --- |
| CSV/import contracts (3) | Unsupported explicit currencies reject instead of becoming TJS; property template includes required windows; delimiter detection ignores quoted separators/logical newlines | PHASE2-IMPORT.md; RED10fail/9controls →36PASS; independent review |
| Resumed video cleanup (1) | Recheck current expiry under the session row lock before deleting acknowledged parts; disk failure keeps retry metadata | PHASE2-UPLOAD.md; actual HTTP/PG/disk49PASS; updated-mock5PASS; independent async review |
| Recruitment text limits (1) | Existing2000note/500reason limits shared across API/forms, local rejection retains drafts | PHASE2-FIELDS.md;75web/14realAPI/6Chrome |
| Live task selection (1) | Cancelled showing history is excluded from assistant rescheduling | PHASE2-TASKS.md; real runTool/PG RED2fail/6controls →25PASS/4files |
| Settings failed-save drafts (1) | Cache provenance preserves edited fields through rollback while untouched optimistic fields revert; canonical responses/newer edits remain correct | PHASE2-SETTINGS.md;14unit and8Chrome, typecheck/lint0 |

Dependency update/independent npm audit returned0 reported advisories; see PHASE2-DEPENDENCIES.md for exact versions and interpretation. This is advisory-source evidence only. Post-update API compatibility groups passed110tests/15files and12tests/3files; Chrome component groups8forms+6recruitment passed. Groups may overlap and are not added into a unique coverage count.

The2 fixture-only repairs preserve strict application policies: real Response.clone semantics plus owned physical-attempt cleanup, and an owned eligible receiving agent for a positive assignment case. The final three-file group passed129distinct cases; an extra71-case run preserved all29foreign synthetic UNKNOWN witnesses unchanged. See PHASE2-FIXTURE-ISOLATION.md.

Exact3305 local precheck completed successfully:305webfiles/1877tests, shared/API/web builds and executed guards;104script passes and32conditional/platform skips. Its actual code-login/PG/browser smoke passed8roles with80route/viewport visits. GitHub run40040133970 failed before API workers started because two stand tests used Windows cmd/mklink on Linux. The nativefs correction passes Windows14/14; actual Linux confirmation is pending the next source-plan. That run supplies no full API verdict. Source freeze was reopened for the third bounded batch; see CI-LINUX-STAND.md.

## Third bounded batch

| Family | Result and evidence |
| --- | --- |
| Assistant-audit dates (1) | Reuse existing inclusive Dushanbe day bounds; real HTTP/PG3RED+8controls becomes28PASS/3files. PHASE2-AUDIT-FILTERS.md |
| Reports/ads calendar validation (1) | Reject impossible days/months and reversed effective periods, retaining Date/ISO/default/range semantics. RED22fail/8controls; final33new cases and unchanged adjacent controls pass. PHASE2-REPORT-PERIODS.md |
| Property/automatic seller atomicity (1) | Draft conflict, duplicate refusal and failed property insertion previously retained a newly accepted seller. The minimal shared transaction passes10actual HTTP/PG cases, including real phone uniqueness contention and initial event preservation;7adjacent files/63tests and independent review passed. PHASE2-PROPERTY-SELLER-ATOMIC.md; REVIEW-PROPERTY-ATOMICITY.md |

The parent and a second specialist independently reviewed the two period corrections; see REVIEW-PERIOD-FIXES.md. NR01 loss-cohort semantics and ambiguous reminder/deadline choices remain OPEN-POLICY-QUESTIONS.md. No silent metric, reminder or ownership-policy change was made.

Independent dependency follow-up corrected one remaining low build-time serialize-javascript advisory using a normal7.1.4 update. Collector r2 has0matching known advisories in1129registry-verified transitive entries,5unverifiable entries and narrower3root-tooling maintainer coverage. This is not proof that dependencies have no vulnerabilities; see PHASE2-DEPENDENCIES.md.

## Final client/oracle batch

Client radius CF01 is corrected with one input attribute: native Next now accepts the same integer-meter values100..10000 already preserved/submitted by the form and admitted by the API. No rounding/default/settings change. Actual Chrome at1440/390: the identical durable14case set goes4RED+10controls→14PASS;12retained writes preserve values with0native-invalid events. App and browser-fixture TypeScript and targeted ESLint pass. FINAL-CLIENT-RADIUS.md and REVIEW-FINAL-CLIENT-DM.md separate source, synthetic-transport browser and unexecuted production layers.

The exact5616 full cloud run completed RED: **1489physical files/14074tests=14070PASS+1FAIL+0SKIP+3TODO**, with all20machine reports retained and independently re-merged/file-discovery checked. The only failing case falsely rejected992 in an allowed PUBLIC district UUID. A stricter independent whole-response test oracle now covers public district/shortId992 and excludes actual private fixture fields, retaining the original residual guard and unchanged application/helper. Targeted33cases passed; after parent caught a retry-fixture uniqueness issue, the corrected16case file and a two-preparation own-PG control passed separately. See FULL-API-5616.md and FINAL-DM-PUBLIC-ORACLE.md. No complete green API verdict is claimed yet.

That full run also rescued one schedule case using the repository's existing CI retry1. Its exact first failure was recovered from JSON: the second GLOBAL tick returned1 instead of0. A controlled two-client fixture reproduces the invalid global-count assumption; the repaired single case checks its actual own showing IDs, weekly limit and exactly one own originate. The durable44case file passed without retry; a later nullable-only assertion access is explicitly left for the complete suite. No scheduling-policy/application change. FINAL-SCHEDULE-FIXTURE.md and REVIEW-FINAL-SCHEDULE.md separate this fourth fixture repair from production bugs. The independent exact5616 source CI and offline API image passed; these historical results do not prove the later FINAL head.

The readonly hiring pass executed actual admin/manager catalogue close/edit/reopen, optimistic revision rollback and ordinary candidate transitions on own PostgreSQL with0external calls; no new defect was confirmed. Its precise positive coverage and untested UI/concurrency choices are recorded in NEXT-VACANCY-READONLY.md. Rejected money-input and other source-only suspicions are not counted as bugs.

## Ordinary user-flow followup

NFL01 expense deletion: an actual own-PostgreSQL HTTP sequence confirms that a table opening amount100/version0 can archive a subsequent correction250/version1 when the caller drops version; the same existing API with version0 correctly rejects409. Normal archive/restore preserves business fields and paid-pivot inclusion. The table now passes its captured confirmation version through the existing hook. Actual mounted table/hooks/Chrome at1440/390:2normative RED+4controls becomes6PASS, including stale-query preservation, fresh version0 delete/functional undo and read-only controls. Existing3unit tests and explicit browser-fixture TypeScript pass. The separately confirmed active ExpensesWorkspace caller has the same omission; its captured-version/compatible-hook correction passes identical6browser cases and3hook compatibility cases plus adjacent controls (15tests/3files), not another family. See FINAL-EXPENSE-TABLE-ARCHIVE.md and NEXT-EXPENSE-ARCHIVE-VARIANT-READONLY.md.

TU01 calendar completion: the ordinary AGENT path previously retained a failed task without showing any completion error. The existing shared mutation-error block now renders the real completion error and a dismiss action. Actual Calendar/hooks/Chrome1440/390:2normative missing-alert failures plus4controls becomes6PASS, checking acknowledgment retains the task without a request and an intentional successful retry refetches it away. Showing-edit rejection retains its draft. Independent review caught a newly added regression-harness date dependency; a test-only browser clock pin and exact final6PASS/native0 rerun correct it. No API/task/score/pending policy change. FINAL-CALENDAR-COMPLETE-ERROR.md separates fixture clock durability from CRM findings.

Exact13a9219 consolidated precheck passed305webfiles/1877tests, builds/all executed guards and104scriptPASS/32conditionalSKIP. It was not pushed or sent to the full workflow because the two later confirmed user-flow corrections were still being integrated. Final checks must name the later committed source, not carry13a9219 acceptance forward.

## Absence-return followup (TA01)

The actual scheduled helper could clear absence metadata and advance inactive-client clocks after an employee was deactivated between candidate selection and the transaction. Its explicit existing contract gives isActivefalse precedence over any due date. One added isActive:true predicate repeats that authority at the actual update. It does not reactivate an account or change absence/deadline/auth policies. Actual own-PostgreSQL baseline1RED+5controls shows returned1, cleared absence and an eight-day wrong client-clock shift; final scoped6PASS retains all fields/clocks, returned0 and zero mocked return effects. Exact deadline/idempotency/indefinite/already-inactive/future-extension controls remain. An owned unrelated due witness is unchanged. TypeScript/mocks guard pass, and independent review approved exact released bytes. FINAL-TEAM-ABSENCE-RETURN.md and REVIEW-TEAM-ABSENCE-RETURN.md disclose test-isolation corrections and the extra adjacent registration-only cron imports; these are not further original CRM bugs.

This fix lives in a separate PUBLIC FINAL2 worktree with its own dependencies from4897, preserving that immutable source/full-run evidence. The new complete API check must name the later committed source; the old4897 run does not test TA01. BUG-REGISTER now has28families and the evidence index21named groups, including this narrowly confirmed followup and ordinary Profile positive controls. The index distinguishes the4897map snapshot from later per-group file pins; pending modules retain explicit limits.

## First-package checks completed locally

- `npm run precheck -- --no-tests`: exit 0. Builds shared/API/web, ESLint, **304 frontend test files / 1,867 tests**, dependency/theme/nginx/type/mocks/secret guards, current product map, removal gate, journal gate, and release-tool tests. Full command output is retained locally in `reports/night-audit-20261024/precheck-r1.log`.
- Release/infrastructure script summary inside precheck: 136 total, 104 passed, 32 platform/conditional skips, 0 failures. The skips are not counted as tested behavior.
- Stand-root regression: **14/14**, original failure and patched success retained in stand-red/stand-green logs.
- API specialist final recovery: **77 tests in 10 distinct files**, no failures. Earlier overlapping runs are not added to this count.
- Business checks: **71 tests / 8 files**, then **42 tests / 9 files** covering adjacent deal/reservation/payment behavior. These groups overlap and are not a unique combined count.
- Frontend focused checks: **66 tests / 6 files**, plus **8 Chrome component-fixture tests**. Independent pinned-baseline execution subsequently recovered the failure evidence: original code fails five API-copy assertions and six Chrome cases while its controls pass; the patch passes the identical checks. Two additional direct probes reproduce Escape dismissal and skipped editor rows. See FRONTEND-BASELINE.md.
- Genuine code-login, real local HTTP and PostgreSQL, desktop/mobile navigation: the final eight-role spec passed **8/8** on commit b20bc69, including exact finance access versus effective permissions, invalid-token rejection and SHAREHOLDER financial-write rejection. It visits five routes at each of two widths per role (80 route/viewport visits); these are automated smoke checks, not 80 visual or full-workflow approvals. Raw output: live-browser-final.log, exit 0.
- `git diff --check` and the final secret scan passed.

A later complete API run on corrected0466aca finished with native exit1:1482files and13985tests, of which13934passed,2failed,46skipped and3TODO. Three files failed, including a setup failure. Fixture contamination, a missing fixture agent and the reused install's missing mammoth package are diagnosed in FULL-API-FIRST-PACKAGE.md. The earlier deliberately interrupted attempt remains separate. No complete-API green verdict is claimed. Draft PR45 exists; a PR/check result is not evidence of deployment.

## Coverage interpretation

The baseline machine inventory records **1,958 source files**, **1,805 existing test files**, 68 screen-route definitions (including route wrappers/redirects), 78 API mounts, 104 scheduler entries, 23 job entries and 13 external-service groups. The generated human map groups these differently; counts are inventories, not percentages tested. Generated product flow/map files were rebuilt from the code, never hand-edited.

Named paths and regression groups above have evidence. Every other source file, scheduler, endpoint, field combination and role combination remains individually pending unless the specialist report states otherwise. Tests that pass with mocks do not establish external-provider behavior. Runtime checks use only the audit's own container/database and synthetic fixture records. Production, physical iOS/Android, provider delivery, paid model quality and multi-process stream revocation are unverified.

## Remaining work

1. Independent review correction completed: the added reservation row lock introduced two lock-order cycles with stage PATCH. The stage transaction now locks Property before Deal. The final five-file / 28-test PostgreSQL run, API typecheck and regenerated map check pass. Original b20bc69 is retained as review evidence. Actual87 baseline has stale renewal/stage state errors without those deadlocks; REVIEW-BUSINESS.md separates the observations. This correction is not counted as another original CRM defect.
2. Obtain final consolidated precheck/API verdict on the frozen phase2 source, then update draft PR45 and this index with exact evidence. Ordinary GitHub connectivity recovered; no network/security setting was changed.
3. Continue across pending security/input/upload/settings/task/job scenarios, including failure recovery and variant searches using the installed audit skills.
4. At the overnight deadline publish the exact results, unresolved findings and coverage limits; never call this an exhaustive proof of zero bugs.
