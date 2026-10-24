# NFY01 — show an explicit notification read-all failure

NFY01 is an accepted **variant of TU01's missing manual-mutation feedback family**, not an additional independent defect-family count. On base `8a2d69d0475148611f02cf1751a97585932df482`, a rejected **Прочитать всё** action preserved the unread state correctly but showed no explanation: the shared global mutation handler respects `meta.silent`, and this page had no local error renderer.

Only two application lines were added to `apps/web/src/pages/Notifications.tsx`: the existing `MutationError` for `markAllRead`, variant `rh2`, with localized fallback, once in each existing responsive branch. Existing import reused. No hook, API, silent metadata, automatic reading, successful-read feedback, pending control, permissions, notification-level policy or data schema changed. Acknowledgment only resets the mutation error.

## Durable actual browser regression

Tracked files: `apps/web/playwright.night-notifications.config.ts`, `tests/e2e/night-notifications.spec.ts`, `tests/fixtures/night-notifications.html/.tsx`. Actual **full Notifications component**, actual hooks/API parser, production singleton queryClient/global mutation handlers and actual Toasts host. No export/body instrumentation. Synthetic **AGENT**, own CRITICAL record, Chrome **1440×1000 /390×1000**. Fixed browser Date prevents relative-label drift. Full surrounding shell is not mounted; fixture supplies its desktop screen attribute and MemoryRouter.

All transport is intercepted, unexpected endpoints and non-loopback origins are rejected. No API handler, database, provider/send, upload, paid generation, production config or foreign notification is executed. The critical record's existing exclusion from automatic read-many isolates the explicit manual action without altering policy.

From FINAL3 `apps/web`:

```powershell
npx playwright test --config playwright.night-notifications.config.ts --reporter=json
```

- **Before app edit:** same durable eight cases, native **1**, **2 normative RED +6 passing controls**, zero skipped/flaky. Both REDs require the server's actual mutation error text inside `role=alert`; no alert existed. Baseline page SHA256 `ecd4e5ec07d2525dbab0979be57f13f95a6c27bb913f972786fd6a30e6c3442a`. Requests/error state/correct unread retention captured before the failing oracle, and RED traces copied before the next run.
- **After the two render additions:** identical eight cases, native **0**, **8 PASS**, zero skipped/flaky/unexpected, external origins or browser exceptions. Both manual cases verify held request disables button; structured rejection reaches actual mutation error and visible local alert; unreadCount1/read=false and no global toast remain; **Понятно** removes only the error, keeps unread state and sends no request; deliberate retry succeeds and actual invalidation/refetch yields unreadCount0/read=true and disables the read-all button. Retry assertions are inside those two existing cases: still **eight cases, not ten**.
- Six neighboring controls, once per width: successful empty state; failed initial load distinctly explained with retry button and no false-empty message; ordinary own title/row click sends one ID-specific read and success updates actual unread state through refetch. The route's natural production400 incidence is not claimed: synthetic structured400 tests rejected-response UI behavior.

Raw ignored FINAL3 `reports/night-audit-20261024/notifications-final/`: `red.json`, native exit/stderr, two decoded `red-rejected-*.json`, preserved `red-browser-results/`; `green.json`, exit/stderr, **10 decoded `green-observation-*.json`** (two rejected snapshots plus eight final observations), and `manifest.json`. Each captures requests, actual cache/mutation metadata, toast store, full body and error/egress arrays. Parent retains the earlier PHASE2 discovery separately in MAIN `NEXT-NOTIFICATIONS-READONLY.md`.

## Proportionate checks and handoff

Before app edit, `where --file` and impact checks both native **0**, logs retained. Targeted ESLint native **0** for page/new fixture/spec/config. Source TypeScript check native **0**; explicit browser fixture/spec/config project initially exited **2** because the new Window→ProbeWindow assertion needed an `unknown` bridge, then corrected check `typecheck-regression-r2` exited **0**. This introduced harness typing correction changes only an erased TypeScript assertion; application source remains unchanged. The original typed-error log is retained, not called a CRM failure. No browser repeat was needed: `type-only-runtime-equivalence.json` verifies the reconstructed executed-spec hash matches the recorded original and TypeScript emits **identical executable JS** before/after the correction. No broad tests, dependency changes, map regeneration, commit, push, merge or deploy by this writer.

Application SHA256 `dffc06c5f8830d4735838e153accce7cb831a9a2cb5c46f269535ff3f6ee437e`; executed spec `545cff770a3832998fa55cfd49c279fc63c59579e6f3dfa4ea35fec956adedda`, released type-corrected spec `804f2fab6474925fdc948bde98fef0733105cdf04f59376cd6b7d58ee1907cbf`. Original `manifest.json` and follow-up `manifest-release.json` distinguish those bytes. Managed Vite **5217** is stopped; `reuseExistingServer:false`. Source B in FINAL2 remains untouched. Parent owns independent review, package freeze/build/source checks and final release decisions.

No individual-open failure, pagination, timer, all levels/roles, actual persistence, complete shell navigation, physical device or real provider acceptance is inferred. No further candidate search was performed in this lease.
