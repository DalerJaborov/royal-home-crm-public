# Additional settings audit (read-only)

Source inspected: main audit `0466aca29e9090e046e8affdf93760c9224144bd`. Selected phase 2 files have identical SHA-256 to main (retained manifest). Scope: settings navigation and Agency/Leads/Team/SMS save forms, restore UI, and selected System audit date fields. Recruitment/import/deal forms excluded. No application/test/dependency edits, builds, database operations, production settings, provider requests, calls or SMS.

## Finding S-READ-01: failed settings save can erase the submitted draft

**Evidence level: source + executed actual mutation callbacks/cache/helper protocol + mounted actual CompanySection in Chrome at1440px and390px.**

Reproduction: saved company name A; edit it to B; submit; let the optimistic cache update render before the failed PATCH. `useUpdateSettings.onMutate` puts B into the settings cache. `useServerSyncedForm` records this as `lastServer=B`. Actual `onError` restores cache A. The refill helper then sees local B equal previous B, interprets A as a server change to an untouched field, and returns `{name:A}`. The submitted draft is lost. Expected: preserve B after rejection and show the existing error, allowing correction/retry. This directly contradicts the shared form helper's documented draft-preservation contract.

Source: `apps/web/src/hooks/useSettings.ts:735` (optimistic write at749, rollback at755); `hooks/useServerSyncedForm.ts:29` (effect advances baseline); `lib/serverFormSync.ts:44` (dirty test); `pages/settings/AgencyTab.tsx:43` and55 (consumer and submit). Leads and Team working-hour forms use the same mechanism; those consumer variants have source tracing, not mounted reproductions.

The ignored probe extracts and transpiles the actual `useUpdateSettings` function, uses real TanStack `QueryClient` and `MutationObserver`, and calls the actual imported refill helper. The transport is one deliberately rejected synthetic in-memory request, delayed20ms. A query-cache subscriber models a committed optimistic render, explicitly not React scheduling. Output: `transportCalls=1`, `failedDraftPreserved=false`, final local A. Native probe exit1 is the expected failed preservation assertion. Ordinary unrelated server-field refresh control preserves dirty name B and updates the untouched slogan. This distinguishes the bug from a generally broken dirty-field helper.

Potential fix constraints, **no implementation here**:

- Preserve existing optimistic toggle feedback and cancellation of in-flight settings reads.
- Successful canonical response C should replace submitted B when that input has not changed since submission; a newer edit D must survive.
- Merely deleting optimism is insufficient: helper control with confirmed baseline A, current submitted B and response C produces no refill, losing canonical success behavior. Existing optimistic baseline B correctly permits C, while a newer D stays untouched.
- A narrow provenance-aware save-form path can distinguish optimistic submitted values, confirmed success, and rollback. Alternatively, opt out of optimism only for explicit save forms and explicitly accept canonical success only for fields still equal to their submitted draft. This needs mounted controls before choosing scope. No global cache/refill policy change is authorized by this report.

## Loading, empty/null and restore observations

- Company and SMS sender inputs remain editable before initial GET; first-load helper intentionally overwrites all values. Pure helper execution replaces `Typed before GET` with stored A. This is a **source-supported conditional first-load loss candidate**, not a mounted UI finding. Leads has explicit loading/error gating. Team distribution time inputs have no initial-data disable; save-before-load submits invalid empty time strings, rejected by API, rather than persisting arbitrary defaults.
- Actual settings schema literal probes: empty numeric input becomes0. Threshold0 is valid; shown-window days, action TTL, occupancy delay, reactivation days and batch size reject0. Empty company name rejects; empty slogan accepts. Accepted0 alone is not a bug: the displayed policy allows disabling the threshold. No invented requirement that all numeric fields must be required.
- Actual shared agent update schema accepts null SIP extension, null whisper language, null Instagram username, and empty weekly-days-off array. Team profile submits exactly these clearing values, retains state on catch, and closes only after success. No null/undefined clearing defect confirmed.
- SMS has separate non-optimistic settings mutation. Save catches failure without clearing sender; token editor clears entered secret only after successful save. Global mutation error toast means the clear handler's empty local catch is not proof that errors are hidden. No providers invoked.
- Restore UI shows source success/failed state and invalidates settings on success. Existing dirty forms may retain local drafts across restored server values, consistent with the dirty-preservation rule. Whether restore should explicitly discard them is an unresolved product policy, not counted as a bug. Restore API/DB behavior was not executed.
- Settings page requires `settings.view`; general settings PATCH requires `settings.manage` and elevation. This is source tracing only, not fresh ordinary/admin browser or authorization execution.
- System assistant-audit date fields omit empty values from query and send selected YYYY-MM-DD unchanged. API parses shared date-range schema and passes `to` into `createdAt.lte`. The shared schema comment expects routes to extend selected end date to end-of-day. Potential end-day exclusion is recorded for follow-up; no DB/browser proof or date-related fix in this pass.

## Retained evidence and limits

Phase 2 ignored evidence: `reports/night-audit-20261024/settings-readonly/probe.mts`, `results.json`, `probe.log`, `probe.exit`, `source-hashes.json`. `probe-r1-harness.log` preserves the discarded initial harness error (schema extraction initially matched a non-schema property); corrected extraction requires `z.`. That failed harness run is not bug evidence.

Runtime: Node v24.20.0, Zod4.6.7, TypeScript5.9.3, TanStack query-core5.101.2, after parent's explicit updated dependency readiness. Hook extracted-content SHA256 `33debcf23a9c503be0c25d64bbe3cb7fe6723cfe5a5c2216be17023d4c9dcd3d`. No test suite or build rerun; parent owns package verification.

Reviewed: `apps/web/src/pages/Settings.tsx`; settings `AgencyTab.tsx` company, `LeadsTab.tsx`, `TeamTab.tsx` profile/distribution, `SmsSection.tsx`, `RestorePointsSection.tsx`, selected `SystemTab.tsx` audit; hooks `useSettings.ts`, `useSms.ts`, `useServerSyncedForm.ts`; lib `serverFormSync.ts`, `queryClient.ts`; components `SettingsRows.tsx`, `SecretKeyEditor.tsx`; selected API `settings.ts`, `sms.ts`, `agents.ts`, `ai.ts` and shared agent/query schemas. Reading these is not full module coverage.

Unverified: real backend400/403/network failure variants (browser used intercepted HTTP400), ordinary/admin backend authorization, full Settings page/navigation, restoration against isolated PostgreSQL. Component input behavior has actual Chrome1440/390 proof; this is not full responsive visual coverage. One confirmed component defect and conditional source candidates are deliberately separated.

## Mounted confirmation after parent reopened the source gate

Parent explicitly authorized an ignored fixture and Playwright-managed Vite5199 after precheck ended. Fixtures/config/spec live only under the ignored phase2 reports directory. Actual `CompanySection`, `useSettings`, `useUpdateSettings`, `useServerSyncedFields` and React Query provider were mounted; only GET/PATCH transport was intercepted. No DB/provider calls. Every request outside the expected settings seam would fail the harness. Test waits for optimistic cacheB and two browser animation frames before releasing the response.

Command from phase2 root: `npx playwright test --config reports/night-audit-20261024/settings-readonly/playwright.config.ts`. Native exit1: **2 failed /4 passed,6 total**. At each width1440 and390:

- RED failed PATCH400: expected submitted nameB, actual saved nameA. Exactly one PATCH. Both assertions reach the user-facing input; retained traces/error-context show the erased draft. The synthetic rejection creates the existing unhandled submit promise ApiError; no infrastructure error caused these failures.
- GREEN successful canonical response: submittedB becomes canonicalC.
- GREEN edit while request pending: newer draftD survives canonical responseC.

Evidence: `mounted.log`, `mounted.exit`, `mounted.spec.ts`, `fixture.html`, `fixture.tsx`, `vite.config.ts`, `playwright.config.ts`, and `browser-results/` traces and per-case actual-result attachments. `mounted-r1-harness.log` is a discarded startup failure: plugin-react is nested under apps/web/node_modules after dependency update; ignored Vite config corrected to that real installed location. It is not bug evidence. Vite8.3.5/plugin-react6.1.1. Managed webServer lifecycle completed; no detached helper was started.

No source fix accepted or implemented in this pass. Suggested explicit-form optout still requires a submitted-draft-aware canonical-success adapter and all affected consumer review; default optimistic toggle behavior must remain. Mounted baseline controls establish both canonical success and newer-edit behavior that a fix must preserve.
