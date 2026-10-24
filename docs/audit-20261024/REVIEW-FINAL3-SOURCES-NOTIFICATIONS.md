# Independent read-only review: FINAL3 Sources and Notifications

**Scoped approval. No new blocking or severity findings in the released changes reviewed below.** Both writers explicitly released their source/tests before this final approval. This reviewer wrote only this MAIN document; no test, build, provider, DB, dependency or source action was repeated.

Baseline: FINAL3 `8a2d69d0475148611f02cf1751a97585932df482`. Review target is the released, uncommitted patch on that baseline, identified by the hashes below; approval does not silently cover subsequent byte changes or an unverified future commit. Candidate reports, both final implementation reports, actual app/test/fixture diffs and retained evidence were read.

## SRC-01: missing Telegram Direct conversation count

The existing `/reports/sources` contract explicitly includes conversations before a client card exists. Telegram Direct uses its own table: its normal handler upserts by chatId/topicId, while TelegramConversation identifies a bot conversation by chatId. Direct's lead path uses source/channel TELEGRAM. The reviewed pre-lead table/handler path does not also create the two conversation-table rows already counted by this report. The handler itself was not executed as part of this review or the report regression.

The application change adds exactly one Prisma count over TelegramDirectConversation with the existing createdAt from/to condition, then adds that count to TELEGRAM alongside existing BotConversation TELEGRAM and ordinary TelegramConversation counts. No client total/closed calculation, closed-deal average, period helper, permission, result sorting, channel enum or other endpoint changes. Database count preserves bounded aggregation instead of loading conversations into memory.

Existing aggregation counts conversation records, not deduplicated people across accounts/bot/Direct. Adding the separate Direct table preserves that existing metric. No new person-deduplication or source-attribution policy is introduced. The direct-only no-client example establishes the omission without requiring a deduplication policy decision. SRC-01 remains one family despite multiple regression variants.

The new five-case actual HTTP/auth/Prisma/PostgreSQL regression was read fully. It compares responses before/after captured own records, covering direct-only input, additive mixed Telegram/Direct/bot counts and independent Instagram, outside-period exclusion, all11 client sources/closed counts, and restoration of the original response after deleting captured conversations. It does not clear global source/channel/period data or assume the worker database is empty. Cleanup uses captured row IDs; the asynchronous initial StageEvent for an explicitly closed own client is awaited before scoped event/client cleanup. Global fetch is a cumulative throwing guard; no provider/Direct handler is imported for execution.

Retained evidence was inspected, not rerun: native RED4FAIL/1control, same-file GREEN5PASS/native0; actual counts are variants of the one missing count. `audit:mocks`0 and corrected explicit TypeScript project0 are separate checks. The first explicit project's missing existing ambient declaration was an ignored config-scope error, not an application failure or source fix. Own DB cleanup0 is the writer's scoped readback, not new reviewer database execution.

## NFY01: local feedback for rejected manual read-all

The global production queryClient correctly suppresses mutations marked silent on both success and error; the existing read-all hook carries silent metadata. The page previously lacked local feedback for its explicit manual action. The released application diff adds only the already imported standard MutationError for markAllRead in each of the two existing responsive branches. Its acknowledgment invokes the standard mutation.reset only.

No hook/API, success silence, pending guard, automatic read-many exclusion, critical/approval handling, permission or notification-read policy changes. In particular, an error/reset must not mark notifications read. The patch preserves this distinction and does not globally unsilence service mutations. NFY01 is attributed as a TU01 manual-feedback variant, not an additional independent root-cause family.

The durable browser fixture uses the full actual Notifications component, actual hooks/parser, **production singleton queryClient/global mutation handlers and actual Toasts**, rather than an isolated fresh cache that would hide the original global behavior. Synthetic own AGENT/CRITICAL input isolates the explicit read-all action under the existing auto-read rule; the full surrounding application shell is not mounted. Fixed Date and loopback managed Vite5217 are appropriate; all transport is intercepted, with unexpected endpoints/external origins/browser errors checked.

The eight-case spec and retained snapshots were inspected. Both widths hold the first manual request pending and verify the button disables, then structured rejection produces an actual error mutation, unreadCount1/read=false, no global toast and a visible local error. Acknowledgment removes the alert, preserves unread state and sends no POST. A deliberate second read-all succeeds; actual invalidation/refetch produces unreadCount0/read=true with the expected two read-all POSTs and no success toast. Empty/load-error/ordinary own-ID-read controls remain distinct. The synthetic400 tests rejected-response presentation; it does not claim that ordinary production read-all naturally returns400.

Retained runtime: normative RED2FAIL/6controls, GREEN8PASS/native0, zero flaky/skip. Ten decoded snapshots are two intermediate rejection records plus eight final observations, **not ten tests**. After runtime, only an erased Window assertion in the spec gained an unknown bridge for explicit TypeScript compatibility. The recorded executed hash and equal emitted-JS hashes in `type-only-runtime-equivalence.json` support keeping the eight-case runtime evidence without an unnecessary rerun; source/runtime/released-spec hashes remain distinguished. Source/regression TypeScript and target lint0 are separate from browser proof.

## Exact reviewed pins and remaining boundary

| Released file | SHA256 |
| --- | --- |
| apps/api/src/routes/reports.ts | `3f88461a1cd62ef215637fdb26310b892eb252758d0e669db49af7ed5ce12412` |
| apps/api/tests/reports-sources-telegram-direct.test.ts | `4eaa2752e150bdcde4f34baa84d0a8311c18eb6fa218e5d7b0cf66e603101ab1` |
| apps/web/src/pages/Notifications.tsx | `dffc06c5f8830d4735838e153accce7cb831a9a2cb5c46f269535ff3f6ee437e` |
| apps/web/tests/e2e/night-notifications.spec.ts, released type-corrected | `804f2fab6474925fdc948bde98fef0733105cdf04f59376cd6b7d58ee1907cbf` |

The executed Notifications spec hash is `545cff770a3832998fa55cfd49c279fc63c59579e6f3dfa4ea35fec956adedda`; the matching app hash above is unchanged. All four released hashes were independently read and matched the writers' evidence. Owned diff check passed during review.

Only reports.ts and Notifications.tsx are changed application paths in this patch. No schema/shared/handler/global-query-client/provider/release/dependency delta or foreign cleanup was found. Source counting and synthetic browser evidence remain distinct; neither proves actual Telegram delivery, real notification persistence, all roles/levels/pagination, complete shell behavior or production activation.

Parent-reported full acceptance of sourceB is a separate source/version. These new FINAL3 API bytes still require their own final frozen commit and complete checks. This approval is not a full-run, merge, ship/deploy or absence-of-all-bugs verdict.
