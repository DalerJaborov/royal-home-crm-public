# 04.11.2026 — Disabled assistant groups reject old action buttons

Previously `/assistant_off` stopped new group requests but an author could still
confirm or cancel a previously sent action card. Group and supergroup callbacks
now re-read the registration after the existing author/global-enabled/fresh-access
checks and after waiting for the bundle lock, before reaching either broker operation.
A missing registration or database
read failure prevents execution. Private callbacks retain their existing path.

Cards created before (or at the same timestamp as) the current group registration
are rejected, so disabling and re-enabling does not revive old cards. Repeating
`/assistant_on` for an enabled group preserves its registration timestamp and valid
cards. This does not cancel an operation already admitted before disable, nor does
the timestamp bind a card to its original chat; those are different guarantees.
Preparing the same request can reuse a pending row for up to its ten-minute expiry.
The rejection therefore states the remaining rounded-up wait; expired rows ask for
a new request without adding a delay. Broker idempotency and shared pending rows
are not changed or cancelled by this group check.

Validation: actual handler fixtures reproduce disabled-group, database-failure and
re-enable failures before the patch; group/supergroup, private compatibility,
author/active/global checks and same-timestamp behavior are covered without sends,
AI calls or database writes. Existing integration fixtures now include Telegram's
real callback chat type. Full PostgreSQL/cloud validation and live release remain
separate checks; no real action was submitted during this review.
