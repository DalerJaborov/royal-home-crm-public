# Frontend audit: retained findings and evidence

Updated 24 October 2026, approximately 03:30 Asia/Tashkent. Source-only audit worktree `night-audit-20261024`; no production writes or deployment.

## Findings fixed

### FRONT-01: network failure after a write falsely claimed that nothing was saved

- Reproduction: let a POST reach its handler and persist the supplied body, then lose its response (`TypeError: Failed to fetch`). The previous shared transport text said the change was not saved and instructed the user to repeat it. The same misleading outcome existed on a write timeout.
- Expected: distinguish an unknown result from a confirmed rejected write; ask the user to check the result before repeating it.
- Cause: `networkFailureError` inferred the server's write outcome from a transport failure.
- Fix: write failures/timeouts now say that the result could not be confirmed and ask the user to check whether the change applied. GET connectivity messaging remains unchanged. No retry or write policy changed.
- Regression: `apiErrorTexts.test.ts` exercises POST/PATCH/PUT/DELETE and a mocked transport that persists a body before throwing. This proves error semantics in a mock, not provider delivery or a real database write.

### FRONT-02: a pending financial form could be dismissed while its mutation continued

- Reproduction: enter sale price and both commission amounts in the deal completion form; submit while the response is delayed; cancel or press Escape. Previously the form could close while the in-flight write continued, losing entered values if the server later rejected it.
- Expected: retain the form and submitted values until the request resolves; show a definite error in the same form; allow dismissal after rejection and normal closure after success.
- Cause: the submit button respected `busy`, but sheet dismissal and cancellation did not; writable inputs could also diverge from the submitted snapshot.
- Fix: synchronous pending guard prevents another submit/cancel; the busy sheet is nondismissible, its cancel button and amount inputs are disabled, and a definite rejection preserves values and restores controls.
- Regression: real Chrome executes the actual `DealSubmitModal` and `Rh2Sheet` with intercepted fixture responses at 1440x1000 and 390x844. Delayed rejection preserves all three amounts after Escape, restores cancellation and shows the error. Success closes once. This is component browser evidence, not a live deal completion or physical-device gesture check.

### FRONT-03: rapid load-more taps could skip the pending page

- Reproduction: page 1 contains 50 rows, total 150; delay page 2 and tap load more again. Lists whose pager uses requested state instead of the completed response could move to page 3, unsubscribe from page 2, and leave its rows missing.
- Expected: keep page 2 subscribed until its response arrives; append it before requesting page 3.
- Cause: `Pagination` had no pending state and several callers retained prior page metadata/head data while incrementing their requested page immediately.
- Fix: add optional `loading` to load-more Pagination and disable it while the current query fetches. Expose `isFetching` from the shared deferred/lost feed. Wire the relevant state-page consumers listed below; classic and rh2 pagination behavior remains unchanged.
- Regression: Chrome uses the real deferred hook/accumulation/Pagination and separately the complete actual `EditorDashboard`. Intercepted API page 2 stays pending, an additional native button click does not request page 3, page 2 remains present when fulfilled, and a later click successfully appends page 3. Both run at desktop/mobile widths.

## Consumer inspection for FRONT-03

Inspection covered all source `<Pagination>` call sites, following requested page state, response page metadata, retained placeholder/head data and next-page handler. This is source inspection of this mechanism, not full screen coverage.

| Consumers | Result |
| --- | --- |
| Clients desktop/mobile; DeferredClients desktop/mobile; LostClients desktop/mobile; MobileInquiries | Pending query wired to shared Pagination; deferred hook exercised in browser |
| Archive: property trash, client trash, sold properties, archived clients, audit log | All five explicit state-page consumers wired to their own query's `isFetching` |
| Pipeline: moderation and both editor queues | All three explicit state-page consumers wired |
| EditorDashboard: editing and upcoming | Both use the combined editor query's pending state; actual dashboard exercised in browser |
| MarketingCenter: queue and recently published | Both explicit state-page consumers wired |
| SiteChanges; AgencyTab landmarks | Explicit state-page consumers wired |
| Activity; Comments | Query pending state wired, including existing response-page usage |
| Calls desktop/mobile; Messages/MobileChatsList; Properties/MobilePropertiesList | Existing pager advances from the response's page number, so repeated pending clicks request the same next page; no state-page jump mechanism found in inspected source |
| Oversight | Existing pager only uses current query data, which is absent during a new-page load; its hooks have no retained placeholder data |
| Vacancies | Existing infinite-query handler explicitly checks `!isFetchingNextPage` |
| SystemTab error log | `pages` advances only after load-more fulfills; repeated pending clicks target the same page |
| Ads; SecurityCenter; FunnelTab/MobileFunnel; SystemTab assistant audit | Non-load-more callers; new optional prop does not alter their behavior |

## Verification retained locally

- `reports/night-audit-20261024/frontend-browser-green.log`: **8 passed**, Chrome, 1440px and 390px; fixture API only. Final suite includes two actual EditorDashboard cases. Its first authoring run failed only because its first row also appeared in a recommendation card; the locator was corrected before the final green run.
- `frontend-focused-green.log`: **66 passed in 6 files**: API error texts, timeout, session race, cooldown, page accumulation and retained pagination data.
- `frontend-typecheck.log`: `npx tsc -b --pretty false`, exit 0.
- `frontend-eslint.log`: ESLint on the 20 changed source/test paths, exit 0.
- `git diff --check -- apps/web`: exit 0.
- Interrupted earlier audit phase reported red reproductions for deal dismissal and page skipping. Their original raw red logs were not recovered by this continuation; do not count that statement as independently retained baseline-vs-patched log evidence.

## Limits and next work

These tests use fake records and intercepted responses, without authentication or database/provider side effects. They do not prove role authorization, all field validators, every affected full-page flow, real PostgreSQL behavior, real mobile gestures, deployment or production acceptance. Full web suite/build/map/precheck integration belongs to the parent audit package. No new claim of complete frontend coverage or absence of bugs is made. Failed-page recovery, cache refetch ordering and real authenticated role navigation remain separate unverified scenarios for this frontend pass.
