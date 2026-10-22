# Legacy physical delivery foundation

The existing bot could start a provider request outside a future controller
switch's idle check. A later retry also needs the original input identity: an
unknown provider outcome must not become a new physical attempt with a new UUID.

This additive foundation persists admission before each instrumented Meta
customer POST, including while cutover is OFF. Provider acceptance, rejection,
proven pre-connect failure and UNKNOWN settle against the original attempt.
ADMITTED and UNKNOWN never expire into permission. A common short database lock
serializes physical admission with an internal per-scope quiescence reservation;
the database transaction ends before external HTTP.

Actual Meta webhook and stored-native retry adapters retain the original inbound
MID hash and logical operation identity. A repeated accepted/unknown effect is
held; different source MIDs may produce identical text. The existing retry worker
checks that source before calling the model again. Only a constructed reaction
may accept a non-message acknowledgement without a message receipt.
DM receipts use message_id/messages[].id; a public-comment id alone cannot prove
a DM send. Contradictory success/error flags remain UNKNOWN even with a MID.
Retry snapshots capture MID, text and native timestamp together. A later input,
including identical text with a different MID, makes the older snapshot a no-op;
it is never adopted as the older job's source. Failed assistant tails retain the
preceding user input in the real stuck-selector/manual-queue path.

Manual conversation text/media/audio delivery and manual comment routes establish
a separate server intent using the authenticated actor, not an origin string.
The physical boundary rechecks that actor is active. Existing conversation ACL,
source claims, HUMAN pauses and provider receipts remain in place. An automatic
system/bot sender inside an authenticated request gains no manual exception.
This does not change the voice agent or enable customer staff permissions.

## Boundaries

- No activation endpoint, future CORE enrollment root, source promotion or legacy
  retirement is implemented by this package. An internal reservation is not CORE
  activation. Current policy, percentage, capabilities and master switches remain.
- Metadata without an original source or captured namespace stays unattributed.
  It must be covered by later adapters before claiming complete cutover coverage.
- Independently authorized campaigns/corrections and other text surfaces still
  need explicit integration. Existing ledgers are not relabeled to clear a gate.
- No automatic fallback, employee handover, paid replay or production probe.
- No raw recipient, message body, access token or error text is stored in the
  physical ledger; only digests, routing metadata and provider receipt IDs.

## Local validation

Real PostgreSQL tests exercise paused physical fetches in both lock orders,
ambiguous and pre-connect failures, original-effect retries, SQL immutability,
scope rotation, real retry-worker calls, and the authenticated manual HTTP reply
route after UNKNOWN/quiescence. Manual tests have a working positive control;
an automated sender cannot borrow that authenticated actor's exception.

These are local component/integration checks, not full-cloud, production
activation, delivery-quality or zero-defect evidence.
