# Report date validation — manual QA 30 October 2026

The ROP report accepted a start date after its end date and described the result as no sales/showings. Manual reproduction used keyboard date input on the synthetic stand (02 November to30October); plain browser fill did not trigger the date control React change and was not used as proof.

A shared reportDateRangeError now guards the resolved API boundaries and both Reports/Sources screens. Invalid/empty ranges disable queries and refresh, hide stale/zero period metrics and show an explicit input error. Current-demand and hot-property sections keep their independent periods. Same-day reports remain valid.

Regression: all three report endpoints returned200before (expected400); after,10API tests pass, including same-day and financial permission cases.19web tests pass, including cached-data suppression and disabled queries on desktop/mobile. No Somon/Paydo features or external sends.

