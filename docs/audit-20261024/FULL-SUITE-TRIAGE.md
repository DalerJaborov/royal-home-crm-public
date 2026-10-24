# Frozen full-suite failure triage

Source under test: `0466aca`, main overnight-audit worktree. Initial triage was read only for source/tests/dependencies; subsequent explicitly coordinated reproductions below use fresh owned isolated databases and phase-2 dependencies. Main source/tests/dependencies and full-run worker databases were preserved. No production/provider activity.

## Final consolidated run

The original frozen run ended native exit 1 after 1911.3 seconds: 1482 files, 13985 declared tests; 13934 passed, 2 failed, 46 skipped, 3 todo. Three files failed (legacy setup failure, callback assertion, recruitment document import). These are actual terminal totals, not an all-green verdict. Shard 4's third file failed `recruitment-document-text.test.ts:10` with `Cannot find module 'mammoth'` at `recruitmentDocumentText.ts:49 require.resolve`. This is an installed-dependency gap in the original shared dependency tree; parent owns fresh-install verification separately. No application defect or passing verification is inferred from the declaration alone.

## Completed owned baseline reproductions

All following runs use phase-2 Prisma client/adapter/CLI 7.10.1 and Vitest 4.1.12, distinct from the frozen original tree. On fresh owned `audit_triage`, separate sequential processes established:

1. Initial physical-attempt count 0; unchanged legacy file native 0, 46/46 passed; post-count 0.
2. Unchanged `instagram-comments.test.ts` native 0, 71/71 passed, but post-count **29 blocking unattributed UNKNOWN** attempts (23 public comments + 6 DMs).
3. Unchanged legacy file then native 1, all 46 skipped, beforeAll expected 0 received **29**, reproducing the exact full-run count without any intervening social-video file.

Logs in phase-2 ignored `reports/night-audit-20261024/`: `triage-legacy-alone-baseline.log`, `triage-comments-before-legacy-baseline.log`, `triage-after-comments-baseline.json.log`, `triage-legacy-after-comments-baseline-red.log`. Old 29 synthetic witnesses are retained; no broad cleanup was performed.

Fresh separate owned `audit_callback_triage` reproduced unchanged callback file native 1, 11 passed / 1 failed: working=true expected assigned, received unassigned at line 270 (`triage-callback-baseline-red.log`). Parent then authorized only fixture corrections in phase 2, with strict legacy guard and application assignment policy unchanged. Followup results belong in `PHASE2-FIXTURE-ISOLATION.md`; the original full run remains red.

## Terminal update — shard 2

The actual shard-2 terminal section at log lines 12215–12242 confirms the suite hook failure: `customer-legacy-physical-postgres.test.ts:45`, foreign unattributed physical-attempt count **expected 0, received 29**. Thus all 46 cases were skipped because this precondition failed; they are not 46 failed business assertions. Shard 2 finished with 1 failed file / 370 passed files, 3510 passed tests / 46 skipped / 3 todo (3559 declared), duration 1593.77s. Its JSON report path is retained in the log. These are shard counts, not the final consolidated full-suite verdict.

Parent authorized the bounded unchanged-fixture reproduction recorded above, explicitly separate from the original run's dependency layer. The baseline sequence completed before fixture edits were authorized.

## Terminal update — shard 3

Actual log lines 12755–12786 confirm callback failure at test line 270: expected `intakeOutcome.mode = assigned`, received `unassigned`. This is the precise precondition-sensitive policy assertion identified above, not a test timeout or send/receipt failure. Shard 3 finished with 1 failed / 369 passed files; 1 failed / 3557 passed tests (3558), duration 1767.42s. Creating no owned receiving agent while requiring assignment is therefore a confirmed fixture precondition defect; the business service's no-recipient fallback remains correct and must not be broadened to force assignment.

## Owned baseline environment

The phase-2 reproduction uses Vitest **4.1.12** and Prisma **7.10.1**; original main full run uses Vitest **4.1.11**. This version difference is retained explicitly rather than treating the reproduction as the exact original dependency build.

1. Fresh audit_triage before tests: all physical witnesses 0, blocking unattributed witnesses 0.
2. Unchanged legacy file alone: `triage-legacy-alone-baseline.log`, native exit 0, **46/46 passed**, 16.74s. This establishes that its own beforeAll/fixtures are healthy without earlier-file contamination.
3. Unchanged comments file and a second distinct legacy process completed as recorded above; baseline source and fixtures were unchanged for all three processes.

## Observed execution evidence

`reports/night-audit-20261024/api-full-local-final.log` records four processes and four database copies of `audit_parent`. Within each shard, files run sequentially with module isolation but share that shard's PostgreSQL database. Different shards have separate databases; cross-file DB leftovers can therefore affect a later file on the same shard even when no file executes concurrently there.

- Lines 107–159: shard 2 reports `customer-legacy-physical-postgres.test.ts` as 46 tests / 46 skipped with a red suite marker. Its preceding file sequence is `instagram-comments.test.ts` (71 passed), then `social-video.test.ts` (56 passed), then the legacy suite. Terminal diagnostics above confirm setup failure before cases execute; these are not 46 failed business assertions. No explicit `.skip` is present in the legacy file.
- Lines 824–838: shard 3 reports `customer-accepted-callback-question-postgres.test.ts`, 12 tests / 1 failed. The failed parameter is accepted send, `working=true`; working=false and the other cases pass. Its duration is 5558ms, below the 20-second per-test timeout. The terminal trace above confirms an assignment assertion failure, not a timeout.
- The current source diff from `87aecdb` to `0466aca` does not touch these two tests, their fixture helpers, customer physical-admission implementation, lead intake or assignment. This reduces the case for an intentional business-rule regression from the audit patches, but does not itself prove environmental causation.

## Legacy physical suite: concrete source chain

The first local `beforeAll` in `customer-legacy-physical-postgres.test.ts:47–52` counts `CustomerLegacyPhysicalAttempt` rows with null endpointScopeId, non-STAFF actor and status ADMITTED/UNKNOWN, then requires zero. Its comment explicitly treats foreign UNKNOWN as evidence that this fixture must not erase or ignore.

Earlier shard-2 file `instagram-comments.test.ts` (with social-video.test.ts between it and the legacy suite) has these relevant facts:

1. `jsonResponse` at lines 51–53 returns a plain object cast to Response with only ok/status/text/json. It has **no clone method**. The normal fetch mock returns that object for actual public comment POSTs and DM sends.
2. Actual public replies call `callGraph` without `legacyTransport` (`messengers/comments.ts:1375–1377`); `messengers/meta.ts:1839` therefore creates a legacy physical target with null endpointScopeId (`customerLegacyMetaPhysical.ts:22`). This is the intentionally unattributed witness, not an authority upgrade.
3. `legacyMetaPhysicalFetch` durably admits before physical fetch and then calls `response.clone().json()`. Calling clone on that plain object throws; the existing catch settles UNKNOWN. The transport's later `response.text()` can still return the mocked success body, so the comment behavior test can pass while its physical-admission witness remains UNKNOWN. This is a concrete mock-interface mismatch, not a hypothetical provider failure.
4. `instagram-comments.test.ts:81–86` deletes its comment rows, calls `instagram.dispose()` and removes its property/district. It does not call `cleanupLegacyPhysicalFixture`. The messenger helper's dispose/cleanup removes scoped native/account rows and related records, but not the immutable physical-attempt table; that table intentionally has no FK cascade to endpoint scopes.

The exact ordered owned-DB reproduction above confirms this chain and the original 29-attempt count. Original full-run worker databases were not queried or modified by this triage.

Safe followup, after coordination: reproduce the preceding comments file and legacy file on a fresh owned DB, retaining original order and evidence. Correct fake HTTP to return an actual Response (supporting clone/body streams); explicitly clean only fixture-owned physical witnesses using captured comment IDs/digests and `cleanupLegacyPhysicalFixture`, before discarding those IDs. That helper already supports publicMetaCommentIds and its narrowly scoped test-only immutable-table cleanup. Retain the legacy test's zero-foreign-attempt guard and all production UNKNOWN/ADMITTED denial rules. Do not blanket-delete or relabel unscoped rows, disable the invariant, or make every denied send pass.

## Accepted callback working=true: confirmed fixture precondition gap

At `customer-accepted-callback-question-postgres.test.ts:237`, the test spies only on `workingHours.isWithinWorkingHours`. It deliberately leaves the real lead creation/assignment path intact. At line 270 it expects the resulting policy mode to be `assigned` when that spy returns true.

The file's beforeAll and `fixture()` create settings/revision/rollout/messenger account/scopes, but create **no AGENT or other eligible lead receiver**. `createCustomerRolloutFixture` also creates no staff. Merely declaring working hours true does not guarantee an available recipient:

- `services/leads/selection.ts:25–33` requires a receiving role, active account, no freeze, no current pause and no weekly day off.
- `pickAgentForLead` at 360–369 returns null for manual strategy or an empty eligible set.
- `services/leads/intake.ts:1531–1538` calls that real assignment path, and at 1601–1603 correctly records unassigned for daytime with no selected recipient, or night_pending for deferred assignment.

The expected `assigned` outcome therefore depends on staff/settings left by a preceding file or the copied template, not an owned fixture guarantee. Both terminal diagnostics and the fresh unchanged-fixture reproduction confirm the precise missing-recipient assertion failure. The fixture correction preserves the expected assignment and the real policy.

Safe followup: run this exact file on a fresh owned DB after the full run terminates, inspecting actual assertion diagnostics and the policy outcome. If the expected missing-receiver failure is confirmed, create an owned eligible synthetic receiving agent and explicitly preserve/set/restore the distribution strategy needed by this test; then retain and strengthen the assigned assertion (including an owned recipient), rather than accepting every policy mode. Keep the real business assignment service, working-hours parameter controls and callback/handover/send invariants intact. If the exact failure is elsewhere, trace that evidence first.

## Environment and setup controls reviewed

- `tests/setup.ts` pins external credentials, then sets the worker database URL before application imports. It preserves DB/JWT/encryption values. It does not create an eligible receiving agent or clean arbitrary immutable physical attempts.
- `testEnvPin.ts` removes external provider/site/push credentials; each relevant test supplies its own synthetic endpoints/HTTP mocks. The full log's VAPID-disabled warnings are expected, not causes of these failures.
- `runParallel.ts` starts independent shard processes with VITEST_DB_INDEX; `dbPerWorker.ts` uses per-process database copies. `fileParallelism:false` prevents test files sharing a shard DB from executing at the same time; it does not erase prior files' retained records.
- A .env/credentials assumption is not needed to explain the missing Response.clone interface or the absence of owned staff setup. No source change or expectation broadening has been made.

## Followup evidence boundary

Actual terminal diagnostics, consolidated totals and unchanged-fixture reproductions are now recorded above. Phase-2 fixture-only fixes and final targeted GREEN/preservation checks are in phase-2 `docs/audit-20261024/PHASE2-FIXTURE-ISOLATION.md`: 129 distinct relevant cases passed, plus an additional 71-case run preserving the old 29 witnesses byte-for-byte. This is targeted followup evidence; no replacement full-suite run or production verification is claimed.
