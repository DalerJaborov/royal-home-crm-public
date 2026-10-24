# Ordinary Profile personal details — bounded read-only pass

**No new confirmed defect in the executed scope.** This adds personal-detail component behavior to the earlier eight-role Profile navigation smoke; it does not approve the complete Profile page or every role. No application/default-test/dependency/map/FINAL files changed, no API/DB/provider/upload/production execution, and no password/2FA/security/privacy work.

## Source identity and actual mounting

Used stable PHASE2 runtime `5616f8e3e886c500d0eeebf5edda924757620a2d`; before mounting, compared with frozen FINAL `4897ef97b3a935d69dff8e1610dbe77f79375430`. Actual Profile, useMe, meCache, useServerSyncedForm, API me route and shared schema bytes are identical. Full SHA256 pairs are in ignored `reports/night-audit-20261024/profile-details-readonly/manifest.json`. Profile: `d3e6aaf757261766e05e11ef1e062b94978f2378a948adfc7ca767db93a92633`; useMe: `b6945249ed35fe8da525836cb6ffcada7f46e394cea650de096cdcee632b4efc`.

Product map `/profile` → `apps/web/src/pages/Profile.tsx`. Actual private `PersonalInfoSection` is shared by the desktop/mobile Profile compositions. The ignored Vite plugin **only appends `export { PersonalInfoSection }`** to the module served to the fixture; its function body and all app files remain unchanged. The fixture mounts that actual section, actual useMyProfile/useUpdateMyProfile, QueryClient, auth store and transport parser, with the application's CSS and mobile flag. This is **instrumented section evidence, not the full Profile page/shell or mobile composition**. Other Profile/security/session components are not mounted or interacted with. No standalone copy of the form or replacement form-sync hook is used.

Synthetic actor role **AGENT**. Actual installed Chrome, **1440×1000** and **390×1000**. Only intercepted GET/PATCH `/api/v1/me`; the phone stays unchanged in every write. Unknown endpoints and all non-loopback origins are recorded and rejected. No unexpected endpoints, external origins or browser exceptions occurred in the eight usable observations. Managed Vite **5216** stopped after both runs; no detached server remains.

## Executed cases, once per width

| Scenario | Actual browser result | Scope of proof |
|---|---|---|
| Initial optional email null | The actual GET response's `email:null` renders as an empty optional email field; name/unchanged phone populate. | Included in six initial cases, not a full loading/error-state matrix. |
| Empty name | Ordinary Save sends the empty draft once. Actual compiled `meUpdateSchema` rejects it; intercepted response mirrors route400 `Неверные данные`. Visible error, empty name and entered valid email remain. | Correct rejected-save UI; real API/PG validation was not executed. Lack of duplicate frontend minimum-length validation is not counted as a bug. |
| Invalid email | Enter invalid-address and click actual Save. Native form validation blocks the request, preserves input and exposes `validity.typeMismatch=true`. | Actual button/native form behavior, not an isolated checkValidity call or schema-only test. |
| Valid input, server failure | Enter spaced valid name and valid email; submit one PATCH. While the response is held, **Сохранение** is disabled. Structured500 text becomes visible, exact draft remains, Save re-enables and no false Saved status appears. | Actual mutation rejection lifecycle with synthetic transport. No ambiguous lost-write/network outcome is simulated. |
| Pending then success, clear optional email | Start from nonempty stored email; clear it, submit unchanged phone and spaced valid name. Pending button disables. Response uses actual route's partial profile shape; actual shared parser trims stored name, empty email maps to null. Saved status appears, auth/cache contain canonical name/null email, existing permissions survive the partial-cache merge; Save re-enables. | Actual component/hooks/cache merge/refetch. Synthetic server uses actual shared schema and mirrors the read route; no real persistence claim. |

Raw request JSON, entered draft, synthetic current profile, actual query-cache/auth state, visible body and unexpected/external/error arrays are retained in decoded **observed-1.json … observed-8.json**. The six original passing controls were not rerun without a new reason.

## Rejected oracle and exact execution accounting

Initial `browser.json` / `browser.exit.txt`: native **1**, **6 PASS + 2 failed success assertions**, zero skipped/flaky. The two failed assertions demanded that the response's trimmed name immediately replace the input's surrounding spaces. Actual input retained the submitted spaces. This was an **overstrict test expectation**, not established data loss or a product contract violation: shared staffNameSchema intentionally trims the stored value, while the existing form-sync behavior can retain editable input. No requirement was found mandating immediate cosmetic normalization of that input after saving.

Only the two success controls were corrected to check exact submitted draft plus canonical cache/auth result; they also start from a nonempty email to verify explicit clearing. `success-controls.json` / `success-controls.exit.txt`: native **0**, **2 PASS**, zero skipped/flaky. This gives eight usable distinct scenario/width observations, **not an eight-test single green run**. Original failure logs remain separate and are not reported as baseline CRM RED evidence. No source fix was made to make a test pass.

Exact current ignored harness command, from PHASE2 root:

```powershell
npx playwright test --config reports/night-audit-20261024/profile-details-readonly/playwright.config.ts
```

The final two-case command additionally used `--grep 'pending-success'`. Existing runtime/dependencies only; no builds, full suites or default-test edits. Fixture, transform, specs, raw JSON/stderr/native exits, decoded observations and identity manifest remain under PHASE2 ignored `reports/night-audit-20261024/profile-details-readonly/`.

## Remaining limits

This pass deliberately leaves phone changes and step-up flow, all security/session/password/2FA controls, avatars/uploads, providers, permissions/read-only roles, real persistence, production and physical devices unverified. It does not repeat the general settings form-sync rollback tests or establish all first-load/refetch/newer-edit transitions. The ordinary section's successful name/email change and expected failures are checked; broader Profile workflow acceptance remains pending. No source remediation plan is proposed because no new concrete defect was confirmed.
