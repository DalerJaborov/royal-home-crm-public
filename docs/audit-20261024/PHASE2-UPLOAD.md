# Phase 2: stale multipart upload cleanup (NJ-01)

Status: narrow source patch and focused regression validation complete. Review-ready; no production claim.

## Confirmed baseline and scope

The parent retained actual PostgreSQL and filesystem reproduction at base `0466aca`: cleanup selects a 49-hour-old session, a resumed PUT accepts a second part and refreshes `updatedAt`, then cleanup uses the old snapshot to erase the row and both parts. Expected: the accepted upload survives. This is data loss caused by deciding eligibility outside a shared exclusion protocol.

This pass owns only multipart session lifecycle/storage, cleanup and their tests. No migrations, retention-policy changes, provider calls, production writes, deployment, complete-suite run or product features are included.

## Final narrow design

- The candidate scan remains unchanged. For each candidate, cleanup opens a transaction, locks only that `VideoUploadSession` row with `FOR UPDATE`, reloads it and re-evaluates the existing 48-hour / empty-24-hour policy before touching the directory.
- An accepted PUT has already updated that row. If its update is still uncommitted, cleanup waits, then sees the committed fresh timestamp and skips. A PUT arriving after cleanup owns the lock cannot successfully acknowledge its metadata update after cleanup removes the session.
- Filesystem removal still precedes database deletion. If removal returns false, the row remains for a later retry. Cancellation counts and pushes apply only to actual deleted sessions, not skipped candidates or failed removals.
- Only cleanup changes. Existing PUT, RAW/HANDOFF assembly, duplicate-key handling and explicit cancellation remain byte-for-byte unchanged. No network/media work runs in the cleanup transaction. The timeout is 120 seconds rather than Prisma's default five seconds, covering only row-lock acquisition and a session-directory removal, not file assembly.

The initial broader route/storage lock design was discarded after review: it unnecessarily expanded the change into long assembly transactions, abortable streams and duplicate-key handling. Its intermediate logs are retained as discarded development evidence and do not validate the final patch.

## Regression evidence

New `video-upload-cleanup-race.test.ts` exercises actual authenticated PUT/complete routes, real PostgreSQL lock blocking, and real local bytes. Scheduling hooks pause at selected boundaries; underlying IO runs normally except the explicit simulated disk-failure control.

Schedules: stale scan → accepted PUT → cleanup; uncommitted metadata renewal → cleanup waits → reloads committed timestamp → skips; cleanup owns stale row → PUT writes then blocks at metadata UPDATE → cleanup deletes → PUT fails without a 200 acknowledgement; stale scan → accepted RAW complete → cleanup skips missing session and leaves completed bytes intact; simulated removal failure → actual row and parts retained.

## Verification log

Baseline RED: `upload-cleanup-red.log`, native Vitest exit 1: actual PUT returned 200 after candidate selection, but old cleanup reported one cancellation instead of zero. Dedicated database `audit_upload_phase2` and dedicated local storage directories only.

Final focused GREEN: `upload-narrow-green.log` and matching `.exit.txt`, native Vitest exit 0; six files, **49 tests passed**, zero failures:

| File | Tests | Evidence |
|---|---:|---|
| video-upload-cleanup-race.test.ts | 5 | New schedules above; actual PostgreSQL blocking observed through `pg_stat_activity` / `pg_blocking_pids`, real disk bytes and authenticated HTTP routes |
| video-upload-session-cleanup.test.ts | 7 | Existing 48/24-hour policy, push and failure controls; filesystem abort mocked |
| video-upload-multipart.test.ts | 16 | Existing HTTP multipart RAW workflow and local disk |
| video-handoff-chunked-upload.test.ts | 8 | Existing HANDOFF ownership/roles/assembly controls; provider transports mocked |
| audit2-e-raw-upload-race.test.ts | 2 | Existing duplicate-uploadKey/winner-file controls; storage assembly/deletion mocked |
| local-video-storage.test.ts | 11 | Existing actual disk storage controls and simulated removal failure |

The cleanup-first PUT case intentionally reaches the existing route's P2025 error path and gets an error response; the logged error is expected evidence that it cannot falsely acknowledge success. It is not a newly fixed client-recovery flow. `git diff --check` passed. No final package typecheck or complete suite was run by this worker; the earlier typecheck log belongs to the discarded broader development version, not this final patch.

Follow-up after the parent's dependency update: precheck's mock-export guard rejected two narrow mocks in the new regression file. Both now merge `importOriginal` before overriding their named function; no guard/baseline change. `upload-mock-guard-r2.log` records `audit:mocks` exit 0. `upload-mock-r2-green.log` records the affected new regression file rerun on updated dependencies (Vitest 4.1.12): **5 passed**, native exit 0. This is a distinct follow-up, not a rerun or replacement of the original six-file/49-test evidence.

## Limits

No browser or production behavior is claimed. This fixes the confirmed stale-snapshot cancellation of an acknowledged resumed upload; it does not serialize the entire filesystem lifecycle. In-flight writes that have not acknowledged success can still lose the stale session and return an error (currently the ordinary route's database-error response). They may need a new upload session. Filesystem/DB crash atomicity, a directory removal outliving the 120-second transaction timeout, and non-acknowledged writer/orphan cleanup remain residual limitations. There is no assertion of zero bugs or of universal filesystem/transaction atomicity.
