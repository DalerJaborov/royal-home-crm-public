# Other inquiries — bounded ordinary UI pass

**No new confirmed defect in the executed scope.** This pass adds named evidence for `/other-inquiries`; it does not approve the entire route or ClientDetail. No app/default-test/dependency/map/frozen FINAL3 edits, API/DB/provider/send/call/AI/production execution or permission-policy changes.

## Actual route and role contract

`App.tsx:430` mounts `<Clients kind="OTHER" />`; there is no separate OtherInquiries page. Actual `Clients` chooses legacy `MobileInquiries` only for an AGENT on a narrow screen with the existing legacy shell. ADMIN uses `ClientsList` at both tested widths. `otherInquiries.view` is the established gate: resolved ADMIN preset includes it; normal resolved AGENT preset does not. The normal blocked message **Раздел доступен руководству.** is correct behavior, not a bug. No extra AGENT permission was fabricated to force the mobile list branch.

The list explicitly treats OTHER as externally received/unassigned inquiries, hides its create-client workflow, and provides ordinary row navigation. This pass therefore did not invent an expected create/edit/draft-save control. Calling controls were not used. Existing search-across-kinds policy is explicitly documented in source; no unexpected cross-kind policy claim is made and search was not executed here.

## Source identity and runtime

Stable PHASE2 `5616f8e3e886c500d0eeebf5edda924757620a2d` was used, with seven relevant files compared byte-for-byte to frozen C **f6a9076dd831d64db86a807bbb145f26aee68af6**: Clients, MobileInquiries, useClients, useClientRowActions, useLegacyAgentMobile, production queryClient and shared permissions. All identical. SHA pairs: PHASE2 ignored `reports/night-audit-20261024/other-inquiries-readonly/manifest.json`.

Actual mounted `Clients(kind OTHER)`, actual hooks, actual production singleton queryClient and Toasts; actual ADMIN/AGENT preset resolution from the existing compiled shared package. Chrome **1440×1000 /390×1000**, fixed browser Date. No app export/body transform. Fixture supplies MemoryRouter and desktop screen attribute. For ADMIN mobile controls it hosts the actual React action nodes from `useShellStore.actions`; it does not copy their handlers. This is **not full AppLayout/mobile shell acceptance**.

Transport is synthetic and intercepted. ADMIN row is an unassigned synthetic OTHER inquiry, consistent with this list's contract, with no phone to trigger calls. Supporting own fixture responses are provided for districts/agents/duplicates/UI shell; the ordinary section-seen counter POST is also intercepted. Non-loopback requests and unexpected API endpoints are rejected. No real client record or server mutation is involved.

## Executed cases, once per width

| Case | Actual observation | Limit |
|---|---|---|
| ADMIN empty response | Correct **Прочих обращений пока нет.** appears; initial list request sends kind=OTHER and default created_desc order. | Not all empty-filter variants or initial pending states. |
| ADMIN failed list load | Structured synthetic400 produces **Список не загрузился.** and visible **Попробовать снова**, without a false empty-state message. | Actual query/parser/UI, not natural API400 incidence or retry recovery. |
| ADMIN ordinary filter and open | Open actual filter button/sheet, select **Новый**, observe request kind=OTHER/status=NEW/page1, close with **Показать**, then click actual accessible row link. Router reaches the fixture's client-detail destination; source constructs `/clients/42` for this row. | Request construction and list navigation only; exact destination parameter is not separately asserted. Server filtering is synthetic; ClientDetail body/API is deliberately not mounted or accepted. |
| AGENT normal role gate | Existing management-only message at1440 and actual legacy MobileInquiries branch at390. No `/clients` request is issued in either case. | UI gate only; no server permission/exploitation test. No allowed MobileInquiries list workflow was forced. |

Across the eight usable observations: zero unexpected endpoints, external origins or browser exceptions. No unrelated mutation, call, provider or paid operation is executed. Query cache status/errors, body and exact list query JSON are retained in decoded **observed-1.json … observed-8.json**.

## Exact accounting and harness correction

Initial `browser.json` / native **1**: **6 PASS +2 harness failures**, zero skipped/flaky. The two filter/open setups used the wrong accessible name for the real row link (`Synthetic Other`); the component correctly supplies **Открыть карточку: Synthetic Other**. These are locator errors, not baseline CRM RED evidence.

Only those two ignored locators were corrected. `filter-controls.json` / native **0**: **2 PASS**, zero skipped/flaky; unchanged successful six cases were not rerun. This is **six initial passes plus two corrected passes**, not an eight-case single green run. No app change was made to satisfy an assertion.

Exact current ignored harness command, from PHASE2 root:

```powershell
npx playwright test --config reports/night-audit-20261024/other-inquiries-readonly/playwright.config.ts
```

The second command used `--grep 'filter-open'`. Fixture/config/spec, raw JSON/stderr/native exits, decoded observations and identity manifest remain under PHASE2 ignored `reports/night-audit-20261024/other-inquiries-readonly/`. Managed Vite **5218**, `reuseExistingServer:false`, stopped with the runner; port checked absent. No detached server, builds, full suite, dependency edit or rerun of completed families.

## Remaining work

Loading/pending and retry recovery, search/reset/cancel combinations, actual filtered record sets, pagination, detailed inquiry editing/state transitions, provider/call actions, other management roles, mobile full-shell behavior, real API/PostgreSQL enforcement, physical devices and production remain pending. A local draft/save failure is not claimed tested because this ordinary listing exposes no create/edit form. No fix plan is proposed: the executed ordinary list/filter/navigation and legitimate gate controls produced no concrete new contradiction.
