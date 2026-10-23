# CRM overnight audit package, 24 October 2026

This source package starts at public baseline `87aecdb`. It contains21 confirmed defect families across application behavior and test-stand routing (14first-package families plus7phase2 families), compatible dependency advisory updates and2 separately attributed fixture-isolation repairs. Final consolidated validation is pending; no production release or exhaustive zero-bug claim is made. Continue the explicitly pending scope in COVERAGE.md/STATUS.md.

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

Final map was generated from source; application source/tests are now frozen for consolidated precheck, real local role smoke and a test-only exact-head GitHub API run. Their terminal results remain pending.

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
