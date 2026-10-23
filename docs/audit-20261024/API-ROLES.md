# API roles, recruitment and authenticated streams

Status: three confirmed defect families fixed in source; targeted isolated PostgreSQL and local HTTP checks pass. This is not production verification or complete API coverage. Recovered and finalized 24 October 2026, approximately 03:26 Asia/Tashkent.

## Confirmed findings

### AR-1: Recruitment bulk edits and erasure raced a committed call claim

- Reproduction: hold a real PostgreSQL row lock on a synthetic `JobApplication`, change its recruitment communication from `QUEUED` to `IN_FLIGHT` inside that transaction, then issue an HTTP bulk status/position/delete or single-delete request. Observe the mutation waiting in `pg_stat_activity`, then commit the claim.
- Expected: after the claim commits, bulk mutations skip the calling application (`updated: 0`, reason `calling`); single delete returns 409. Its stage, position and communication remain intact.
- Actual before fix: all four requests crossed the guard using their earlier snapshot; bulk returned `updated: 1`, single delete returned 204. In-flight candidate information could be changed or deleted while dispatch owned the candidate.
- Cause: bulk and erase transactions checked communication state before acquiring the application lock used by dispatch and single PATCH.
- Fix: acquire application row locks in stable ID order before reading candidates and checking call state, in both bulk mutation and shared erase transaction. Existing permissions and calling policy are unchanged.
- Regression: `vacancy-mutation-call-race.test.ts`, four real PostgreSQL transactions plus actual Express HTTP mutations. No telephony/provider call is made. Baseline red: `reports/night-audit-20261024/api-roles-race-red.log` (4 failed). Patched green: original `api-roles-green.log`, recovered `api-roles-recovery-related-green.log`.

### AR-2: Erasing a candidate removed a file still used by another portfolio

- Reproduction: two synthetic applications reference the same private file; one uses `cvFile`, the other only a rich `customerPortfolio` JSON item. Erase the first application and execute post-commit file cleanup.
- Expected: the physical file survives while the second application references it, and is deleted after its final reference is erased.
- Actual before fix: cleanup returned `{ removed: 1, kept: 0 }`; the surviving portfolio lost its file.
- Cause: reference checks included conversations, CVs and rejection voice notes, but omitted other applications' portfolio JSON.
- Fix: include PostgreSQL JSON containment for portfolio items containing the filename. Extra MIME/source witness fields do not prevent a match.
- Regression: `candidate-erase-files.test.ts`, four real PostgreSQL and temporary-disk cases covering CV/portfolio/voice/conversation references and final-reference cleanup. Baseline red: `api-roles-red.log`, portfolio case failed while three controls passed. That same initial run also had a separate missing-JWT setup failure for the race suite; it is not evidence for the race defect. Patched green in original and recovered role logs.

### AR-3: Permission/account revocation left an existing live audio stream connected

- Reproduction: open a real authenticated HTTP live-voice stream for a synthetic permitted employee; through an administrator API request revoke overrides, change role, deactivate the employee, or reset their 2FA.
- Expected: the completed management request synchronously detaches the listener and ends its connection, so later audio/transcripts cannot arrive.
- Actual before fix: all four mutation paths left the listener count at 1. The long-lived stream retained its original authorization indefinitely.
- Cause: the event bus closed general event streams on revocation, while live audio kept a separate subscription with no revocation registry; administrator 2FA reset also did not invoke stream closure.
- Fix: register authenticated live-audio closers in a small transport-independent registry; include these in per-agent and global event-stream closure; invoke per-agent closure after administrator 2FA reset. Closure clears timers, unsubscribes and unregisters the stream.
- Regression: `live-voice-listen-revocation.test.ts`, four real HTTP streams plus isolated PostgreSQL management requests. Tests assert synchronous listener removal, connection end and no later transcript/audio. Reconnection is 403 after permission/role/deactivation changes. Baseline red: `api-live-listen-red.log` (4 failed); completed patched green: `api-roles-recovery-livevoice-green.log` (4 passed).
- Existing limitation, deliberately outside this patch: access JWTs contain no session ID; revoking refresh sessions or resetting 2FA does not independently invalidate an otherwise valid access JWT. This fix closes the current 2FA-reset stream, but does not claim a subsequent request using that access token must be rejected. Existing authentication policy is unchanged. The registry is process-local, matching existing stream/revocation infrastructure; multi-instance invalidation was not demonstrated.

## Execution evidence

All data mutations used the specialist's own `audit_roles` database on loopback port 15439, test-only JWT/encryption values and `NODE_ENV=test`; external credentials were removed by the standard test environment pin. Candidate files used a fresh temporary private-upload directory. No production records, real provider sends, paid generation or live configuration were used.

| Completed run | Result | Evidence |
| --- | --- | --- |
| Original recruitment patch, access, resume and disk regressions | 46 passed / 5 files | `reports/night-audit-20261024/api-roles-green.log` |
| Recovery: live-audio revocation | 4 passed / 1 file | `reports/night-audit-20261024/api-roles-recovery-livevoice-green.log` |
| Recovery: vacancy access/list, patch, four claim races, candidate files, bulk roles/validation, live-audio route, agent role override reset | 57 passed / 7 files | `reports/night-audit-20261024/api-roles-recovery-related-green.log` |
| Recovery: live monitor and general stream shutdown | 16 passed / 2 files | `reports/night-audit-20261024/api-roles-recovery-stream-support-green.log` |

Recovery checks total 77 passed across 10 distinct test files. Do not add the overlapping original 46 as distinct coverage. The earlier `api-live-listen-green.log` is interrupted/incomplete (route suite skipped and no terminal summary); it is not a successful completed run. Recovery route tests later passed all eight cases.

The new bulk-role suite covers ADMIN/MANAGER allowed status edits; AGENT/SHAREHOLDER denied mutations and unchanged rows; administrator create/read/position/erase lifecycle; manager denial for both erase routes; duplicated IDs; four malformed/unsupported bulk commands. These are tested behavior controls, not additional confirmed bugs.

## Review and limits

- Reviewed the final candidate erasure, vacancy locking, stream lifecycle, per-agent management closure hooks and access-token/session boundary. `git diff --check` on owned tracked source files passed.
- Source ownership: `candidateErase.ts`, `vacancies.ts`, `authenticatedStreams.ts`, `eventBus.ts`, `liveVoiceListen.ts`, narrow 2FA-reset line in `agents.ts`; four new regression files (`vacancy-bulk-access`, `vacancy-mutation-call-race`, `candidate-erase-files`, `live-voice-listen-revocation`). No schema or migration change.
- A pg client-query deprecation warning appeared during the bulk-role suite; the suite completed successfully. It is retained in the log and is not claimed fixed.
- Full API suite, build/typecheck, mock/source guards, product map, wider role/IDOR coverage and final integration remain coordinator responsibilities. This pass did not execute a browser or production probe, and did not exhaust tasks/settings/uploads/staff endpoints. Reading a source path is not recorded as complete behavioral coverage.
- No commits, map regeneration, merge, ship or deployment were performed by this specialist.
