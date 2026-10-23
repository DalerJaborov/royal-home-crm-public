# Independent frontend baseline validation

24 October 2026, approximately 03:40 Asia/Tashkent. **Three reported frontend defects reproduced against the immutable public baseline, with successful controls; the same regression checks pass against the audit patch.**

- Vulnerable public baseline: `87aecdbcc4a69a3f57ad6de23b4e739ca6c9c3b1`.
- Patched revision: `b20bc69603f66acbbfe31cb3ab9ddc5d32a1f043`.
- Separate retained detached baseline worktree: `D:/PublicWorktrees-20261021/night-audit-20261024-baseline-validation`.
- Raw evidence: `reports/night-audit-20261024/baseline-validation/` (local ignored artifacts), including full logs, explicit `.exit` files, fixture hashes, baseline Playwright traces/error contexts and `manifest-r2.json`.

## Method and isolation

Manual pinned baseline-versus-patched execution following the evidence principles of `post-patch-validation`; **not** a complete run/assessment of that skill's orchestrator. The same five regression fixture/config/test files were copied from the patch into the baseline without copying implementation changes; `fixtures.json` records matching SHA-256 values. Baseline tracked implementation files stayed unchanged. The only changed tracked baseline file is the supplied `apiErrorTexts.test.ts`; the four newly added browser fixture/config/test files are untracked there.

Dependencies resolve through the existing public primary installation. A per-app `@royal-home/shared` junction points to the baseline's own package; `npm run build:shared` built that package successfully (exit 0). Runtime module resolution independently confirmed the baseline's own `packages/shared/dist/index.js`. Node `v24.20.0`, npm `11.19.0`, Playwright `1.62.0`.

Each browser run starts and stops its own Playwright-managed Vite server at `127.0.0.1:5194`, with `reuseExistingServer: false`. Calls were intercepted inside the browser fixture. The old hardcoded agent-stand script was not used. Parent stand on 5305, primary checkout, production, provider sends and databases were not changed.

## Identical supplied regression checks

From each revision's `apps/web` directory:

```text
npx vitest run src/lib/__tests__/apiErrorTexts.test.ts
npx playwright test --config=playwright.night-frontend.config.ts
```

| Check | Baseline | Patch | Actual baseline assertion |
| --- | --- | --- | --- |
| API error text/unknown write outcome | 5 failed, 4 passed; exit 1 | 9 passed; exit 0 | POST/PATCH/PUT/DELETE receive the old definitive failure/repeat instruction instead of unknown-outcome text; lost POST response receives the same misleading text |
| Browser financial form, desktop and mobile | 2 expected failures | Both pass | Pending Cancel remains enabled where the regression requires it to be disabled |
| Browser deferred feed, desktop and mobile | 2 expected failures | Both pass | Requests are `[1,2,3]` while page 2 is still pending, instead of `[1,2]` |
| Actual EditorDashboard, desktop and mobile | 2 expected failures | Both pass | Its pending load-more button remains enabled |
| Browser normal-success controls | 2 passed | Both pass | Actual deal form loads, accepts amounts, submits once and closes after confirmed success |
| Complete supplied browser file | 6 failed, 2 passed; exit 1 | 8 passed; exit 0 | All failures reached the stated UI/request assertions, rather than failing imports/build/server setup |

Raw logs: `base-api.log`, `patched-api.log`, `base-browser.log`, `patched-browser.log`. The four API controls preserve unrelated GET error handling, unrelated error identity and retry-after messaging. The method-parameterized baseline cases stop at their first TypeError assertion, so this execution alone does not separately demonstrate their subsequent timeout assertion.

## Additional direct behavior probes

The supplied form/editor regressions stop on enabled controls before performing the consequential action. Two additional reviewable probes live only under the ignored evidence folder (`direct-probes.spec.ts` and `.config.ts`); their bytes are identical for both revisions and they execute the actual application components through the same fixture/server.

```text
npx playwright test --config=D:/PublicWorktrees-20261021/night-audit-20261024/reports/night-audit-20261024/baseline-validation/direct-probes.config.ts
```

- **Financial form:** after the save request is demonstrably pending, actually press Escape. Baseline removes the dialog and fails the visible-dialog assertion; the patch keeps it visible and subsequently displays the injected definite rejection.
- **Editor queue:** delay page 2, actually issue a second native button click, then fulfill page 2. Baseline loses page 2 from the displayed list and fails the visible-row assertion; the patch retains the page and never requests page 3 prematurely.

Both probes use the mobile viewport, print `PPV_REACHED` immediately before the decisive assertion, and reach it on both revisions. Baseline **2 failed, exit 1**; patch **2 passed, exit 0**. Raw logs are `base-direct-probes.log` and `patched-direct-probes.log`; baseline error contexts were retained separately before the patch run.

## Interpretation and limits

The failures are attributable to the tested application behavior: shared compilation succeeds, fixtures load, normal-success controls succeed on both revisions, and baseline logs contain the specific wrong returned text, extra request or missing DOM element. They are not evidence inferred solely from nonzero exit codes. All three original frontend mechanisms therefore have retained baseline-versus-patched runtime evidence.

This validates the scoped fixes using transport mocks and real Chrome component execution. It does not validate authentication/IDOR, PostgreSQL side effects, provider delivery, all sibling screens, physical touch gestures, failed-page recovery, full application coverage or production installation. This manual run does not claim the full skill's side-blind runner, all mandatory security/variant/behavior categories, exhaustive patch acceptance or absence of other bugs. Source review and broader suites remain separate evidence layers in the parent audit.
