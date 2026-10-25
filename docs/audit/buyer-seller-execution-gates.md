# Buyer/seller workflows: release and activation boundaries

This source change does not authorize production deployment, provider requests or activation. New work defaults to PREVIEW. A successful test run is not proof of live delivery, voice quality or an acceptable operational noise level.

## Private evidence and human decisions

Investigation APIs require ADMIN/DIRECTOR and the effective `clients.securityReview` permission. Personal grants cannot widen that role boundary. Text and names respect `clients.viewPhone`. Ordinary lists, counts, reports, background jobs, error logs and notices exclude private evidence before pagination and mutation.

Fact confirmation and severity are separate. CONFIRMED retains the current level; C4 requires a separate explicit human decision. Read-only C1–C3 suggestions require supported source provenance. Statistics and missing local records do not establish guilt. Exact competitor-name coincidences are not verified company identity, and delivery records are not proof of viewing.

## Execution gates

| Workflow | Required activation conditions | Historical protection |
|---|---|---|
| Buyer reminder and ROP follow-up | `SELLER_CONTROL_INTERNAL_LIVE=explicitly-approved`, `BUYER_CANDIDATE_INTERNAL_LIVE=explicitly-approved`, explicit `BUYER_CANDIDATE_LIVE_FROM`; configured deadlines and active default ROP | Only new persisted LIVE candidates at/after the source cutover; PREVIEW rows remain PREVIEW |
| Seller intake and missing inventory follow-up | `SELLER_CONTROL_INTERNAL_LIVE=explicitly-approved`, explicit `SELLER_CONTROL_LIVE_FROM`; configured deadlines and active default ROP | Execution mode is frozen on the immutable intake source. No enrollment from historical PREVIEW sources |
| Owner checks from exposure/manual intake | `CRM_OWNER_VERIFICATION_EXECUTION_MODE=LIVE`, current evidence, explicit ADMIN/DIRECTOR approval | Approval creates a separate execution row. Existing previews are not promoted |
| Narration handoff | `CRM_NARRATION_EXECUTION_MODE=LIVE`, persisted LIVE plan, current version/facts/files and existing montage assignee | A mode change cannot drain old previews. Unknown provider outcomes require reconciliation |
| Monthly owner report | `CRM_OWNER_REPORT_EXECUTION_MODE=LIVE`, explicit current owner consent/subscription revision and LIVE delivery row | No old-month catch-up; revoked/changed consent invalidates pending delivery |
| Publication metadata | `PUBLICATION_METADATA_EXECUTION=LIVE`, explicit supported operation and executor permission | Attempt/receipt ledger; unknown outcome cannot be blindly retried; unsupported operations remain manual |

These names are deployment settings, not UI instructions to enable them. Actual credentials, numbers, voices, templates and supported platform operations must be reviewed separately before any activation.

## Ownership, tasks and time

Sources retain their original assignment epoch. A→B→A with a reused timestamp does not revive old evidence or tasks. Merges retain original evidence identity, revoke source owner-report consent and cancel only the source's additional control work.

New SHOWING writes require a real time plus a property or explicit off-CRM description. Unknown times remain unknown. Buyer candidates are separate from conducted showings; an already recorded matching booking prevents a duplicate reminder. Uncertain object/time or ambiguous matching does not start an execution task.

Control tasks use the existing working-day calendar and explicit configured deadlines. Delayed first enrollment grants time from the actual reminder. A new appointment recorded in a genuine call can replace the previous control; ordinary manual task movement cannot. Same-date repetition does not reset deadlines, and simultaneous conflicting sources do not establish an ordering.

Absence pauses only the current phase's additional task. Its original deadline remains in history with cancellation time; return creates a new neutral task with a future deadline. An unavailable ROP does not cancel the available agent's work. Normal assignments, deals and deferred-card state are not rewritten by these controls.

## Verification still separate from release

Use isolated PostgreSQL, synthetic fixtures and mocked providers. Verify API roles and negative cases, desktop/mobile request bodies, source modes, concurrent claims, retries and late receipts. Apply migrations to a rehearsal database and require an empty schema diff. Freeze the exact commit and obtain complete source/API checks before a release decision.

Before real activation: set the owner-approved deadlines and ROP, choose voices, verify provider bindings and consent, run an approved RU/TJ pilot, and observe noise before expanding. No green unit suite substitutes for those operational checks.
