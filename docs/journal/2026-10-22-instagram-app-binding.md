# Owner-configured Instagram signer binding

An unbound Instagram account can receive a valid shared-key public envelope without
acquiring private conversation authority. The existing account storage supported
an encrypted per-account signer, but settings had no controlled way to configure
that existing connection. This does not justify silently copying a global key.

Add a distinct `owner_selected_observed_signer` operation for elevated active
ADMIN/DIRECTOR users with settings.manage. Only current stored keys backed by a
recent, sealed, canonical FINAL input for this exact receiver and CURRENT namespace
revision are offered. The UI starts without a selection and requires explicit
future-input confirmation. It accepts no arbitrary key. Two bounded provider GETs
check token identity and exact application subscriptions; these are NOT proof that
Meta verified ownership of an Instagram signing secret. Failed checks do not select
another app/key or enable a different authority mode.

The diagnostic reader validates encrypted RAW/FINAL consistency, canonical event,
order, scope, original conversation, credential version, timestamps and receiver.
It never recovers or brands historical input. The final short transaction locks and
rechecks the owner, stored key, account snapshot, current scope, exact diagnostic
row and proof age. Encryption, normal namespace rotation and a redacted configuration
audit commit atomically. New-key rotation requires the established managed-work
idle checks. A lost-response retry of the exact accepted request preserves the key
ciphertext and scope revision. The old generic account endpoint rejects key input.

Configured and fresh-signature-confirmed states are separate. Saving does not create
a private customer principal: only a genuinely new request matching the account key
can use the existing protected-namespace verifier. Existing RAW/FINAL sources,
rollout assignments, receipts, UNKNOWN quarantine and human holds remain unchanged.

Validation in progress at the source checkpoint: 95 targeted PostgreSQL/pure/boundary
checks passed before the final fixture-strengthening edit. The namespace regression
was then run against the single omitted predicate and failed (an old-scope candidate
was wrongly offered); the corrected source was restored with identical SHA256.
Final integration/build/browser/map checks follow synchronization with current main.
Earlier experimental Facebook Application probes did not establish installed
Instagram app-to-signing-secret ownership; that unactivated prototype was replaced
explicitly, never used as an automatic fallback or a successful provider proof.

Source validation, official release, owner configuration and actual future two-turn
continuity are separate acceptance stages. This change does not perform the text
100-percent cutover or change voice, employee handover or legacy fallback behavior.
