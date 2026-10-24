# Client forms — bounded read-only functional pass

Source: frozen phase2 `5616f8e3e886c500d0eeebf5edda924757620a2d` while exact cloudfull runs. Application/default tests/dependencies/maps unchanged. Raw probes only in phase2 ignored `reports/night-audit-20261024/client-forms-readonly/`. No real clients, PostgreSQL, providers, live settings or security/exploitation stream.

Map scope: `/clients` create/edit ClientFormModal and `/clients/:id` buyer-requirements/detail rename, as routed by product-map. This is selected functional coverage, not complete client-module coverage. Previously accepted network/deal/pagination/settings/recruitment/audit-date families excluded.

## CF-01: same valid radius is blocked by Next but accepted by ordinary step navigation

**Confirmed family accepted by root after independent review of actual PlaceRadiusInput code/comment, contracts.json, retained navigation-payload-1.json/navigation-payload-2.json, and the executed additional/navigation specs. No fix under freeze.**

1. Synthetic settings returns matchDefaultRadiusM=1250. Start ordinary new buyer, valid name/phone, click «Дальше», then «+ Добавить место».
2. Actual ClientFormModal creates the point with1250m, using that setting as documented in addPlace. No manually malformed client record or browser state injection.
3. Click actual «Дальше». Chrome emits native `invalid` for1250; Rh2Sheet form.noValidate=false. min=100,step=100 yields stepMismatch=true. No submit event fires; wizard stays on the current step. Native message suggests1200 or1300. Both1440px and390px reproduce.
4. Identical flow changed only to1200 advances, with identical blocked map tiles. Separate stored-client1250 fixtures also cannot advance. This distinguishes native constraint failure from network/map failure.
5. In the exact same new form, leave1250 untouched but click the existing stepbar «Проверьте» then «Создать клиента»: actual component submits radiusM1250 unchanged; the actual shared create schema accepts the request. Both widths pass this control. The inconsistency is between ordinary navigation paths, not a request to introduce another radius policy.

Contracts: actual API settings field is `z.number().int().min(100).max(10000).optional()`; shared desired-place schema admits any integer100..10000. Actual create/update schemas and evaluated actual settings field each accept100,101,1200,1250,1299,1300,10000 (7 input rows ×3 boundaries, contracts.json). PlaceRadiusInput commits in-range input as-is and clamps only min/max on blur. Main form seeds/retains1250 without quantizing it.

Policy caveat: MatchingTab's separate settings UI also uses step100. That is evidence of UI granularity intent, so simply changing product granularity globally is not justified here. Nevertheless the current client wizard itself accepts/submits1250 using its stepbar while its Next path rejects that same application-supplied value. Root accepted the existing client radius contract as integer-meter values100..10000: settings/schema admits1250 → new point preserves1250 → PlaceRadiusInput commits it unchanged → shared create/update admit it → ordinary stepbar submits it unchanged. This is the precise acceptance path; MatchingTab granularity is not changed. No silent rounding/truncation or change to shared API requirements.

Relevant source: `apps/web/src/components/ClientFormModal.tsx:50` radius control andstep100; `:479` settings-based new point; `:443` payload preserves radius; `:569` native Next button; `:598` ordinary stepbar navigation. `components/rh2/Rh2Sheet.tsx:158` native validating form. API/shared boundary source hashes retained.

Minimal plan after freeze: set only client PlaceRadiusInput native step to1, aligning native Next with the existing integer-meter client API contract. Retain min100/max10000, current state/blur bounds behavior, configured defaults, and stored values exactly. Do not round1250 to1200/1300, rewrite settings, change MatchingTab, disable whole-form validation, or broaden shared schemas. Promote real Next/stepbar regression for new/configured and existing1250 at1440/390 plus1200/min/max/invalid-fraction controls; preserve source pins and original RED evidence. No other form/policy refactor proposed.

## Rejected hypothesis and preserved behavior controls

- Rejected money-step hypothesis: main wizard budget inputs omit step, but **actual Chrome accepts123.45 and advances normally** at both widths; stepMismatch=false. Integer123 also advances. Source-only speculation about default HTMLstep does not establish a bug. Shared money contract explicitly rounds to cents, but no contradiction reproduced here; no money bug counted.
- Actual buyer-requirements editor submits234.56 with USD, retains valid floor0, sends empty notes as null, and retains234.56 draft after intercepted400. Corrected mounted controls pass1440/390; captured JSON validates with actual buyer-requirements schema. No data-loss/nullable-clear defect confirmed in those exercised values.
- Main edit payload source preserves zero floors using explicit empty-string comparison; nullable clears, currency and desired-place arrays are explicit. Buyer editor has preserved-district fallback and local shared-schema validation. These source observations are not runtime coverage of all values.
- Detail inline rename trims/validates name and closes only on successful mutation in examined clean/legacy callbacks. Full ClientDetail mounting/navigation was not exercised.

## Evidence accounting

All browser requests are intercepted synthetic API responses. External map tiles are explicitly aborted to avoid provider calls; map warnings are expected.1200/new-stepbar controls work with the same map condition. Native invalid/submit events are captured from the real rendered Rh2Sheet form, not a detached input.checkValidity simulation.

- First managed Chrome batch8 executions:4 passing budget controls,2 true stored-radius RED,2 discarded buyer harness locator timeouts. Original logs/traces preserved. These two harness failures are not CRM bugs.
- Second batch6:2 true configured-radius RED,4 GREEN (1200 navigation and corrected buyer editor controls). Buyer label locator was changed to actual textbox accessible-name selector; no source edit.
- Third batch2:normal stepbar submits1250 unchanged,2 GREEN.
- Net usable browser evidence:4 radius RED variants and10 GREEN controls, one root-accepted family, not four bugs. Each batch has independent log/exit/result directory. No fullsuite run.

Files: `mounted.log`/`mounted.exit`, `browser-results/`; `additional.log`/`additional.exit`, `additional-results/`; `navigation.log`/`navigation.exit`, `navigation-report.json`, `navigation-report.exit`, `navigation-payload-1.json`/`navigation-payload-2.json`; fixtures/specs/configs/helpers; `contracts.mts`, `contracts.json`, `contracts.log`/`contracts.exit`. Managed local Vite5201 was stopped by each Playwright lifecycle. Nodev24.20.0; installed Chrome; actual app components/hooks and sharedschemas on frozen5616.

Reproduction from phase2 root: `npx playwright test --config reports/night-audit-20261024/client-forms-readonly/playwright-additional.config.ts` (2RED+4GREEN), then `.../playwright-navigation.config.ts` (2GREEN). Pure contract command: `npx tsx reports/night-audit-20261024/client-forms-readonly/contracts.mts` (native0).

Evidence layers: source and pure schemas executed; actual mounted component browser with synthetic transport executed; real Express API/PostgreSQL and production **not executed** for this pass. Ordinary AGENT/admin authorization and full desktop/mobile visual quality are unverified; fixtures use synthetic DIRECTOR UI context and two viewport widths only. Reading files is not coverage.

Reviewed files: ClientFormModal, ClientBuyerRequirementsEditor, ClientFormDraft, selected ClientDetail rename callbacks, useClients create/update, Rh2Sheet/CleanRecordForm, selected shared client schemas and clientBuyerRequirements, selected clients/card POST/PATCH, settings matchDefaultRadiusM and MatchingTab numeric control. No source fixes or default test additions.


Artifact-retention follow-up: the2 already-green navigation controls were repeated only with Playwright's JSON reporter because list reporter did not retain successful inline attachment bodies. No additional coverage is claimed. JSON native0 contains both actual payload attachments, decoded into navigation-payload-1.json and navigation-payload-2.json, each preserving radius1250. Managed5201 ended normally. Root accepted CF-01 based on the exact same-form path discrepancy; money candidate remains rejected.

## Durable regression plan — awaiting terminal cloud5616

Root independently inspected the exact code/comment, schema-contract results, successful raw POST payloads for both widths, and executed browser specs. Root confirmed CF-01 and approved only the local step1 fix after terminal cloud5616. Application/defaulttests remain frozen; this section is a plan, not executed new tests or authorization to edit early.

Tracked proposed files after explicit source gate reopens: `apps/web/playwright.night-client-radius.config.ts`, `tests/fixtures/night-client-radius.html`, `tests/fixtures/night-client-radius.tsx`, `tests/e2e/night-client-radius.spec.ts`. Actual ClientFormModal/Rh2Sheet/hooks; synthetic intercepted profile/settings/district/client endpoints; managed isolated local Vite server. Abort external map requests and keep the identical condition across positive/negative controls. No mocked form elements or validation helper. No real API/config/provider/database operations.

**Normative GREEN oracle:** for an API-valid integer radius, actual native Next MUST advance to the budget step, with zero native invalid events and one native submit event. The actual form must still have noValidate=false. Do not copy readonly positive1250 assertions expecting native invalid; those were diagnostic RED witnesses, not desired behavior. Assert unchanged radius in eventual actual outgoing payload, not merely input.checkValidity. Capture events on the rendered form before clicking the real Next button.

Planned14 cases at1440px and390px:

| Scenario | Cases across widths | Baseline expectation | Patched expectation |
| --- | ---: | --- | --- |
| New point seeded from accepted settings1250 | 2 | RED: Next fails normative advance/no-invalid oracle | GREEN; Next advances and preserves1250 |
| Stored client point1250 | 2 | RED: same native obstruction | GREEN; Next advances and preserves1250 |
| New point1200 control | 2 | GREEN | GREEN; Next advances, no invalid |
| New point minimum100 control | 2 | GREEN | GREEN; Next advances, unchanged100 |
| New point maximum10000 control | 2 | GREEN | GREEN; Next advances, unchanged10000 |
| Fraction1250.5 negative control | 2 | GREEN rejection | GREEN rejection: native invalid, no submit/advance/request; value not rounded |
| Existing normal stepbar-review path1250 | 2 | GREEN payload preserves1250 | GREEN payload preserves1250 |

Expected attribution: baseline4 RED +10 GREEN; after one attribute change14 GREEN. These are expected outcomes, not results. Positive cases verify actual shared create/update admission; fraction verifies the existing shared integer rejection. Other form fields remain valid. Fraction intentionally has an invalid-event oracle; only invalid fractional input may use that expectation. Do not add tests requiring a new range/rounding policy: existing out-of-range blur clamping remains unchanged.

Execution order after explicit authorization: add durable tests/fixture/config; run against unchanged ClientFormModal and retain exact4 failing positive assertions plus controls; change only PlaceRadiusInput step100→1; rerun the same14 cases; targeted TypeScript/lint and parent review. Preserve original readonly and durable RED artifacts separately from GREEN. No sharedschema, MatchingTab, defaults, blur rounding, global noValidate, map, dependency, fullsuite, commit or deployment work in this proposed scope. Parent owns subsequent package validation.
