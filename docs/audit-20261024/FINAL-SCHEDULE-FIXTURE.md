# Weekly post-showing fixture: scoped invariant, 24 October 2026

Only the case `кому звоним > второй показ той же недели — второго звонка не будет` in `apps/api/tests/post-showing-call-schedule.test.ts` changed. The scheduler, weekly policy, clock handling, providers and the other 43 cases are unchanged. Parent authorized this fixture-only correction after controlled RED/GREEN evidence. `npm run where -- postShowingCall` and `impact-tests --base=HEAD` were inspected before editing; this test-only change has no application caller impact requiring an additional neighboring suite.

## Evidence and correction

The retained source-5616f8e full-cloud run 40042873456 passed this case on retry. Its machine-4 JSON artifact retained the original assertion despite the console showing only the rescued result: `expected 1 to be +0`, original test line 315:49, at the second tick's global return assertion. The identity of the competing cloud row remains **unknown**. We do not claim the exact historical cloud cause is established.

The scheduler processes global work and returns at most one started call per tick. The old fixture reset only its own client's rows and treated that global return as its own result. A controlled second owned client with an earlier due showing deterministically consumes the first slot. The old oracle then fails at the same second-tick expected-0/received-1 assertion; this confirms the isolation mechanism, not the unknown cloud row's identity. A clean repeated control passed 30/30 without retry, so jitter alone was not shown to cause failure.

The one durable case now creates that competing client/showing itself and cleans only its captured client's rows in `finally`. Bounded existing `waitFor` drives the actual scheduler until the first **own showing ID** is CALLING, then verifies attempts=1 and lastAttemptAt=NOON. The second own showing must become SKIPPED with weekly_limit, attempts=0 and lastAttemptAt=null. Exact own bridge calls (scenario.clientId) must equal 1; exact own rows with non-null lastAttemptAt must equal 1. No `>=` oracle or global deletion was introduced. The first call is not artificially settled: the existing next-day stuck-call recovery may refund its attempt counter, while retaining its lastAttemptAt as weekly history.

## Executed validation

Synthetic records only, fresh owned `audit_schedulefixture` from own `audit_template`, own loopback PostgreSQL port 15439. Actual Prisma/PostgreSQL and scheduler logic were used; telephony remained mocked and a throwing external-fetch guard asserted zero requests. No production/provider path ran. Vitest 4.1.12, Node 24.20.0, Prisma 7.10.1. Retry explicitly 0 throughout.

| Evidence | Runtime | Result | Ignored artifact under reports/night-audit-20261024 |
| --- | --- | --- | --- |
| Unchanged affected case, clean repeated control | retained PHASE2 5616f8e | 30 PASS, native 0; other 43 filtered | schedule-fixture-probe.log / .exit.txt |
| Controlled two-client original oracle | retained PHASE2 5616f8e | 1 FAIL at second tick, native 1; 75 filtered | schedule-controlled-baseline-red.log / .exit.txt |
| Same controlled two-client scoped invariant | retained PHASE2 5616f8e | 1 PASS, native 0; 75 filtered | schedule-controlled-scoped-green.log / .exit.txt |
| Final durable file, including competitor in the one repaired case | FINAL candidate | **44/44 PASS**, native **0**, retry 0; 7.74s total | schedule-final-44-green.log / .exit.txt |

The final run used ignored `schedule-final-regression.config.ts` and `schedule-no-egress.setup.ts`; the latter's zero-fetch assertion passed. A prior ignored-config discovery failure found no tests before execution and is not counted as product evidence. `git diff --check` passed for the changed test. Final own fixture readback: Agent=0, Client=0, Interaction=0, Property=0, PostShowingCall=0. No unattributed rows/databases were reset or deleted.

Executed 44-case test SHA256: `1e0a8916a8a27a5895d2be70662d83fb74aa8d84e16040af1ecedf90f42e7e67`. Parent's final review requested nullable type compatibility for waitFor's row|null return; the two first-row assertions now use optional access. Undefined still fails against the exact expected 1/NOON, so behavior and strictness are preserved. This type-only followup was not rerun independently; the parent final whole-package check will test its exact bytes. Released test SHA256: `188f032f6f6fd1160bd3e2c7da3cc398b8de01d02db1c4c8c54f94e91aa5588f`. Application hashes retained unchanged: postShowingCall.ts `6d7cd99a1e2afca0e9cc3034f009557de6d49b69d354bd0dfd1fa8db1968029b`; postShowingCalls.ts `b2316036dadd8591fd2199c45f6fa92cb7f9a9f71f360c763b0ae335892afd69`.

Source is released to the parent coordinator. No full suite, browser, real call, deployment or production verification was performed by this followup. The retained MAIN `NEXT-SCHEDULE-RETRY-READONLY.md` documents the original attribution limits.
