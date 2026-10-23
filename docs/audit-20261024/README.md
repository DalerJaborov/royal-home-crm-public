# CRM audit — first remediation batch, 24 October 2026

This is a review-ready source package from public baseline `87aecdb`, not a production release. Fourteen confirmed defect families were repaired; this does not establish that every source file, role or workflow is free of bugs. The next audit pass must continue the explicitly pending scope in COVERAGE.md/STATUS.md.

## Findings

| Group | Confirmed defect families | Evidence |
| --- | --- | --- |
| Business rules (7) | Missing payment-time exchange rate; premature plan rate; inconsistent paid accounting month; missing recurring auto-pay rate; impossible forecast months; stale reservation expiry; commission recalculated from previous sold price | BUSINESS.md; isolated real PostgreSQL and HTTP regressions |
| API/privacy (3) | Bulk candidate mutation racing live-call claims; deleting a file retained by another portfolio; live audio surviving account/permission revocation | API-ROLES.md; isolated PostgreSQL contention, real files and HTTP streams |
| Frontend (3) | Lost write response described as a definite failure; pending deal form can dismiss; repeated load-more can skip a page | FRONTEND.md; mocked transport plus actual components/hooks in Chrome at desktop and 390px |
| Test tooling (1) | Public-worktree stand pulls dependencies from archived private checkout | agent-stand primary-root regression; 14 Node tests passed |

No schema migration or dependency version was changed. The central stream-close API remains the revocation authority; the new registry avoids introducing a dependency cycle. Bulk application locks use stable ID order, matching the single-item call-claim authority. Reservation expiry now matches the scanned reservation under its row lock. Money fixes preserve explicit rates, historical null dates and existing cents rounding.

## Consolidated checks completed locally

- `npm run precheck -- --no-tests`: exit 0. Builds shared/API/web, ESLint, **304 frontend test files / 1,867 tests**, dependency/theme/nginx/type/mocks/secret guards, current product map, removal gate, journal gate, and release-tool tests. Full command output is retained locally in `reports/night-audit-20261024/precheck-r1.log`.
- Release/infrastructure script summary inside precheck: 136 total, 104 passed, 32 platform/conditional skips, 0 failures. The skips are not counted as tested behavior.
- Stand-root regression: **14/14**, original failure and patched success retained in stand-red/stand-green logs.
- API specialist final recovery: **77 tests in 10 distinct files**, no failures. Earlier overlapping runs are not added to this count.
- Business checks: **71 tests / 8 files**, then **42 tests / 9 files** covering adjacent deal/reservation/payment behavior. These groups overlap and are not a unique combined count.
- Frontend focused checks: **66 tests / 6 files**, plus **8 Chrome component-fixture tests**. Original raw frontend browser failure logs were not recovered; that baseline evidence gap is explicitly retained.
- Genuine code-login, real local HTTP and PostgreSQL, desktop/mobile navigation: the seven original roles passed; the additional SHAREHOLDER passed and rejected an attempted financial write. The final eight-role spec has a tightened finance-permission assertion; its consolidated rerun is pending at this checkpoint.
- `git diff --check` and the final secret scan passed.

The local complete API attempt was intentionally interrupted before any shard test result, after confirming the documented long laptop runtime. It is neither a completed test failure nor a successful full suite. The exact-commit GitHub test-only workflow remains pending. A PR/check result is not evidence of deployment.

## Coverage interpretation

The baseline machine inventory records **1,958 source files**, **1,805 existing test files**, 68 screen-route definitions (including route wrappers/redirects), 78 API mounts, 104 scheduler entries, 23 job entries and 13 external-service groups. The generated human map groups these differently; counts are inventories, not percentages tested. Generated product flow/map files were rebuilt from the code, never hand-edited.

Named paths and regression groups above have evidence. Every other source file, scheduler, endpoint, field combination and role combination remains individually pending unless the specialist report states otherwise. Tests that pass with mocks do not establish external-provider behavior. Runtime checks use only the audit's own container/database and synthetic fixture records. Production, physical iOS/Android, provider delivery, paid model quality and multi-process stream revocation are unverified.

## Remaining work

1. Pin the review-ready commit and run the consolidated API workflow without ship/merge/deploy.
2. Recover independent baseline-versus-patched frontend proof in a separate validation worktree.
3. Continue across pending security/input/upload/settings/task/job scenarios, including failure recovery and variant searches using the installed audit skills.
4. At the overnight deadline publish the exact results, unresolved findings and coverage limits; never call this an exhaustive proof of zero bugs.
