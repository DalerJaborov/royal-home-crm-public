# Buyer/seller release and acceptance checklist

This checklist prepares a future release. It does not authorize a merge, production changes, provider activation or paid voice generation.

## Editable starting timings

The owner approved a practical editable starting proposal. Open **Служба безопасности → Дела и доказательства → Контроль работы с продавцом**:

| Setting | Starting value | Meaning |
|---|---:|---|
| Agent | 2 working days | Time for the additional agent task. For seller intake this also determines when an overdue recorded appointment first qualifies for control |
| ROP receipt | 1 working day | Time to acknowledge a task after it actually reaches the responsible manager |
| ROP action | 2 working days | Time for the manager's action after acknowledgment |
| Buyer candidate follow-up | 2 working days | Additional time after the original three-day candidate review wait |

These are a proposal, not an assertion of a universal industry standard. Existing saved custom values take precedence, including deliberately absent optional values. Editing one field preserves the others. **Заполнить стартовые сроки** prepares the proposal while keeping an already selected ROP; **Сохранить сроки** persists it. No real employee is selected automatically. A missing ROP blocks future automatic enrollment.

Working-day calendar, absence and outage rules remain in force. Seller source eligibility and the later task deadline are distinct moments: the additional task receives its full configured time from actual creation, rather than arriving already overdue. Saving a timing configuration does not enable LIVE execution or promote historical previews.

## Before an approved release

1. Recheck the active public worktree and release ownership in `D:/CRM-migration-20261021/WORKSPACES.md`. Inventory unrelated work. Do not reset it or introduce private Git history.
2. Freeze the exact source. Obtain its source checks and all checks required for its change scope. Backend/shared changes require the full isolated API suite; an earlier SHA's green report is not a receipt for changed backend code.
3. Review current production migration state and take a fresh, independently verified backup. The isolated synthetic backup/restore rehearsal is not a current production backup.
4. Rehearse pending migrations on an isolated recent copy under the approved data-access policy. Preserve old rows, shared audio, evidence provenance and assignment history. Review additive-schema compatibility with the rollback artifact.
5. Set the chosen responsible manager, working calendar and owner-approved timings. Choose ElevenLabs voices and verify provider bindings, current consent and the relevant channel restrictions. Keep the new execution gates off.
6. Only after explicit release authorization, use the normal `npm run ship` path in the mapped public source. A source merge is separate from deployment and activation.
7. Verify deployed SHA, API/worker health, migrations, role/privacy boundaries and ordinary CRM scenarios independently after deployment. Check that no old previews, unknown attempts or deleted historical records were replayed.

## Before an approved activation

Use the separate execution prerequisites in `buyer-seller-execution-gates.md`. Server flags, persisted execution modes, cutovers, current assignment/consent, supported provider operations and configured deadlines must all agree. A saved form or successful HTTP response alone does not establish delivery.

RU/TJ language handling already exists. A new language implementation is not a release prerequisite. Before separately approved real voice activation, verify the actual selected voices/provider and outcomes such as no answer, refusal to speak, unclear answers, cancellation and duplicate/late receipts. The owner manages WhatsApp and telephony integration; this change does not configure or activate them. Do not infer agent guilt from missing records or an inconclusive robot call.

## Rollback preparation

Before activation, retain the known-good application artifact and agreed rollback procedure. If a new workflow misbehaves, disable its execution gates first and reconcile any in-flight or UNKNOWN attempts before retrying. Use the normal verified deployment mechanism for application rollback. Do not drop additive columns, delete new evidence, reverse migrations blindly or restore an old database over current business history. A database restore is a separate disruptive recovery decision.

## Evidence boundaries

The isolated browser pass covers initial rendering of all 52 mapped routes at desktop and mobile widths, seeded detail pages, empty states, JavaScript errors, local API errors and viewport containment. It does not prove every interaction, all states, every device, real provider delivery or live RU/TJ voice quality. External resources and provider fetches are blocked in that stand.

The synthetic backup/restore rehearsal preserves the snapshot and its migration checksums. PostgreSQL may reparenthesize AND-only CHECK expressions while restoring; verify the exact differences rather than requiring byte equality of dump text or ignoring arbitrary constraints.

The owner cancelled both internal price comparisons and external market-price scraping. The comparison UI, route and shared contract have been removed. Ordinary listing prices/history, buyer budgets and property matching remain. Universal social-network discovery by phone is not an implemented capability; only persisted known channel links are used.

## Dedicated ROP home and unified chat (26 October)

HEAD_OF_SALES receives its own responsive home in the existing Clean design. It shows only neutral ordinary tasks assigned to the current actor; private investigation metadata is excluded. Receipt aligns the existing task's deadline; a recorded action completes that task without declaring the underlying control episode resolved. Execution gates remain mandatory. Legacy MANAGER routing is preserved.

The grouped inbox uses persisted Client.id and groups visible source conversations before counting and pagination. Known linked histories appear together; unlinked sources remain separate. Message IDs retain their actual source for quotes, read state and replies. Unsupported Telegram Direct sending remains read-only. Channel-specific integration setup and activation are separate from aggregating already stored history.
