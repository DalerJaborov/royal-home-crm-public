# Audit scope and coverage

Baseline: 87aecdbcc4a69a3f57ad6de23b4e739ca6c9c3b1. Generated 2026-10-23T21:56:57.719Z.

| Inventory layer | Count |
| --- | ---: |
| sourceFiles | 1958 |
| existingTestFiles | 1805 |
| screens | 68 |
| modules | 78 |
| cron | 104 |
| jobs | 23 |
| external | 13 |

The machine inventory is inventory.json. Its pending states deliberately do not imply that an area is tested. Specialist reports record actual reviewed paths, reproductions and executed checks. A consolidated green suite does not prove all routes, roles or business scenarios.

## Scenario matrix

| Dimension | Required variants | Evidence status |
| --- | --- | --- |
| Identity and permissions | anonymous, agent, manager/admin, director, revoked rights, foreign ownership | API77-test named subset and8-role navigation complete; exhaustive combinations pending |
| Inputs | omitted/null/empty/invalid/large text, Unicode, numbers, dates, arrays, files | named finance/API, CSV/import, recruitment and generated field properties complete; report-period/calendar regressions added in the next package |
| Business state | draft/planned/paid/archive/deleted, stale version, conflicting updates | isolated PG finance/deal/reservation groups complete; other transitions individually pending |
| Transport | unavailable network, response lost after commit, timeout, duplicate submit | named frontend8-case Chrome and66-test subsets complete; providers pending |
| UI | desktop and390px, loading/empty/error/permission, cancel and pending submit | named component regressions plus80 role/route/viewport smoke visits; full workflows/visual acceptance pending |
| Async | race/lock order, retries, provider unknown outcome, scheduled status changes | named claim/reservation/stream and resumed-upload races reviewed and regressed; cancelled task selection and settings rollback checked; other jobs pending |
| Integration | real PG, local browser, provider contract mocks | no live provider delivery or production mutations |

## Completed evidence groups

| Evidence group | Completed scope | Limits |
| --- | --- | --- |
| Precheck | shared/API/web build and ESLint; 304 web files / 1867 tests; all source/map guards | no full API suite, no production proof |
| Business integration | 71-test finance group plus 42-test adjacent group; overlap retained separately | only named scenarios in BUSINESS.md |
| API/privacy integration | 77 tests across 10 distinct files | named authorization/claim/file/stream cases, no exhaustive IDOR audit |
| Frontend component checks | 66 unit tests and 8 Chrome cases at 1440/390; independently reproduced failures on87aecdb and success onb20bc69 | intercepted responses; see FRONTEND-BASELINE.md |
| Real role navigation | final 8/8 roles, five routes at1440/390 each, exact finance permissions and read-only rejection | smoke only; no field mutation/completion, visual or device acceptance |
| Tooling | 14 stand-root/template tests | unrelated scripts not exhaustively audited |

Source-file `pending` inventory states are intentionally conservative. These group results do not silently mark every file exercised by the suite as fully tested. Use the specialist reports and README.md for exact paths and reproductions.

## Explicit limits

Production behavior, physical iOS/Android, external provider delivery, exhaustive role combinations, every scheduler and every source file are unverified until named evidence exists.

## Later evidence and explicit pending areas

Exact3305 local precheck passed305web files/1877tests, builds and executed source/script guards (104script passes,32conditional/platform skips). Eight-role HTTP/PG/browser smoke passed8/8 with80route/viewport visits. These improve the named evidence only; they do not turn the whole inventory into covered code. Its GitHub run40040133970 failed in the Linux plan before any API matrix job started because2stand tests invoked cmd/mklink. The nativefs correction has Windows14/14 evidence; Linux confirmation and the next full API verdict remain pending.

Phase2 focused groups are described in PHASE2-IMPORT.md, PHASE2-UPLOAD.md, PHASE2-FIELDS.md, PHASE2-TASKS.md and PHASE2-SETTINGS.md. The two fixture isolation fixes have129distinct cases across3files and a separate71-case foreign-witness preservation run. Counts from overlapping groups are not summed into a unique total. Independent collector follow-up covers1129 registry-verified transitive advisory versions, with5 unverifiable entries; maintainer criteria have a narrower3root-tooling scope.

The third bounded package adds actual HTTP/PG evidence for inclusive Dushanbe assistant-audit calendar filters (28tests/3files) and invalid ads/report periods (33new cases plus adjacent reports controls; see their reports). Property/automatic seller insertion now has10new real HTTP/PG cases and7adjacent files/63tests, including actual unique/FK failures and initial event preservation. These patches passed independent review; complete frozen-package validation remains pending at this checkpoint. The lifecycle pass additionally executed4named ordinary HTTP/PG/disk flows across separate runs and7pure archive controls; see NEXT-LIFECYCLE-READONLY.md for exact scope and harness errors excluded from bug counts.

Unresolved areas include the reports loss-widget flow/cohort denominator policy, reminder repeat/deadline policy, exhaustive destructive/restore/retention combinations, every background job, cross-process audio revocation, provider outcomes and physical devices. A stopped security stream has no accepted findings or coverage credit. Its unfinished notes are not published or treated as evidence.

## Final bounded additions and full-suite accounting

CF01 client radius: actual mounted components/native form at1440/390, synthetic responses. Identical durable14cases:4RED/10controls before the one-attribute correction,14PASS afterward;12actual write payloads retained. No real API/PostgreSQL or ordinary-AGENT-specific browser flow is claimed by this component fixture. Existing earlier8-role navigation is a separate smoke layer. Fractional budget suspicion was rejected by actual Chrome controls.

Hiring lifecycle: selected actual HTTP/PostgreSQL catalogue close/edit/reopen, stale revision/duplicate rollback, MANAGER stage transitions and explicit hidden-record restore controls passed in own audit_vacancy, with0provider calls. No browser run or concurrent two-editor schedule; see NEXT-VACANCY-READONLY.md. Read paths and ambiguous product choices are explicitly excluded from completed coverage.

Complete exact5616 cloud accounting is1489physical files and14074terminal assertions:14070PASS/1FAIL/0SKIP/3TODO, all20reports present and matching independent discovery. The failing public-label oracle has a separately validated test-only correction. A schedule case required existing CI retry1: its second global-tick assertion was recovered, a controlled two-client fixture reproduces the false own-client interpretation, and the repaired single case passes in the44case file without retry. Application call policy remains unchanged; the original cloud competing row was not observed. Source CI/offline API-image success is separate from the RED API result. See FULL-API-5616.md; do not reinterpret targeted greens as a completed green full run.

A bounded native-number variant pass adds6actual Chrome controls at1440/390 for stored apartment/house fractional values, signed floor/zero windows and a fractional expense. Actual intercepted payloads satisfy existing shared schemas;0native invalid events. No new bug, actual API/PG/provider or full responsive acceptance claim. Initial missing-settings harness errors are retained/excluded. See NEXT-NATIVE-NUMBERS-READONLY.md.
