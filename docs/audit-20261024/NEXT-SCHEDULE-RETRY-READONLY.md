# Read-only triage — post-showing scheduler retry rescue

Conclusion: the **exact first failed assertion was recovered from the machine JSON artifact**; a matching fixture-isolation mechanism was deterministically reproduced with owned rows. The actual cloud row/state that caused it remains unobserved, so attribution of that CI occurrence is still **unresolved**. No application policy, default test, dependency or call behavior was changed.

## Actual cloud evidence

Frozen run: source `5616f8e`, run 40042873456, machine 4 process [3/3] (global shard 12/60). Console `batch3-cloud-all.log:32150–32155` reports the 44-case file passed; lines 32625–32626 identify one second-attempt rescue: `post-showing-call-schedule.test.ts > кому звоним > второй показ той же недели — второго звонка не будет`.

Although console output omits the first failure detail, retained `batch3-cloud-artifacts/machine-4/api-tests.json` has a passed aggregate assertion **with failureMessages still present**:

> AssertionError: expected 1 to be +0

The stack points to `post-showing-call-schedule.test.ts:315:49`, the **second** `runPostShowingCallTick(later)` expectation (expected 0, received 1), not the first call expectation, skip-reason expectation or a timeout. Aggregate assertion duration is approximately 128ms. The retry reporter only prints the case name/retry count; it does not explain which row started.

Raw logs/artifacts are under the retained phase-2 reports directory. The recovered assertion materially narrows the failure but does not reveal a foreign client/showing ID or the exact first tick's selected row.

## Source reasoning and rejected premature explanations

Actual case at test lines 309–319 creates one showing three hours before fixed NOON=2026-09-16T07:00Z; expects one start; creates another one day later, again three hours before that day's noon; expects zero and an own-client SKIPPED weekly_limit row. beforeEach clears only this file's own clientId, own interactions and own post-showing calls; the scheduler itself queries globally.

- **UUID seed jitter alone does not explain this boundary.** postShowingCallSpreadMs at `postShowingCall.ts:153–156` is 0–29 whole minutes. A 09:00 showing plus 150 minutes is 11:30–11:59 local, always due by noon. It cannot randomly fall after noon.
- **Real createdAt versus fixed now is a fixture mismatch, not a proven cause.** makeShowing does not pin createdAt, but showingMomentOf at 223–233 uses the supplied exact-time nextActionDate here. Scheduling uses createdAt only as a lower bound/order (`260–280`), with no upper bound excluding the October-created fixture. That mismatch is worth recording; it does not make the isolated case fail by itself.
- **Weekly history remains available on next-day stuck-call release.** claim/start persist the passed `now` as lastAttemptAt (`postShowingCalls.ts:142–157`); hasRecent compares that field per client and excludes only the current call (`290–296`). handleOurSideFailure at `postShowingCall.ts:366–384` returns an attempt and reschedules strictly in the future but retains lastAttemptAt, so the earlier attempt still supplies the same client's weekly limit.
- **A return value of 2 is impossible in this source.** runPostShowingCallTick at 413–425 stops at the first non-skipped outcome and returns at most 1. A foreign row can nevertheless consume that one slot or start during the second tick; the test's global count does not identify its own client.
- Inspected schedule/start/skip writes involved in this case are awaited. No missing-await/async-timing root cause was confirmed. No finding is based merely on the pg deprecation/config warning seen in probe setup.

## Executed own-database probes

Used **retained PHASE2 runtime `5616f8e`**, not FINAL shared output while parent builds. Fresh NEW `audit_schedulefixture TEMPLATE audit_template` in the existing own 127.0.0.1:15439 container. Existing file's telephony bridge/blacklist/parser mocks were retained, external fetch was replaced with a throwing spy, and no live call/provider path ran.

An ignored copy of the original test and a custom ignored Vitest include were used; default test files were not edited. retry was explicitly **0**.

1. **Clean control:** the exact affected case, repeated 30 times with fresh owned showing IDs and original beforeEach behavior, passed **30/30** without retry. Other 43 cases in the ignored copy were filtered/skipped and are not executed coverage. Log `schedule-fixture-probe.log` + `.exit.txt`, native 0, 8.06s.
2. **Owned second-client contamination control:** add another owned BUYER/showing with an earlier due time, while preserving the original fixture's client-scoped reset. Actual scheduler + PostgreSQL produced:

| Step | Actual tick result | Interpretation |
| --- | ---: | --- |
| First noon | 1 | Other owned client's earlier call starts; original fixture's first call remains PENDING |
| Next noon | 1 | Original fixture's first call only starts now: reproduces original expected-0/received-1 boundary |
| Simulated retry first noon after the same client-scoped reset | 1 | Original fixture's first call now starts; other client's rescheduled work is future-dated |
| Retry next noon | 0 | New own showing is SKIPPED weekly_limit; repeat of the case passes |

The control asserts the other client's CALLING row and original client's PENDING row after the first tick, then own weekly_limit after retry. External fetch calls=0. Log `schedule-contamination-probe.log` + `.exit.txt`, native 0, one mechanism case passed; all other cases were filtered. This is a deterministic demonstration that the test can fail and then pass because global scheduler state outlives its own client reset. It is **not** proof that this particular extra row existed in the cloud worker.

The initial attempted FINAL ignored config found no tests (outside-root discovery) and exited 1 before test/DB execution; no FINAL probe remained running. The corrected custom config and all executed probes are in PHASE2. The warning about native config loading did not prevent the successful executed runs.

## Scope, cleanup and next evidence

Ignored PHASE2 artifacts under `reports/night-audit-20261024/`: schedule-fixture-probe.config.ts / .test.ts, schedule-fixture-probe.log/.exit.txt, schedule-contamination-case.fragment.txt and schedule-contamination-probe.log/.exit.txt. Actual unchanged source hashes: original test `876f018b289be1ec63405f330877b0f93f12bb0e9a4cfea6474e2358bfaef1c8`; scheduler `6d7cd99a1e2afca0e9cc3034f009557de6d49b69d354bd0dfd1fa8db1968029b`; storage helper `b2316036dadd8591fd2199c45f6fa92cb7f9a9f71f360c763b0ae335892afd69`.

Only captured owned fixtures were removed; no foreign/unattributed rows or existing database was reset/deleted. Final own readback: Agent=0, Client=0, Interaction=0, Property=0, PostShowingCall=0. The existing test setup created default Settings only in the new own test database and restored its two touched flags in teardown. No production config/notification/call writes occurred.

Next attribution evidence would be the first-failure scheduler row identities/statuses before each tick, or a retained cloud DB snapshot. Without that, name the actual CI cause unresolved and the fixture-isolation mechanism confirmed. A future fixture correction must establish/observe its own scheduled call identity and isolate competing global work without blanket-deleting foreign rows or changing weekly calling policy. No such correction is included in this original read-only phase; no full suite or production verification was performed.

## Authorized subsequent fixture correction

After controlled two-client baseline RED (second tick expected 0 / received 1) and scoped-invariant GREEN in ignored PHASE2 probes, parent authorized correction of this one case only in FINAL. The controlled competitor is retained in the durable case, with captured-ID cleanup. Own first showing must actually start (attempts=1, lastAttemptAt=NOON), own second must be SKIPPED weekly_limit with attempts=0/null lastAttemptAt, exact own originated calls=1 and own historical-attempt rows=1. FINAL complete file passed **44/44**, native 0, retry 0; external fetch=0. App scheduler/policy and the other 43 cases are unchanged. Detailed report and journal: FINAL `docs/audit-20261024/FINAL-SCHEDULE-FIXTURE.md` and `docs/journal/2026-10-24-post-showing-weekly-fixture.md`. Actual cloud competing row remains unknown; no production/full-suite claim is added.
