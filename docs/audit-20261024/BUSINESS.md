# Business rules audit — 24 October 2026

Scope: expense payment/accounting dates/currency, recurring expenses, finance forecast input, reservation expiry, completed-deal repricing. All runtime evidence below uses the audit's own isolated PostgreSQL database `audit_business`, HTTP requests through Supertest and synthetic fixtures. External delivery is not asserted. No production writes, release, merge or deployment.

## Confirmed defects and fixes

| ID | Reproduction and expected result | Actual baseline result / root cause | Fix and regression |
| --- | --- | --- | --- |
| BUS-01 | Create a USD planned expense without a rate; PATCH its status to PAID, both as a single-field operation and full editor form. Freeze the payment-time rate so future settings changes cannot alter this paid expense. | Rate remained null; reports subsequently converted using current settings. PATCH did not run the payment endpoint's rate capture. | Compute final status/currency/rate and capture on transition to PAID. Two parameterized HTTP/DB cases assert stored rate and conversion under a changed context. |
| BUS-02 | Change a TJS plan to USD without supplying a rate; pay later after settings rate changes. Plan should retain null until payment, then use the payment-time rate. | Currency edit froze the rate prematurely, so later payment used the old rate. | Clear the prior currency's rate and retain null for a plan; explicit planned rates remain supported. Regression also preserves an explicitly supplied rate. |
| BUS-03 | PATCH only `month` on a paid expense whose retained payment date is in another month. Accounting month must follow the effective payment date. | Month changed independently because PATCH inspected only a payment date present in the incoming body. | Derive paid month from the final payment date, including the stored date. A separate regression preserves editable accounting month for historical paid expenses with no known date. |
| BUS-04 | Run legacy recurring-expense automation for an automatic USD payment at rate 10; later report at rate 20. The paid expense must keep rate 10. | Automation created PAID rows without exchangeRate/rateCapturedAt; their historical value drifted with settings. | Capture currency rate when an auto-paid row is created. Regression checks stored rate/timestamp and conversion under rate 20. |
| BUS-05 | GET finance forecast for `2026-00`, `2026-13`, `2026-99`. Impossible calendar months must return 400. | All returned 200; regex accepted any two digits and date construction normalized into a different month/year. | Constrain month to 01–12; three HTTP regressions. |
| BUS-06 | Select an expired reservation, renew its reservedAt before the transaction begins, then continue the expiry worker for NEGOTIATION and CONTRACT_SIGNED. Fresh reservation and deal must remain untouched. | First variant released the freshly renewed property to AVAILABLE; held-stage variant falsely set reservationExpiredAt. Worker trusted its pretransaction candidate snapshot. | Lock the Property row and match exact reservedAt/status/deletedAt inside the transaction before any expiry side effect. Deterministic interleaving uses a transaction-boundary spy, with all reads/writes and locking on real PostgreSQL. Two stage regressions plus existing expiry/rollback tests. |
| BUS-07 | PATCH a completed deal with soldPrice=200000 and commissionPercent=3, or soldPrice=200000 and commissionAmount=6000. Derived counterpart must use the price from the same request. | Amount became 12000.75 instead of 6000; mirror percent became 1.4999 instead of 3. Both branches used existing.soldPrice while persisting the new price. | Give data.soldPrice priority in both existing repricing formulas. Two HTTP/DB regressions, including payout sum invariant for the percent case; original no-price-change tests remain. |

The fixes preserve the existing product rules: explicit expense rates, unknown historical payment dates, paid-vs-planned distinction, held reservation stages, and commission share rounding. No automatic backfill of historical expenses is attempted.

## Evidence ledger

Full logs are intentionally ignored local artifacts under `reports/night-audit-20261024/`.

- `business-red.log`: 2 files, 8 failed / 2 passed; reproduces BUS-01–05 before fixes.
- `business-green.log`: 8 files / 71 tests passed after finance fixes: expense-workspace, finance-automation, finance-commission-forecast, audit2-i-recurring-source-agent, expenses-csv-and-recurring, expense-payment-accounting, audit2-a2-expense-forecast-average, finance-forecast-query-validation.
- `business-reservation-red-r3.log`: 2 failed / 2, with both stale-candidate behaviors shown for BUS-06. Earlier r1/r2 attempts are retained; r3 is the usable baseline.
- `business-finish-red-r1.log`: BUS-07 independently reproduced as 2 failed, with existing repricing cases and BUS-06 patched cases passing (4 passed). Native exit 1.
- `business-finish-green-r1.log`: native exit 0; 9 files / 42 tests passed after all fixes. Includes reservation timer (10), sold price (5), closed repricing (4), commission cents (3), recurring/csv (7), closed share salary (1), reservation renewal race (2), expense payment accounting (7), forecast month validation (3). `git diff --check` on this specialist's changed paths passed.

`npm run where -- --file apps/api/src/routes/deals.ts` and `impact-tests.mjs --for=apps/api/src/routes/deals.ts` identified three routes, two source dependants and 37 directly relevant API test files. The focused run covers the changed calculations and nearby sale/reservation/payout rules; the parent owns consolidated checks and the broader suite.

## Coverage and limitations

Actual runtime coverage includes director expense create/edit/pay, planned/paid/historical-null-date states, USD/TJS rate transitions, invalid month HTTP boundaries, completed deal price/commission edits, cents payout invariants, reservation renewal interleaving and existing expiry behavior. This is integration evidence for the named subset, not a full audit of every client/property/deal route or every role combination.

Reviewed source includes the changed branches in routes/expenses.ts, routes/finance.ts, routes/deals.ts, lib/financeAutomation.ts, lib/dealReservation.ts, and adjacent payment/date helpers in lib/expenseWorkspace.ts and lib/money.ts. Payment dates are calendar dates stored at UTC midnight via expenseDay; expense accounting month likewise uses UTC midnight, while instant-based sale ranges use the existing Dushanbe helpers. Existing money functions perform cents rounding; BUS-07 retains those functions.

No browser/mobile verification was performed by this specialist; frontend report owns its named checks. Live provider delivery, production data correctness and historical exchange-rate recovery are unverified. The entire codebase and all race schedules are not claimed covered.
