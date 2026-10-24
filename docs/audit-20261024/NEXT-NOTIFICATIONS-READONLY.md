# Ordinary Notifications — bounded read-only pass

**Confirmed UI candidate NFY01:** a rejected explicit **Прочитать всё** action becomes completely silent. This resembles TU01's missing manual-mutation error presentation and must not automatically be counted as a new independent root-cause family. No application fix is included; investigation stopped after this reproduction and the predeclared controls. No new policy/feature, foreign notification, permission bypass or security scenario was tested.

## Source and evidence layer

Product map `/notifications` → `apps/web/src/pages/Notifications.tsx`. Used stable PHASE2 `5616f8e3e886c500d0eeebf5edda924757620a2d`; relevant files are byte-identical to frozen FINAL2 **8a2d69d0475148611f02cf1751a97585932df482**: Notifications, useNotifications, production queryClient, Toasts and API notification route. SHA256 pairs are retained in the ignored manifest. Notifications `ecd4e5ec07d2525dbab0979be57f13f95a6c27bb913f972786fd6a30e6c3442a`; hook `bdfd2ff04e1c471d2f9085080a8fa1afbd6cdba5867d7e016758ffedd30939cb`.

Actual mounted **full Notifications component**, both existing responsive branches, actual hooks/API parser, **production singleton queryClient/global mutation handlers and actual Toasts host**. No application export/body transform. Synthetic AGENT; installed Chrome **1440×1000 / 390×1000**. Browser Date fixed to24 October for deterministic labels. Fixture supplies AppLayout's desktop screen attribute and MemoryRouter; full surrounding shell/navigation is not mounted.

All HTTP is intercepted: only local synthetic own notifications and empty own pending-client list. One ordinary own CRITICAL record avoids automatic read-many by its existing documented exclusion, allowing the explicit manual action to be isolated. No auto-read policy is changed. No actual API handler, PostgreSQL, provider, push, production configuration or uploaded data executes. No source/default-tests/dependencies/maps/FINAL2 files were changed.

## Reproduction and strict observed result

1. GET returns one own unread critical notification, unreadCount1, no other items.
2. Click actual **Прочитать всё**. Exactly one POST `/api/v1/me/notifications/read-all` is captured. While held, the button is disabled.
3. Synthetic structured400 `{error:"Synthetic manual read rejected"}` arrives. This probes a rejected server response, not an assertion that the actual ordinary route itself naturally emits that400.
4. Actual mutation reaches `status:error` with that exact ApiError message. The button re-enables; notification and unreadCount1 remain. Retaining unread state on rejection is **correct**.
5. Incorrect: there is no inline error or global toast. Actual toast store is empty, complete visible body contains no error, and the production mutation carries `{silent:true}`. The user receives no explanation for the failed explicit action.

Normative browser oracle expects the returned error to become visible; it fails at both widths after the actual mutation settles. It does not demand that rejected notifications become read or fabricate successful persistence. Zero unexpected endpoints, external origins or browser exceptions occurred.

## Root cause and minimal proposed scope

`useNotifications.ts::useMarkAllNotificationsRead` sets `meta:{silent:true}`. `lib/queryClient.ts:121–126` returns early for silent mutations in its **error** handler as well as success. Notifications instantiates markAllRead at212 and invokes it from both manual buttons at454/512, but renders no corresponding mutation error. Its existing MutationError import is used only for a different lead-accept action.

Small proposed correction, subject to coordinator approval: render a local standard MutationError for **markAllRead only** in both responsive branches, with reset/acknowledgment. Preserve successful read's silence, pending guard, API/refetch behavior and read-many automatic policy. Do not globally unsilence every notification mutation, alter when critical/approval items auto-read, or invent a new feature. A durable positive oracle should require error visible, acknowledgment retains unread state, and an intentional subsequent successful manual read clears the unread counter. That latter manual retry is a plan, not executed proof in this pass.

Individual-open error behavior is source-related but not promoted as a second finding: opening may navigate and is explicitly documented as a quiet side effect. No extra variant hunt was performed after confirming the manual action.

## Executed controls and exact accounting

One managed run: **8 cases =2 normative manual-error RED +6 PASS**, native exit **1**, zero skipped/flaky. Controls at each width:

- Empty successful response displays **Новых уведомлений нет.**
- Rejected initial load displays the existing explicit load-error explanation and retry button, and does not claim the feed is empty. Retry recovery itself was not executed.
- Clicking the own notification's actual title/row executes one own ID read POST; delayed success reaches actual query invalidation/refetch, read=true/unreadCount0, and disables the read-all button. There is no foreign target, lead acceptance, navigation destination or real send.

Raw PHASE2 ignored `reports/night-audit-20261024/notifications-readonly/`: fixture/config/spec, `browser.json`, `browser.stderr.log`, `browser.exit.txt`, eight decoded **observed-1.json … observed-8.json**, failed-case traces and `manifest.json`. Each decoded record preserves actual request paths, current synthetic read state, actual query cache, actual mutation state/meta, actual toast store and full rendered body. No harness failures are mixed into this run.

Exact command from PHASE2 root:

```powershell
npx playwright test --config reports/night-audit-20261024/notifications-readonly/playwright.config.ts
```

Managed Vite **5217**, `reuseExistingServer:false`, stopped when the runner completed; port checked absent afterward. No detached helper or rerun/full suite was started.

## Limits and handoff

Ordinary pagination exists in source but was **not executed**, because the pass stopped on the confirmed candidate. Likewise pending initial loading, read-all success/retry, individual-read failure, pinned/page merge, auto-read timer, real database/permissions, physical devices, all notification levels, provider delivery and complete shell navigation remain pending. Earlier map pending status is not silently changed here. Root owns independent acceptance, any fix lease, family attribution and frozen-package/full-run decisions.
