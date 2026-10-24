# Native numeric constraints — bounded read-only variant pass

Stable runtime: phase2 frozen5616f8e3e886c500d0eeebf5edda924757620a2d. FINAL runtime/build/source untouched. No app/default-test/dependency/map edits. Probe source and raw output only under phase2 ignored `reports/night-audit-20261024/native-numbers-readonly/`; this MAIN report is the only tracked write.

**Result: no confirmed new native-number defect in the bounded scenarios.** Actual native submit preserved all tested API-admitted values. Source observations are distinguished from executed coverage.

Map scope: `/properties/:id/edit` PropertyFormModal; `/finance` CleanExpenseWizard; source-only numeric-constraint review in `/calendar`, `/pult`, AddInteractionModal and CleanReminderActions. Excluded known CF01 radius, rejected client-budget candidate, MatchingTab granularity policy and accepted financial business fixes. No security/exploitation/provider/DB activity.

## Executed actual component controls

Installed Chrome1440px and390px, actual components/hooks/application CSS, ordinary form buttons and native submit/invalid event listeners. Synthetic intercepted lookup and write endpoints; outgoing actual JSON validated by the existing actual shared propertyUpdateSchema/expenseCreateSchema. External map/font requests aborted consistently. No detached input/checkValidity simulation.

| Ordinary scenario | Values preserved in actual payload | Cases | Result |
| --- | --- | ---: | --- |
| Stored apartment edit | area52.5m², price100000.25USD, floor-1, windows0 | 2 | PASS; native submit,0invalid |
| Stored house edit | area52.5m², plot1.25sotka, price100000.25USD, windows0 | 2 | PASS; native submit,0invalid |
| New one-off expense wizard | amount234.56, usual category/note/month | 2 | PASS; ordinary3step submit,0invalid |

All6 synthetic writes reached the expected intercepted endpoint, actual shared validation accepted them, and the component closed successfully. Captured payloads preserve the numbers without integer coercion or native blockage. These are controls rejecting potential variants, not new bugs.

First batch:2 expense PASS +4 property harness failures because a read-only settings lookup was absent from the interception allowlist. Even those property cases had already reached their validated write/close, but are not counted as completed coverage. Added only the missing synthetic settings lookup to the ignored harness, then reran only the4 property/house cases:4PASS/native0. Expense controls were not rerun. Initial diagnostics/JSON retained; none of these harness failures is a CRM finding. No flakes/skips.

## Source-only findings and limits

- Current property wizard StepMain uses text inputs plus numeric normalization, so HTML number min/step is not applied there. This is a source/DOM design observation; that wizard was not mounted in this pass.
- Legacy PropertyFormModal area/price/signed-floor have no explicit native min/step; tested stored values submit normally. Plot area has stepany/min0, consistent with positive fractional plot area; windows min0 matches shared integer0..100. Source alone was not used to declare these safe: the representative ordinary edits above were executed.
- CleanExpenseWizard amount uses text input/custom preparation; tested234.56 reaches the real rendered form's ordinary submission without native invalid. No financial accounting/recurrence/business logic review or correctness claim is added.
- Selected Calendar/Pult/AddInteractionModal/CleanReminderActions have no HTML number inputs to form a min/step candidate in examined paths. No task UI runtime coverage is claimed. Date constraints/policies were not expanded into another audit.
- Claude expense/subscription presentations were briefly read for input type, but not mounted. Their patterns/limits are not counted as full coverage or policy defects.

## Reproduction, artifacts, integrity

From phase2 root: `npx playwright test --config reports/night-audit-20261024/native-numbers-readonly/playwright.config.ts` (initial batch), then the same command with `--grep 'property|house' --output=reports/night-audit-20261024/native-numbers-readonly/property-results` after the harness-only lookup correction.

Raw `browser.json`/`browser.exit` retain the initial2PASS+4harness failures; `property.json`/`property.exit` retain4PASS/native0. JSON successful attachments decoded into submit-1.json through submit-6.json; manifest.json maps exact scenarios/widths/source SHA256 and records0invalid events. Fixture/spec/config/retention script and error-context/traces retained. Playwright managed Vite5212 ended; no detached service.

Evidence layers: source review; actual shared schemas with synthetic input; actual mounted browser/native submission with mocked transport. **No actual Express request, isolated PostgreSQL, real records, provider delivery or production proof.** Fixture uses synthetic DIRECTOR UI context, not role-authorization testing. Two widths do not prove full responsive visual quality.

Reviewed runtime source/lock files match frozen5616; no app/defaulttests/deps/maps changed. No fix or new regression package proposed because no new defect was confirmed. Full suites were not run, and reading files is not complete coverage.
