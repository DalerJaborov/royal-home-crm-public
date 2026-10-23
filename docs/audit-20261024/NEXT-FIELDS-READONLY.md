# Additional field/invariant pass (read-only)

Source frozen at `0466aca29e9090e046e8affdf93760c9224144bd`. No application sources, existing tests, dependencies, database or providers may change during this pass. Only ignored report probes and this report are writable.

Method: property-based-testing guidance, deterministic generated valid-domain inputs, strong inverse/roundtrip/oracle/idempotence properties. Seed `0x20261024`; no new PBT dependency. Probe code and raw output will be retained under `reports/night-audit-20261024/fields-generated/`.

## Results checkpoint

- Deterministic probe executed **279,008 property instances**, seed `0x20261024` (`539365412`), with **1,004 failing instances** that reduce to two root-cause families below. These are repeated counterexamples, not 1,004 distinct bugs. Raw output `probe.log`, structured `results.json`, process exit 1.
- All other **278,004 instances passed**. A separate boundary probe executed 30 actual-schema field validations and two CSV examples; its exit 0 means the probe collected results successfully, not that all its observed schema acceptances were true.
- No fix was applied during the source freeze.

| Property group | Cases | Result |
| --- | --- | --- |
| Money cents inverse, rounding idempotence, rate-1 currency identity, positive four-decimal rate conversion vs independent BigInt rational oracle | 200,000 | All pass |
| Interview minute roundtrip, Dushanbe day/hour vs independent Intl timezone oracle, datetime input conversion | 24,000 | All pass |
| Client/property displayed code → search ID, whitespace and case invariance, IDs 1..999999999 | 36,000 | All pass |
| Vacancy URL value preservation including Unicode/query punctuation; selection toggle involution/no mutation; chunk order/cardinality | 12,000 | All pass |
| CSV canonical-header roundtrip with quotes, delimiters and embedded CR/LF data; safe-text idempotence | 6,000 | All pass |
| CSV delimiter detection when other separators occur inside quoted header cells | 1,000 | 1,000 failures |
| Candidate create note lengths 0,1,1999,2000,2001,2500,3999,4000 against actual server schema | 8 | Four pass, four fail at 2001+ |

## FIELDS-01 — P2: recruitment forms admit text the API rejects

**Confirmed contract mismatch in three form paths**, not a claim of persisted data loss:

| Form path | UI maximum | Actual API boundary | First rejected nonblank length |
| --- | --- | --- | --- |
| Create candidate, `note` | 4000 | POST `createSchema.note`, trimmed string max 2000; saved into `interviewNote` | 2001 |
| Existing candidate internal note | 4000 | PATCH `interviewNote`, string max 2000 | 2001 |
| Existing candidate rejection reason | 4000 | PATCH `rejectionReason`, string max 500 | 501 |

Reproduction: enter a name, existing position and a note containing 2001 ASCII characters in the create form. Its HTML length limit and `candidateCreateBody` admit this body, while the actual route's Zod boundary rejects it. Editing an internal note or rejection reason has the equivalent mismatch. `boundaries.json` records success at 2000/500 and failure at 2001/501/4000, with actual Zod issue paths/messages.

The probe **evaluates the literal current create schema and literal PATCH field schema expressions extracted from `apps/api/src/routes/vacancies.ts`**, using the installed Zod runtime. It does not reimplement or invent matching validators. Schema/source hashes are retained; no route module was imported and no database call occurred. Creation's helper was executed unchanged. PATCH form payload construction was source-traced (`note.trim() || null`); blank values/null remain accepted.

Attribution: the create-schema hash and both exact PATCH field expressions match public baseline `87aecdb`; the CSV helper, both affected form components and creation helper have no diff from that baseline. These are pre-existing defects discovered by this pass, not regressions introduced by the overnight audit patch. `manifest.json` records the comparisons and clean application-source diff.

Cause: separate HTML field limits and API schemas drifted. The narrow variant hunt started at the exact create `draft.note/maxLength=4000` instance, expanded to the shared stage textarea and mapped each mode to its distinct payload field. Name 120, phone 40 and experience 2000 match create schema; city UI 80 is narrower than server 120 and is a product restriction, not the same rejection defect. Recruitment position editor validates its payload with the shared schema before sending; contact preview likewise uses shared validation.

On error, source shows the create draft is not cleared and the sheet only closes through `onCreated` on success; stage forms similarly call `closeForm` only on mutation success. **Actual browser retention after the length error was not executed in this pass.** The confirmed effect is an avoidable save rejection after user typing, with a generic API error; do not describe it as proven lost data.

Proposed patch scope after the freeze: keep existing API/product limits, expose/reuse a shared boundary instead of duplicating strings, set create/internal-note UI to 2000 and reason UI to 500, and validate before dispatch without truncating entered text. Regression cases: accepted boundary 2000/500; boundary+1 rejection before request; existing over-limit legacy text stays visible/editable; server rejection retains draft and allows correction. No proposal to increase storage or truncate historical values is implied.

## FIELDS-02 — P2: quoted separators corrupt CSV column detection

**Confirmed pure parser/record contract defect.** `parseCsv` claims quoted/escaped multiline CSV and comma/semicolon support, but `detectDelimiter` simply counts both separator characters on the first physical LF-delimited line, including characters inside quoted cells.

Minimal example: a comma-delimited file whose header is `"quoted;header;0","name"` is parsed as one column instead of two. The inverse defect occurs with a semicolon file and commas in a quoted header. All 1,000 generated constrained examples fail the independent writer→parser roundtrip.

Closer import example in `boundaries.json`: a valid comma file with recognized `Имя`/`Телефон` columns plus an unused legacy header containing three semicolons. `csvToRecords` merges the entire header into one key; `records[0]["имя"]` is absent. The import mapper reads recognized keys and ignores other columns, so this parser behavior defeats that mapping. This is a source trace plus pure runtime record reproduction, **not an HTTP import/database-write demonstration**. A separate CR-only file with ordinary header and semicolons only in data also misdetects because the detector considers the whole file; the parser itself explicitly handles CR record breaks.

Proposed patch scope after the freeze: detect separators only outside quotes in the first logical record, respecting escaped quotes and CR/LF record terminators; preserve canonical Excel comma/semicolon and BOM behavior. Regressions should cover both delimiters, quoted extra headers, quoted line breaks, escaped quotes, canonical headers, CRLF and the parser's existing CR support. Keep truly ambiguous single-column handling explicitly documented.

## Initial false properties rejected

- Currency conversion is not additive for independently rounded amounts; cents and positive-rate exact integer oracle will be used instead.
- CSV record conversion intentionally trims headers/values and drops blank rows, so arbitrary whitespace/blank-table roundtrip is not its contract.
- Short-code parser explicitly limits IDs to nine digits; formatting arbitrary unsafe or larger numbers is outside the tested inverse domain.
- Recruitment chunk size is an internal positive integer; arbitrary zero/negative chunk sizes are not generated as realistic user input.

## Reviewed files so far

`packages/shared/src/money.ts`, `dushanbeDay.ts`, `format.ts`; `apps/web/src/lib/date.ts`, `acceptedDate.ts`, `vacancyFilters.ts`, `vacancyQueue.ts`, `vacanciesView.ts`; `apps/api/src/lib/csv.ts`; `apps/web/src/components/VacancyCreateSheet.tsx`, `VacancyContactForm.tsx`; `apps/web/src/pages/settings/MoneyTab.tsx`.

Additional source paths: `apps/web/src/components/VacancyStageActions.tsx`, `VacancyDetails.tsx`, `RecruitmentPositions.tsx`; `apps/web/src/hooks/useVacancies.ts`; `apps/api/src/routes/vacancies.ts`, `import.ts`; `apps/web/src/components/AddInteractionModal.tsx`; `apps/web/src/pages/Reports.tsx`, `settings/MatchingTab.tsx`, `settings/DisciplineTab.tsx`; `apps/web/src/lib/claudeFinanceApi.ts`.

Source checks: commission/operations views submit their own subsets; settings loading gate avoids default values before fetch; matching form has explicit loading/error gate; future task/showing scheduling requires date/time and uses Dushanbe conversion; report export handles pending/error. These are bounded source observations, not complete role/UI execution. Existing role tests, full API suite and production verification remain separate.

Remaining limits: generators are deterministic hand-written property probes, not exhaustive enumeration or a new PBT dependency. Money domain is nonnegative cent amounts with positive rates 1..30 in four decimal places; dates cover valid minute precision in 2000..2099; negative/tie semantics, malformed browser dates, arbitrary unsafe IDs and real-user export/import workflows remain outside these results. Browser/form authorization, physical devices, DB writes, providers and production were not exercised. `acceptedDateToSave` is a syntactic editing guard, not assumed to be an independent calendar validator. Source freeze retained.
