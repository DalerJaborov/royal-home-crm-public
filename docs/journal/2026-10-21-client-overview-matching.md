# Client overview, confirmed roles and property selection

The client overview now shows the seller's own portfolio or the buyer's property recommendations immediately below the AI summary. Confirmed concurrent roles show both. Selecting objects, scheduling a showing, checking prior sends and preparing outreach share the same workspace on desktop and phones.

## Behaviour

- Historical `dualIntent` signals do not prove concurrent roles. Staff explicitly confirms them; the actor and time are recorded. Changing the primary kind invalidates that confirmation. Unconfirmed legacy signals remain available for clarification.
- A dedicated buyer requirements editor works for buyers and confirmed secondary buyers. Requirements explicitly tagged as another role do not become a purchase budget; replacing them preserves the prior values in the timeline.
- Recommendations compare every visible available property in bounded database batches before ranking and pagination. The client's own sale properties are excluded. Better suitability takes priority over ownership; own properties win equal comparisons and have a separate filter.
- Evidence covers currency-normalised budget, property type, rooms, area, floors, district or actual distance to a requested place, and narrowly recognised written wishes. Cards distinguish recorded matches, compromises and unknown facts. They do not present weight totals as probabilities. Unrecognised free text still requires staff review.
- Outreach has an explicit channel and prepared preview. Copying and system sharing do not record a send or pause the bot. CRM sending uses the preview's pinned conversation. The whole property batch is validated; missing, hidden, sold or withdrawn items cannot silently disappear from a claimed send.
- SMS respects ownership and pending-lead restrictions. Only accepted provider receipts create an exposure; dry runs and preparation do not. A secondary journal failure does not turn provider acceptance into a retry prompt.
- Read-only cards do not expose write controls or fetch a writable send target. Existing phone and origin visibility rules remain enforced by the API.

## Database changes

`20261021020000_client_intent_confirmation` adds nullable confirmation time and actor, without confirming legacy signals automatically.

`20261021020100_sms_property_exposures` backfills only `SENT` property-share receipts with existing clients and properties, using deterministic exposure IDs and the original timestamp. Provider acceptance is not proof of handset delivery.

## Validation and limits

Local checks: shared/API/web builds; 115 API integration tests covering the affected and adjacent flows; 13 pure comparison tests; 28 targeted frontend tests. All 11 browser scenarios passed on a guarded localhost stand with synthetic data, including selection retention, role confirmation, numeric-route refresh, read-only cards, showing lifecycle and explicit sending to a local website conversation. The two preview/layout scenarios also passed after the final scoped textarea fix. No external provider was used.

Google embeddings are not required for this change, and opening a client card does not call a paid model. Semantic similarity could later supplement explicit constraints after evaluation on representative queries; it cannot prove missing property facts. Source checks, the complete release API suite and production verification remain separate release evidence. Physical devices and real provider delivery are not claimed by the local browser tests.
