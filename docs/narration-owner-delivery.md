# Versioned narration and monthly owner-report delivery

Default is PREVIEW. No database migration activates deliveries or converts old draft rows into consent.

Deployment-only gates (absent means PREVIEW): `CRM_NARRATION_EXECUTION_MODE=LIVE` and `CRM_OWNER_REPORT_EXECUTION_MODE=LIVE`. They have no activation UI. This implementation session did not activate them or contact providers.

## Narration

Existing montage settings choose the active EDITOR and connected Telegram; the property must already hold the existing montage queue slot (SENT_TO_EDITOR, not a manual side job). Preparation reuses `buildMontajerDelivery` and stores a version/facts/recipient/source manifest. A separate explicit queue confirmation checks its fingerprint under the property lock. PREVIEW rows are never drained automatically. Audio, complete script document and optionally source files each obtain their own Telegram receipt. Source files exceeding configured Telegram size or unavailable locally block the remaining batch; there is no public download fallback.

No repeated network attempt follows an ambiguous result. Network/DB receipt loss becomes UNKNOWN; a crash becomes UNKNOWN after the bounded batch budget. AD-only manual reconciliation records actor/time/note in AuditLog and preserves prior receipts. It neither refunds a provider nor invokes it. The original montage queue assignment and regular redelivery pipeline are unchanged; narration does not mark original source-video delivery flags or reassign the editor queue.

## Owner reports

Explicit staff-recorded consent binds the current property owner and execution mode; repeat identical consent is idempotent, changes increment revision, and revocation is recorded in AuditLog. Historical preview requests are not imported as consent. Merge revokes the old subscription (integration in clientMerge).

Scheduler creates only the current Dushanbe calendar month, unique per property/owner/period. A PREVIEW subscription remains PREVIEW after a server gate changes. A future LIVE subscription requires a fresh explicit staff consent action after server activation. Existing monthly rows are never promoted/replaced or resent.

Before SMS dispatch, a short preflight transaction verifies consent revision, current owner, full-number HMAC, active report link, content fingerprint and current month. Payom is called through the existing SMS journal with receipt details requested. DRY_RUN stays PREVIEW; provider acceptance with an ID is SENT, not proof of receipt by a person. Current webhook status is read from the corresponding SmsMessage to show DELIVERED/NOT_DELIVERED without rewriting historical ledger evidence. The report URL opens the existing dynamic owner report; this is monthly delivery frequency, not a frozen monthly-statistics export.

## Verification boundary

Mocked transports only; no real Telegram/SMS calls, paid ElevenLabs calls, production edits, or activation. Pure/mocked route suites cover stale data, denied roles, preview gates, receipts, refusal/unknown/dry-run, claim races and reconciliation. PostgreSQL lock ordering/concurrency and real-provider acceptance remain separate rollout checks. External I/O occurs after short preflight transactions commit. Revocation stops subsequent dispatches but cannot recall a request already in flight. Late receipts are appended without undoing manual reconciliation.
