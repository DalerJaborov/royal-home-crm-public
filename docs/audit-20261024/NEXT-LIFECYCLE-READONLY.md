# Next pass: draft, archive, trash and restore lifecycle (read only)

Source inspected in phase2 worktree at `3305fdc7dfcbde3a7d79e7ea8b00c8650de92a1c`. This report is saved in the main audit worktree as requested. No application source, default-scanned tests, dependencies, maps, production state or live configuration was changed by this pass. It did not revisit video cleanup/task selection or the stopped security work.

## Routing, scope and evidence

Started from `docs/product-map.md`: `/archive`; property/client API groups; `expired-property-drafts-cleanup` schedule. Followed:

- `routes/properties/draftLifecycle.ts`, `drafts.ts`, `draftAttach.ts` and the draft-to-property transaction in `properties/crud.ts`.
- Client trash/restore in `routes/clients/card.ts` / `lib/trashClient.ts`; property trash/restore in `properties/crud.ts` / `lib/trashProperty.ts`.
- Pure archive transitions in `lib/clientAutoStatus.ts::decideStatus`.

Eight named source files were hashed before the runtime probes; all eight still matched afterwards. Exact SHA-256 values and checks are retained in phase2 ignored reports `readonly-lifecycle-source-hashes.json` / `readonly-lifecycle-hash-check.json`. In particular, property creation `crud.ts` remained `1003f6de6111ee5a91809e48225d239f56efd6d47f8cf3ae5787214ba5f5821f`. Unrelated parent source changes do not constitute a new lifecycle test run.

Created **only** the fresh own database `audit_lifecycle` from own `audit_template` on the audit's already-owned loopback PostgreSQL container, port 15439. HTTP probes run in-process through actual Express routes with test environment pinning, synthetic agents/clients and their own temporary upload directories. Push delivery was mocked; no cron/worker or browser was started. Property creation attempted its existing SEO/caption helpers, which logged that no Gemini key was configured; no external model transport or paid generation occurred.

## Confirmed partial write: a rejected draft save can leave an accepted seller client

Actual path: `routes/properties/crud.ts:172–180` preflights the draft generation; `428–483` separately commits automatic seller-client creation; `551–555` then opens the property transaction and checks the generation again.

The automatic seller is not merely a transient lookup. The route creates a real `Client{kind:SELLER,status:NEW}`, assigns it to the intake agent and sets `acceptedAt` in its independent transaction. It can therefore remain an owned accepted client even when there is no property.

### Exact reproduction

Ignored harness: phase2 `reports/night-audit-20261024/readonly-lifecycle.probe.test.ts`, case `records the seller side effect when the draft closes after auto-seller commit`.

1. Create one synthetic agent and a current, valid property draft. Confirm that the unique synthetic owner contact does not yet have a client.
2. Send a valid actual `POST /api/v1/properties` referencing that current draft/revision, with the new owner contact.
3. At the application's `$transaction` return boundary, **after** the automatic seller transaction has actually committed and returned its UUID, perform an actual same-agent `DELETE /api/v1/properties/drafts/current`, representing another tab discarding the draft. The database and both HTTP routes are real; only the scheduling boundary is instrumented.
4. Resume property creation. Its second draft check returns HTTP **409 `DRAFT_CONFLICT`**. Actual persisted state: **zero properties**, the draft closed, but **one accepted SELLER client assigned to this agent** remains.
5. Control: when the draft is already closed before property creation begins, the first check returns 409 and no seller client is created.

Evidence: `readonly-lifecycle-seller-r4.log`, recorded native exit **0**, one case executed / four unrelated cases skipped. The logged synthetic seller, agent and draft IDs identify the exact own records; that seller was registered for teardown and deleted afterwards. Exit 0 here asserts that the unwanted partial write was observed, not that it has been fixed. No production concurrency or browser-tab race was executed.

### Expected contract and its limits

Expected business behavior: a request rejected because its draft was discarded should not commit a new accepted seller as an unlinked side effect of a property that never existed. The existing route/test contracts support this expectation:

- `property-seller-autocreate.test.ts:8–15` describes creating the seller **while adding the property** and linking it through `sellerClientId`.
- `property-draft-lifecycle.test.ts:152` describes rejecting stale revisions before insertion and consuming the current draft atomically; its failure/rollback case at 170 preserves the draft/files and creates no property.
- The route itself performs an early generation check and a second check at the property insertion boundary after slower work.

The persisted state divergence is directly verified. Existing tests do **not** explicitly assert seller rollback, and no separate owner instruction requiring retention of a newly auto-created seller after a rejected property request was found. The expectation of atomic seller/property creation is inferred from that existing workflow, not presented as an additional owner policy decision. Parent review should settle the intended contract before a fix.

Root cause: the seller and property use different committed transactions. The property's later rollback/conflict cannot roll back the earlier seller creation. A potential fix should couple new seller creation/linking with the successful property transaction after the locked draft check, preserving existing-client reuse and phone uniqueness. Do not blindly delete the found seller as compensation: another concurrent successful request could legitimately reuse it. No source fix was made here.

## Successful bounded controls

| Flow | Actual runtime evidence | Result |
|---|---|---|
| Draft start → autosave → close → new generation → delayed old autosave | Actual HTTP / own PG | New generation empty; old autosave 409; its values do not overwrite the new generation |
| Real draft photo → create property → trash → restore | Actual HTTP / own PG / sharp / filesystem | Photo URL and file survive attachment, trash and restore; draft closes; restore keeps `publishedOnSite=false` |
| Expired photo draft → GET cleanup → delayed autosave | Actual HTTP / own PG / filesystem | Draft closes once, its own media rows/files disappear; stale autosave 409; repeated GET retains the same revision |
| Client with future task → trash → calendar → restore | Actual HTTP / own PG | Task hidden while trashed, same task returns after restore; agent, accepted timestamp, status, task text/date/completion retained |
| Archive decision controls | Extracted actual pure `decideStatus`, no DB | Seven controls pass: no/old activity keeps archive; fresh reply restores CONTACTED; manual hold respected; 61-day silence archives; LOST/DEAL_CLOSED remain frozen |

Runtime logs are intentionally separate:

- `readonly-lifecycle-runtime-r2.log`: **three passed**, one failed **probe assertion** that incorrectly expected client DELETE to use 204. The source returns 200 `{ok:true}`. That failure is not counted as a CRM defect, and the unfinished client flow from that run is not counted complete.
- `readonly-lifecycle-client-r3.log`: corrected **client flow only** passed, native exit 0; three unchanged cases skipped. Between the runs, the parent updated one build-only dependency (`serialize-javascript`); no lifecycle/API source changed. Do not describe these as a single four-case all-green run.
- `readonly-archive-pure-r2.log`: **seven pure controls**, native exit 0. The original pure-probe log contains a harness parsing error (top-level return before stripping TypeScript), not an application failure.
- Initial `readonly-lifecycle-runtime.log` contains no test execution because the first Windows absolute include glob was not discovered. It is excluded from behavioral evidence.

Four ordinary lifecycle flows were thus completed across the named bounded runs, plus one separately executed partial-write reproduction and seven pure archive controls. These are different evidence layers and are not a count of complete endpoint/module coverage.

## Cleanup and remaining coverage

Synthetic fixture IDs and files were tracked individually. The ordinary successful-property flow automatically created an additional synthetic owner client; after verifying its exact UUID and synthetic contact in this fresh own DB, that one additional row was explicitly removed. Final retained counts: **0 agents, clients, properties, drafts, draft media and interactions**, recorded in `readonly-lifecycle-fixture-counts.txt`. Database itself and diagnostic evidence were retained. No foreign database or files were removed.

No full API suite, map regeneration, dependency mutation, commit, deployment, production write, real notification delivery or physical desktop/mobile interaction was performed by this worker. Source reads and positive controls do not establish complete lifecycle coverage. Permanent purge, all archive filters, every draft import/media combination, simultaneous restore/trash edits and all role permutations remain unexhausted.
