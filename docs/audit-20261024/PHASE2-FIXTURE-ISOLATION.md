# Phase 2 — full-suite fixture isolation

Scope: only `apps/api/tests/instagram-comments.test.ts` and `customer-accepted-callback-question-postgres.test.ts`; no application code, legacy guard, UNKNOWN denial policy or assignment rule changed. Parent authorized these changes after the frozen full run reached terminal diagnostics. Own PostgreSQL only; all provider HTTP is synthetic. Phase-2 dependencies: Prisma client/adapter/CLI 7.10.1, Vitest 4.1.12. These results do not change the original frozen full run's red status.

## Comments → legacy setup failure

Confirmed baseline on fresh owned `audit_triage`, in separate sequential processes:

1. Legacy file alone: native 0, 46/46 PASS; physical-attempt count 0 afterward.
2. Unchanged comments file: native 0, 71/71 PASS; leaves exactly 29 blocking null-scope UNKNOWN attempts: 23 public comments + 6 DMs.
3. Legacy file again: native 1, all 46 skipped; beforeAll expected 0, received 29. This reproduces the exact original shard failure without needing the intervening social-video file.

Root cause: the fixture cast a plain object with text/json methods to Response. The real physical wrapper calls `response.clone().json()`; missing clone throws and correctly settles UNKNOWN, while the caller's later text() still returns the fixture success payload. Fixture cleanup omitted its immutable physical witnesses.

Fix: use real `Response.json`, including the synthetic 403 response. Capture only this run's actually mocked POST destination digests (public comment paths and DM recipients) across nested cases; resolve matching null-scope attempt IDs after draining background work; pass these exact IDs to the existing test-only cleanup helper. Do not call the runtime target factory merely to compute a digest, because it also advances effect-source state. The media-specific fetch mock now records method/body too. No blanket status/scope deletion and no relabeling.

GREEN on fresh separate owned `audit_triage_fixed`: fixed comments native 0, 71/71 PASS; post-count all=0/blocking=0. Subsequent separate legacy process native 0, 46/46 PASS, including UNKNOWN/quiesced denial, retry boundaries and staff controls. Logs: `triage-comments-fixed-green.log`, `triage-after-fixed-comments.json.log`, `triage-legacy-after-fixed-comments-green.log` under ignored `reports/night-audit-20261024/`.

Foreign-witness preservation control: run fixed comments against original owned `audit_triage`, retaining the previous 29 witnesses from another fixture run. Native 0, 71/71 PASS. Full ordered physical-row JSON SHA-256 before and after is identical: `4837fad165687ae470f3160870f5072f2e1b2b5cfc4b96f5dfbfd0068aa3219d`; count remains 29. Thus cleanup preserves other fixture runs' UNKNOWN evidence. Logs: `triage-comments-foreign-preservation-green.log`, `triage-foreign-before-fixed-comments.json.log`, `triage-foreign-after-fixed-comments.json.log`. These witnesses remain retained.

## Callback daytime assignment precondition

Unchanged callback file on fresh separate owned `audit_callback_triage`: native 1, 11 PASS / 1 FAIL; working=true expected assigned, received unassigned at line 270 (`triage-callback-baseline-red.log`). The test mocked working hours but created no eligible receiving agent. Normal real assignment correctly returns unassigned when no receiver exists; this was a missing fixture precondition, not an application policy defect.

Fix: create one owned active AGENT with no pause/freeze/day off and current lastSeenAt; preserve/set fair distribution strategy and restore the original setting in existing teardown; delete only the captured owned agent ID after owned clients are removed. Retain assigned/night_pending expectations and strengthen working=true with a persisted non-null assignedAgentId check. No foreign agents are disabled or altered; no guarantee is added about which eligible agent wins if another preceding fixture legitimately left one eligible.

GREEN: native 0, 12/12 PASS (`triage-callback-fixed-green.log`), including accepted/unknown receipts, working/night paths, RU/TG, name-only contact, no MID, callback consent and delayed receipt controls. Readback: owned receiver count 0 and distribution strategy fair restored to this database's original value (`triage-callback-cleanup.json.log`). Non-default strategy restoration follows the same saved-field teardown; no additional runtime claim is made for a manual-strategy starting database.

## Validation boundary

Three relevant files, 129 distinct cases passed in separate final processes, plus 71 additional comments cases for preservation of foreign witnesses. `git diff --check` passed for both edited files. No full suite, browser/production check, map regeneration, dependency mutation or commit performed by this worker. The original frozen full suite's third failure (missing installed mammoth) is parent-owned environment verification and is not reclassified here.
