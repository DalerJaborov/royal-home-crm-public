# Independent API/privacy differential review

## Executive summary

Reviewed immutable source range `87aecdb..b20bc69` using the installed differential-review skill and its methodology/adversarial/reporting references. Six source files reviewed, +53/-4 lines. Risk-first scope: candidate deletion versus call dispatch, retained private files, authenticated audio revocation and shutdown. This report does not approve unrelated parts of the commit.

| Severity of confirmed introduced defect in this review scope | Count |
| --- | ---: |
| Critical / High / Medium / Low | 0 / 0 / 0 / 0 |

Recommendation: **CONDITIONAL ACCEPT** for these six files, subject to the parent’s consolidated checks. The changes close the demonstrated defects; no new must-fix defect was established. Residual concurrency/distributed-session risks below are explicitly not represented as reproduced vulnerabilities or complete coverage.

## Changes, baseline and blast radius

| Source | Changed behavior / risk | Direct production callers checked |
| --- | --- | --- |
| routes/vacancies.ts:1067,1154 | Candidate row locks before busy-state check; HIGH, external-call consistency | eraseApplications: two routes; one bulk mutation transaction |
| lib/candidateErase.ts:70 | Retained portfolio JSON reference check; HIGH, irreversible file erasure | removeCandidateFiles: one caller, shared erase helper; eraseJobApplicationsTx: one production caller |
| lib/authenticatedStreams.ts | New synchronous closer registry; HIGH, private audio access | registration: one route; closure: two event-bus entrypoints |
| lib/eventBus.ts:226,248 | Include audio registry in existing revocation/shutdown hooks; HIGH | closeStreamsForAgent: seven agents route callsites; closeAllStreams: one shutdown callsite |
| routes/liveVoiceListen.ts:126,135,164 | Register/unregister and release stream resources; HIGH | one authenticated GET stream route |
| routes/agents.ts:905 | Close streams after administrator 2FA reset; HIGH | one existing management endpoint |

Baseline history inspected with `git blame 87aecdb` and path logs. Candidate cleanup and bulk flow originate in `cd5a55c` (22 October); the baseline already performed post-commit count-then-unlink cleanup. Audio close lifecycle originates in public-history root `0c6887d` (20 October); the prior local closer detached only the monitor, without the revocation registry. No authorization guard was removed in the reviewed diff. The only removed code in vacancies is a type-only Prisma import, replaced with its runtime value for SQL parameter joining.

## Adversarial/source analysis

### Candidate claims versus mutation/deletion

Attacker/concurrent actor: an authenticated employee allowed to edit recruitment candidates while an assistant-call dispatch claims the same application. Modern dispatch is `lib/recruitmentCommunications.ts:307`: `currentSource` locks canonical state/native first as applicable, then `JobApplication` at line 127, then the communication claim at 327. Bulk/single deletion now obtains application locks first, then reads `IN_FLIGHT`/`ACCEPTED` communications, then erases dependencies. If dispatch wins, mutation re-reads its committed active status; if deletion wins, subsequent currentSource sees a missing application and refuses dispatch. Neither mutation path acquires the canonical state/native lock after locking the application, so that reviewed pair has no reverse lock dependency. Both bulk operations sort application locks by ID, avoiding opposite-input-order cycles between overlapping batches.

Single PATCH already locks the application before its active-call check (`vacancies.ts:859`), preserving the same convention. SQL interpolation uses Prisma tagged templates and `Prisma.join(ids)`; inputs are parameterized. Bulk schema requires 1–200 IDs and deduplicates them; the private erase helper is called only with nonempty single/bulk lists. An empty `IN ()` path is not reachable through these routes. Existing role middleware and director/admin erase restriction remain.

Legacy `interviewInviteCall.ts` was also inspected: its old dispatcher does not use the application row lock, but `runInterviewInviteCallTick` has no production caller in this tree (only its definition), and `inviteCall:true` is rejected by the route before enqueueing. Therefore the old dispatcher is not evidence of a new reachable bypass in this patch. Do not claim its standalone functions fully audited.

### Retained candidate files

The added PostgreSQL JSON `array_contains: [{file:name}]` predicate matches an object inside the portfolio array even when it also has kind/MIME/source-event fields. It does not require exact object equality. No schema acceptance or file-path guard is weakened. `deletePrivateFileByName` retains the existing own-filename/path handling, and cleanup keeps conversation/CV/voice references as before.

Potential TOCTOU remains between the final reference count and filesystem unlink. This is **pre-existing** count-then-unlink design, not introduced by the new OR branch. Actual ingestion callers were traced: core intake consumes already persisted native attachments and checks private-file existence, while recordCustomerRecruitmentAttachments persists the native ledger entry under canonical locks. Those facts make arbitrary file-name injection claims unsupported; a concurrency proof must include the real source/reference creation path, not an invented unrestricted public file-reference writer. A full reference/GC protocol would be a separate design change.

### Authenticated stream lifecycle

Subscription, registry registration and backlog setup execute synchronously in the route; no await is added between those steps. Close is idempotent and clears both timers, detaches monitor handler, unregisters itself, then ends HTTP. The registry removes an agent’s set before iterating a snapshot, so callbacks unregistering themselves do not skip other listeners. A closer throwing cannot prevent closure of the remaining agent streams. Normal monitor end and request/response close reuse the same closer.

The existing agents permission/role/deactivation hooks call the expanded event-bus closer. 2FA reset now closes existing audio/general streams after refresh-session/elevation revocation. This does not invalidate access JWTs: tokens have no session ID and middleware separately validates signature/current agent permissions. Reconnection after 2FA reset is intentionally outside the claim; changing that would require authentication-policy work.

The registry is process-local, as are existing general SSE subscribers/access invalidations. Cross-instance revocation and the narrow access-read versus revocation-registration race are not solved or demonstrated by these changes. Do not promote the local four-case test to a cluster-wide guarantee.

## Test evidence and gaps

This independent review read tests and terminal log summaries; it **did not rerun** them or any full suite. Evidence remains attributable to the original specialist:

- `vacancy-mutation-call-race.test.ts`: four real-PG lock interleavings, covering bulk status/position/deletion and single deletion. The test waits for `pg_stat_activity` blocking, rather than assuming a sleep means the request reached the contested lock.
- `candidate-erase-files.test.ts`: rich portfolio JSON plus CV/voice/conversation controls and final-reference removal, real PG plus temporary disk.
- `live-voice-listen-revocation.test.ts`: four real HTTP streams and actual admin mutations; listener count, ended socket and absence of later audio/transcript are asserted.
- Completed logs independently inspected: `api-roles-recovery-related-green.log` 57/7, `api-roles-recovery-livevoice-green.log` 4/1, `api-roles-recovery-stream-support-green.log` 16/2. These counts overlap the named test purposes and must not be summed with older original runs as new coverage.

Useful targeted followups: two overlapping multi-ID bulk operations in reversed order; dispatcher-waits-for-delete ordering using actual currentSource with provider transports mocked; audio-specific shutdown and normal socket-disconnect registry cleanup; a closer throwing while another stream must still close. These are test gaps, not findings. No provider send, foreign DB access, browser interaction or production change occurred during this review.

## Scope limits

Six changed source files and the named direct dependencies/callers were reviewed. Whole candidate identity/authority machinery, storage garbage collection, access-token revocation policy and all API routes were not exhaustively audited. Concurrent parent review of business reservation locking is outside this report and must be resolved separately before publication. No API/privacy code edits were made for this review; separately assigned business-lock corrections are recorded in BUSINESS.md. No commit was made by this reviewer.
