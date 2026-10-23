# Property creation: atomic auto-seller and property/draft insertion

Status: focused source fix and isolated real PostgreSQL validation passed. Parent integration, complete builds/suites and publication remain separate.

## Confirmed defect and expected behavior

`apps/api/src/routes/properties/crud.ts` previously committed an automatically created, assigned and accepted seller in a separate transaction before the property's authoritative draft/duplicate checks. Closing the current draft after the first draft preflight could therefore produce HTTP409 `DRAFT_CONFLICT`, zero properties, but a new accepted SELLER client. An address-duplicate refusal and a property INSERT foreign-key failure also retained that seller.

Expected: auto-seller creation and property/draft-row insertion commit together. A refusal or database rollback of that insertion unit must not leave the newly created owner card or its initial status event behind. Existing seller cards are reused, never compensating-deleted.

The discovery report `NEXT-LIFECYCLE-READONLY.md` in the first audit worktree retains the exact old interleaving: auto-seller transaction commits, actual HTTP DELETE closes the draft, then property creation's authoritative draft check returns409. This discovery is separate from the durable regression's stable schedule, which closes the draft through actual HTTP after the initial preflight and staff-phone check, before the final property transaction.

## Minimal implementation

- The existing external SEO/caption/geocoding order and staff-phone guard remain outside the property transaction. A read-only existing-seller lookup preserves the earlier ownership refusal at its current point in the request.
- Inside the existing property transaction, the draft advisory lock/recheck and duplicate/repeat checks run first. Auto-seller lookup/create and the binding-rights check now run there before `property.create` and draft-row attachment. No new draft row lock or provider work was added.
- The same live phone-tail lookup, SELLER preference, exact-phone trash fallback, effective intake owner, accepted/assigned timestamps and self-created assignment reason are retained. Ordinary creation without a draft uses the same insertion unit.
- A short, static tagged-SQL SAVEPOINT surrounds only `tx.client.create`. Only an actual P2002 triggers `ROLLBACK TO SAVEPOINT` and an exact-phone winner lookup. Missing winners and other errors propagate. RELEASE runs outside the create catch, so its own failures are not mistaken for uniqueness conflicts. The winning card still passes the authoritative binding check; refusals retain the existing403 body.
- Keeping `client.create` preserves `db.ts`'s existing initial StageEvent hook. That hook queues only after successful INSERT; its pending events are discarded when the outer transaction rolls back. No global DB hook, createMany behavior, journal semantics or schema was changed.

Lock order reviewed: draft advisory lock, property duplicate/repeat advisory lock, seller INSERT/unique wait, property INSERT and draft attachment. Existing seller lookup uses ordinary reads. No additional draft/client row locks were introduced.

## Reproducible evidence

New default regression: `apps/api/tests/property-create-seller-atomic.test.ts`. It calls the actual HTTP routes and actual Prisma/PostgreSQL on the dedicated own `audit_lifecycle` database. Synthetic fixtures are scoped and cleaned. SEO/caption and push mocks retain actual other exports and prevent unrelated paid generation/delivery. The staff guard itself remains real; its hook only controls scheduling.

Original source baseline was3305 `crud.ts` SHA256 `1003F6DE6111EE5A91809E48225D239F56EFD6D47F8CF3AE5787214BA5F5821F`.

- `property-seller-atomic-red.log`: native1, initial7 cases = **2 failed /5 controls passed**. Late draft close and duplicate409 retained the newly created seller.
- `property-seller-atomic-race-controls-red.log`: native0, **3 passed /6 skipped** after extending the same file. Successful new-card initial event plus both unique-race controls pass on the original source.
- `property-seller-atomic-rollback-red.log`: native1, **1 failed /9 skipped**. Actual property INSERT FK failure returns500 but leaves the seller on the original source.
- `property-seller-atomic-green-r1.log`: native0, **all10 cases passed** after the fix. Cases cover late and already-closed drafts, successful new owner/current draft, live and trashed existing BUYER reuse without a draft, existing foreign owner403, address duplicate409, real unique-phone own/foreign winner interleavings, and actual FK rollback of the new seller plus its initial event.
- The unique-race cases use a second real PG connection to commit a winner after lookup and before the route's real INSERT. No P2002 is fabricated. The FK case also uses a real PostgreSQL constraint failure. Its expected application error log is retained, not treated as an unexpected failing test.
- `property-seller-atomic-adjacent-green.log`: native0, **7 existing files /63 tests passed**: seller-autocreate5, draft-lifecycle10, draft-media-loss9, duplicate-check28, stage-events6, stage-events-inside-transaction4, stage-event-guard-race1.
- `property-seller-atomic-mocks.log`: `npm run audit:mocks` native0, no weakened guard/baseline. Owned `git diff --check` passed. Dependency set is the parent's updated phase2 set; Vitest4.1.12, Prisma7.10.1.
- Final isolated-DB cleanup readback: zero agents with the new suite's exact synthetic actor label and zero clients with its four synthetic owner labels. This is a scoped fixture-cleanup check, not a global database-cleanliness claim.

Run the focused files from the repository root with the own DB and synthetic test environment, for example `npm exec --workspace=apps/api -- vitest run tests/property-create-seller-atomic.test.ts`. Full shared/build/map/complete-suite work is reserved for parent integration and has not been repeated by this subtask.

## Scope and remaining limits

Atomicity here covers seller creation, property insertion and transactional draft rows. Existing postcommit caption-footer update, media finalization, audit and other postcommit effects remain unchanged. This does **not** claim that every later HTTP error rolls back already committed property data. Concurrent ordinary reassignments, broad application lifecycles, browser rendering, workers, real provider delivery and production behavior are not exhaustively verified by these tests. No production writes, sends, paid generation, live configuration, merge, ship or deployment occurred.
