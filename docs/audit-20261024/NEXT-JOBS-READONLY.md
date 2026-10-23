# Next pass: scheduled work and data lifecycle (read only)

Baseline source pinned at `0466aca`; app source/tests remain frozen during the parent's consolidated suite. This pass writes only this report and ignored local probe artifacts. Own test data, if needed, uses `audit_business` only; no live provider calls or production data.

## Scope and actual progress

Read jobs/runner.ts, enqueue.ts, registry.ts, handlers.ts; handler timeout declarations; geocode/deferredPush/siteResync adapters; cleanupStaleVideoUploadSessions and its actual PUT-part caller; propertyVideoCleanup, outgoingMediaCleanup, privateFiles retention; CSV parser and import callsites. Product inventory and `where`/impact routing used for videoUploadCleanup: one direct production dependant (cron.ts), three directly mapped test files (cron schedule registry, disabled-account initiative, video-upload-session-cleanup).

## Confirmed findings (source unchanged; fixes deferred)

### NJ-01 — stale cleanup cancels an actively resumed video upload (P1 data loss)

- Actual candidate scan: `lib/videoUploadCleanup.ts:45–68`; irreversible `abortLocalUploadSession(session.id)` and unconditional row delete at 75–78. PUT-part route: `routes/properties/videos.ts:1060–1120` reads session, writes actual bytes and updates parts/updatedAt, without a DB transaction or shared session lock.
- Reproduction: own `audit_business` DB contains a 49-hour-old synthetic two-part session with part 1 on a fresh temporary disk. At the actual cleanup function's candidate-scan boundary, perform the same real storage write and Prisma parts update as the PUT route, accepting fresh part 2 and refreshing updatedAt, then return the old candidate snapshot to cleanup. No filesystem function is mocked; the candidate query is restricted to this fixture so no other row is eligible for the probe.
- Expected: the now-active session and newly accepted part survive. Actual: cleanup reports `{sessions:1,failed:0}` and both DB row and part 2 are gone. Fresh updatedAt was `2026-10-23T22:48:09.803Z`, seconds before actual deletion. Native exit 0.
- Probe: ignored `reports/night-audit-20261024/readonly-upload-cleanup-probe.mts`; evidence `readonly-upload-cleanup-probe.log`. This is deterministic actual PostgreSQL/filesystem evidence at a simulated scheduling boundary, not an end-to-end browser race or actual production deletion.
- Root cause: eligibility is decided from a stale scan and there is no shared exclusion protocol around session-directory deletion versus upload/assembly/cancel. A timestamp re-read or conditional DB delete **after unlink** is insufficient: the new part is already destroyed. A timestamp check immediately before unlink without writer participation still has a race after the check.

Minimal correct fix plan, to implement only after the frozen suite:

1. Introduce a shared per-session critical-section helper and make cleanup, PUT-part, complete (RAW/HANDOFF) and explicit DELETE use it. With the existing schema, a PostgreSQL transaction holding row locks across the bounded local filesystem critical section is the smallest option. Define one global order **Property → VideoUploadSession**; do not introduce session → Property inversion against property deletion/cascades or handoff updates. Re-read the session after acquiring both locks.
2. Cleanup re-evaluates the 48-hour / empty-24-hour policy against the locked current row before aborting any directory. Only then abort and delete the session row, retaining the row on filesystem failure so a later cleanup can retry. Counters and cancellation push apply to actual cancellations, not skipped stale candidates.
3. PUT-part acquires the same locks before writing bytes; re-check row existence, property ownership/purpose and part plan under the critical section, derive parts from the fresh row, then store parts/updatedAt. Cleanup that wins first gives the writer a clean 404 without writing to a removed directory; an accepted writer makes cleanup wait and then skip its fresh session.
4. Complete must also pin the session while reading/assembling its parts and removing the session directory/row. For HANDOFF, assemble into an independent staging path under the session critical section, then release locks before expensive downstream media work/provider calls. For RAW, persist the completed PropertyVideo reference consistently before releasing session ownership. Keep existing duplicate uploadKey handling and the winner's storage file protection. Do not silently wrap unbounded ffmpeg/network work in a default 5-second interactive transaction; select a bounded assembly timeout and leave expensive post-processing outside.
5. Explicit cancellation uses the same protocol. Preserve idempotent 204 for a session already gone. Resume/start discovery alone must not defeat the retention policy forever without an accepted part.

Required regression schedules: scan→accepted PUT→cleanup (both row and bytes survive); PUT holds lock→cleanup waits then skips; cleanup wins→PUT 404/no orphan bytes; complete holds lock→cleanup waits and preserves completed bytes; cleanup filesystem failure retains session; stale/empty/fresh policy controls; RAW/HANDOFF, duplicate complete and explicit cancel controls. Use actual PG lock blocking plus a temporary disk and zero provider transports. The existing `video-upload-session-cleanup.test.ts` mocks abort and has no candidate-renewal schedule; `audit2-e-raw-upload-race.test.ts` mocks assembly and tests a different duplicate-key case.

### NJ-02 — explicit unsupported CSV currency silently becomes TJS (P2 accounting data)

- Actual route `routes/import.ts:333–345` normalizes currency with `currencyRaw === "USD" ? "USD" : "TJS"` before the shared schema sees it. Thus invalid explicit enums bypass schema validation.
- Actual authenticated HTTP/PG reproduction: upload a valid synthetic property CSV with `Валюта=RUB`, price 50000 and a masked synthetic owner contact. Response 200 `{created:1,skipped:[]}`; stored `{price:"50000",currency:"TJS"}`. No currency conversion took place. The imported amount is mislabelled, while the user is told the row succeeded.
- Probe/evidence: `readonly-import-currency-probe.mts`, `readonly-import-currency-probe-r2.log`, native exit 0. The retained initial r1 log is an unrelated missing-owner-contact validation failure and is not positive evidence.
- Minimal fix plan: apply the default only to genuinely missing/blank currency; normalize supported TJS/USD strings and pass any other explicit value to enum validation (or reject with a currency-field error). Add parameterized invalid currencies and blank/TJS/USD controls; assert invalid rows create no property. Check the same prevalidation fallback pattern for source/condition separately, without declaring every fallback a defect.

### NJ-03 — downloadable property import template fails its own required-field rules (P2 blocked workflow)

- Actual template route `routes/import.ts:140–144` omits the `Окна` header and example value. The property creation refinement requires windowCount for APARTMENT/HOUSE/COMMERCIAL; import reads it from `r["окна"]`.
- Actual GET→POST HTTP/PG reproduction: download the real template, change only synthetic title/district/contact to isolate the fixture, upload it unchanged structurally. Response 200 with created 0; row 2 skipped: `«Окна» — Укажите количество окон`. No property stored. `templateContainsWindows:false` recorded.
- Probe/evidence: `readonly-import-template-probe.mts` and `.log`, native exit 0. Fix plan: include `Окна` and an appropriate numeric example in the downloadable template, and make an actual template roundtrip regression assert the example row satisfies current create rules. Preserve defaults and owner-contact validation.

### NJ-04 — valid quoted CSV header defeats separator detection (P3 import compatibility)

- `lib/csv.ts:49–51` counts delimiters inside quotes on the first physical line. A valid comma-separated file with an extra quoted header containing three semicolons is guessed as semicolon-separated.
- Pure actual-module probe input: `Имя,Телефон,"Дополнительно; важное; заметки; прочее"` followed by a synthetic record. Expected three headers; actual one header `имя,телефон,дополнительно; важное; заметки; прочее`, so known fields cannot be found by either import route. The text is valid CSV; additional columns are otherwise ignored by the importer.
- Probe/evidence: `readonly-csv-delimiter-probe.mts` and `.log`, native exit 0. Fix plan: count candidate delimiters only outside quoted fields across the first logical record, including escaped quotes and embedded CR/LF; retain comma/semicolon/BOM controls. Lower priority than irreversible upload deletion and incorrect money.

## Job runner risks investigated but not confirmed as new defects

- `runOne` uses Promise.race and no attempt fencing on final updates. The code explicitly documents uncancelled promises and delays retries by at least the timed-out attempt duration. Arbitrarily late handlers can still outlive that delay; proving a duplicate business effect requires a real non-idempotent handler path, not merely a synthetic timeout. No such business-level proof was established here, and no fix is proposed on speculation.
- Stuck RUNNING claim threshold is 15 minutes. Inspected custom handler timeouts stay below that threshold (e.g. transcription 10m, social video 9m, seller-photo 6m). Batch wait is mitigated by refreshing lockedAt before run; multi-worker stale batch ownership and final-write fencing remain follow-up hypotheses, not observed production behavior.
- DONE/SKIPPED retention uses `runAt`, although the comment says DONE is retained a week. A job queued over a week before eventual completion could be removed immediately by the cleanup predicate. Not promoted to a confirmed business bug in this bounded pass; no exact handler backlog/runtime proof run. Preserve this distinction from NJ-01–04.

## Already reviewed controls / no finding yet

- Customer lanes use MATERIALIZED limited claims and an in-process per-lane busy guard before the first await.
- General scheduled queue has a cron-level overlap guard; claim uses row locks and retains dedupe key across running/backoff states. Handler contract explicitly requires idempotency.
- Geocode updates include the address snapshot and respect manual pins; changed-address writes retry rather than accepting stale results.
- Property-video retention locks/reloads Property and checks publication receipt, upload sessions, active jobs and draft references. Outgoing-media expiry updates the current JSON in SQL instead of replacing its stale application snapshot.

## Verification and limits

No full suite or broad test run was started. Only named ignored probes ran, with native exit 0. Probe fixtures were cleaned from own audit_business; temporary filesystem storage was removed only after its resolved path was verified under the probe's own temporary prefix. No app source or default-scanned tests were edited. No production, browser, provider delivery or paid generation claim. `where` additionally maps runner.ts to cron.ts/worker.ts and import.ts to four HTTP routes plus app.ts. The product map lists `background-jobs` and `stale-video-uploads-cleanup` schedules; these are mapped paths, not inferred coverage of every job.
