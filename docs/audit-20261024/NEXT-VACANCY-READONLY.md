# Bounded read-only hiring lifecycle pass

Result: **no new confirmed functional defect** in the executed scenarios below. This is positive evidence for a named subset, not complete hiring coverage or a claim of no remaining bugs. App/default tests/dependencies/product maps stayed frozen at source `5616f8e`; only an ignored own probe and this main-worktree report were written. No fixes were made.

## Entry points and actual contracts

Started from product-map entries /vacancies, /vacancies/:id and /api/v1/vacancies, then traced staff position catalogue and candidate stages:

- `routes/recruitmentPositions.ts`: GET catalogue; PUT with expectedRevision, settings.manage and existing identity confirmation; globally unique publication/keyword mappings; catalogue updates are one transaction.
- `lib/recruitmentPositions.ts`: staff read retains closed positions; customer-facing openOnly SQL excludes them. Customer feature activation remains a separate gate.
- `components/RecruitmentPositions.tsx:97–156`: edit form sends complete title/terms/open flag plus current revision; closing the position explicitly promises to retain applications.
- `VacancyCreateSheet.tsx:30–36` and `VacancyStageActions.tsx:159–174`: manual create/legacy reassignment explicitly offer closed positions with “набор закрыт” labels. Thus manual addition to a closed position is permitted by the present UI contract, not filed as an ignored-close bug.
- `VacancyStageActions.tsx:43–50,101–118`: ordinary stage progression; rejected/hired candidates can return to REVIEWED. The separate NOT_CANDIDATE action hides an erroneous application; it is not ordinary rejection.
- `routes/vacancies.ts:738–904`: final status/date consistency, hiredAt creation/reset, row version guard, normal PATCH response.
- `useVacancies.ts:52–72,129–142`: list and detail query keys both begin with vacancies; stage mutations invalidate both. A suspected stale-detail cache-key mismatch was rejected by the actual keys.

The report intentionally excludes CV/files/privacy/security/backup/stopped streams/provider-call claims and the already fixed note/reason limits. Those areas were not retested or counted as coverage here.

## Executed HTTP + real PostgreSQL scenarios

One standalone ignored script exercised actual Express handlers through in-process authenticated supertest HTTP and actual own PostgreSQL; no Prisma query mocks. The script completed native exit **0**.

**Positions and ordinary/admin roles:** create an initially closed position as synthetic ADMIN; staff catalogue includes it, while the actual openOnly SQL reader returns zero. MANAGER can read the catalogue but PUT returns 403; ordinary AGENT read returns 403, matching its unavailable hiring UI. An owned MANAGER can manually create a candidate for the closed position (HTTP 201), matching the form's explicit closed-position option. That new manual candidate without a phone remains visible when the UI's include flags are supplied.

**Open/edit/close/reopen:** open the position; openOnly reader contains it. Edit title/terms and close it; openOnly excludes it while staff counts retain the candidate. Deep equality of every column read from the candidate before/after catalogue changes confirms the candidate was unchanged. This is a persisted-value comparison, not a claim about physical DB byte layout. Reopen: edited title/terms are retained. A stale expectedRevision yields 409 without advancing the current revision. A second position attempting the same publication/keyword mapping yields 409 and leaves no partial second catalogue row or first-position revision change.

**Candidate lifecycle:** actual MANAGER requests progress NEW→REVIEWED→INTERVIEW→INTERVIEWED→HIRED. INTERVIEW without a date returns 400. Valid dated interview succeeds. hiredAt appears once on hiring and remains identical after a note edit. HIRED is absent from activeOnly; returning to REVIEWED clears hiredAt and restores active visibility. REJECTED is visible under its named filter; returning to REVIEWED again restores active visibility.

**Erroneous-application hiding and explicit restore:** PATCH NOT_CANDIDATE removes it from the normal list and detail GET returns 404, matching the deliberate hidden-record contract. Explicit PATCH back to REVIEWED restores detail GET 200. This does not imply the UI offers a restore screen for hidden erroneous applications; that product choice is separate from normal terminal-stage reopening.

All stages used “save without sending” data only. Readback: InterviewInviteCall=0, RecruitmentCommunication=0, external fetch calls=0. No invitation, message, phone call or provider delivery is claimed.

## Evidence, setup and isolation

Own new database: `audit_vacancy TEMPLATE audit_template` in the existing own PostgreSQL container on 127.0.0.1:15439. No full-suite/foreign database, reset or DB deletion. The schema-only template's settings/config were not modified. Only owned synthetic Agent/RecruitmentPosition/JobApplication rows and their own audit records were created/removed.

Phase-2 ignored artifacts:

- `reports/night-audit-20261024/vacancy-lifecycle-readonly.mts`
- `vacancy-lifecycle-readonly.log` and `.exit.txt` (native 0)
- `vacancy-lifecycle-setup-keyword-limit.log`: first setup attempt correctly returned 400 because the probe's UUID-based keyword accidentally exceeded the existing 40-character limit; the fixture was shortened. This setup mistake is not an app finding.

External environment was pinned using existing testEnvPin and global fetch replaced with a throwing counter. Local identity confirmation was granted only to the synthetic ADMIN fixture through the existing in-process test helper, then revoked; no real actor/session was changed. No customer feature gate was enabled. The open-only check invokes the actual SQL reader directly, not the paid/customer conversation stack.

Final own-database counts after exact owned cleanup: Agent=0, RecruitmentPosition=0, JobApplication=0, RecruitmentCommunication=0, InterviewInviteCall=0, AuditLog=0. No broad cleanup or provider activity occurred.

Source hashes before/after probes match: vacancies.ts `0cfe5076e52ee975cb1b60240a54b1c5d1907a78e1e82ae188490d994dd474b7`; recruitmentPositions.ts route `5299fe4753be180b31f898ccb373bbecec447efbf27379143ce3034c98cfaca`; library reader `20d381f47515048b60accb028edc80409b1c5e7402404901d8958b4ea461efba`. Node 24.20.0 / Prisma 7.10.1; this standalone run is not a Vitest suite or cloud result.

## Uncertainties and remaining scope

No browser was executed: ordinary/admin UI-to-API body and visibility contracts were source-traced and HTTP-tested, but visual/mobile behavior, focus state and concurrent editing interactions remain unverified. Stale revision was tested sequentially, not a simultaneous two-editor schedule. Manual legacy candidate position reassignment, core-owned position immutability, bulk actions, large queues and customer bot offering after reopening were read only where needed or not executed; they are not marked fully covered.

Reopening a rejected application retains old rejection/talent-pool data unless explicitly changed; current UI/API do not state that this history must be erased, so this is a product-semantics unknown, not a confirmed defect. Direct API flexibility to skip intermediate stages likewise was not treated as a violation without an explicit required-transition contract. Closed-position manual additions are explicitly supported and retained as a passing control.
