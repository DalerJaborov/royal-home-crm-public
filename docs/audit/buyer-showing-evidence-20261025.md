# New showing evidence and candidate collection

Source scope: new writes only; no production execution or historical backfill by this change.

- SHOWING evidence v1 requires an actual date/time and a CRM property or explicit off-CRM description. The API cannot choose the evidence version; timeline assigns it.
- New future appointments are not conducted merely because completedAt was set. Cancelled records stay excluded. v0 historical reporting retains its former definition; historical unknown-time records cannot start a new post-showing survey.
- AI call extraction no longer substitutes 12:00 for an unspecified meeting time. Invalid calendar dates are rejected rather than normalized into another date.
- Durable buyer candidates are separate from Interaction/SHOWING. A verified CALL recording/transcript or a server-timestamped customer conversation supplies the source identity. Staff/synthetic by-attributed chat messages are excluded. Candidate recording does not create ordinary tasks, surveys, scores, alerts or guilt findings.
- Candidate review is three calendar days after the source conversation. The private ADMIN/DIRECTOR preview compares the same current assignment and known planned time/object. Ended assignments are explicitly excluded. The follow-up deadline after an unfulfilled reminder is not specified and remains NOT_CONFIGURED.
- Initial conversations preceding the current assignment are conservatively excluded; this avoids attributing historical conversations to a new owner. Unknown-time candidates retain null and a source excerpt; missing time never becomes noon. Uncertain matching to a later showing is displayed for human review, not silently marked resolved.
- Both candidate and seller-intake collectors require their migration-created WorkflowCheckpoint activation timestamp; absent checkpoint or older source means no enrollment. Late analysis cannot create cases from pre-release calls.
- Seller-intake appointment snapshots are immutable per station call and current assignment. Initial appointment plus three subsequent date changes gives a private descriptive fact; repeated same dates and replayed analysis do not add another move. Only a newly changed latest appointment can produce another fact. No automatic guilt, score or public notification is added.
- Newly eligible dual-intent seller calls enter candidate PREVIEW. They do not activate the legacy live automatic booking/push path merely because their buyer role is now confirmed.
- An absent PropertyExposure is not proof that a property was never sent. Full provider-delivery coverage is not established by that table. Pocket-showing evidence must retain UNKNOWN_COVERAGE rather than an automatic accusation.

Verification: targeted tests are `showing-evidence-version.test.ts`, `buyer-showing-candidates.test.ts`, `seller-intake-appointments.test.ts`; `conducted-showing-gate.test.ts` adds the actual API no-fake-showing case, and the private role matrix in `investigation-cases.test.ts` includes the candidate endpoint. Execution is coordinated by the root agent; this document does not claim those new tests have passed. An intermediate API TypeScript check passed before the final additions.

## Delivery and named-source observations

`ClientWorkflowObservation` is an immutable private PREVIEW journal, separate from investigations. The activation checkpoint is `client-workflow-observations-v1`; no checkpoint or an older source means no new observation. Ordinary named assignments and unknown delivery coverage never create an InvestigationCase, investigation level, penalty, ordinary task or notice.

`showingDeliveryFacts.ts` distinguishes:

- SMS provider ID + DELIVERED receipt before the observation: delivery confirmed, reading unknown.
- SMS SENT/provider accepted and CORE ACCEPTED outbox part: provider acceptance, device delivery/reading unknown.
- CORE AVAILABLE_WIDGET: published and available in the widget, not proof of viewing.
- Legacy PropertyExposure: an exposure record, not a transport receipt.
- No local record: delivery unconfirmed with UNKNOWN completeness, never “did not send”.

The CRM send-properties route records a future dispatch observation only after its existing delivery call succeeds. It preserves the real sender separately from the current client owner. Failure to append this supplemental journal does not turn an already accepted send into a retryable error. New property-bound SHOWING writes capture the delivery context at booking-record time, atomically with that timeline record; they do not assert what will happen before a future appointment.

Named-source collection records existing routing declarations as UNVERIFIED. Real customer chat evidence requires server time, a persistent inbound message identity, no staff/synthetic author and no silent capture. Incoming-call operator declarations stay UNVERIFIED; an authentic transcript match is speaker-unverified until independently reviewed. No regex name match proves who spoke the request.

Central `changeClientAgent` captures each actual new assignment after its ownership audit, not no-op updates. Source ID is the persisted audit ID, so a return A→B→A is retained even when an older caller reused assignedAt. Ambiguous reused assignment timestamps cannot reuse one quote to confirm multiple assignments. The private named preview reports declared/source-confirmed/all-observed counts, compares only the same routing mechanism, and requires an explicit configured sample plus a complete post-cutover window. The PDF's >2× criterion is descriptive PRIVATE_REVIEW_PREVIEW, with no automatic level or punishment. A zero/missing peer baseline is not fabricated into infinity. Old assignment denominators are not reconstructed.

The manual-contact preview reads the last 30 days of ordinary interactions and electronic evidence. A station attempt, a provider-accepted CRM send, or an identified message disproves “only manual local records”. Young assignments and truncated selections are explicit unknown/insufficient-window states; no old card is enrolled into a case. Channel completeness remains unknown, so local absence is not proof of off-CRM contact.

Additional verification files: `showing-delivery-facts.test.ts`, `client-workflow-observations.test.ts`, `client-workflow-observations-postgres.test.ts`, `named-assignment-preview.test.ts`, `manual-contact-preview.test.ts`. The actual API role matrix includes all new private endpoints and MANAGER denial even with permission overrides. These new suites are prepared for root-coordinated execution, not claimed passing here.
