# Read-only final package review: 5616 → 13a9219

**Scoped approval: no new blocking/severity findings in the reviewed delta.** This is a source/test-oracle review, not a new runtime or whole-CRM acceptance claim.

Exact target: `13a921914f5622b1a7b6ed4f6b954756fe28c4c3`, tree `a32c198888ba75dfa9baa0fb12985a6e15126387`; base `5616f8e3e886c500d0eeebf5edda924757620a2d`. The target contains24 changed files: the seven application/test/config/fixture files were read in full delta/context, with the existing `REVIEW-FINAL-CLIENT-DM.md`, `REVIEW-FINAL-SCHEDULE.md` and underlying retained evidence reports read first. No runtime test was repeated. Only this MAIN review document was written.

Authorship limit: the DM test correction was authored by this reviewer earlier in the audit. This pass independently checks the final combined delta and the other two families, but is not a second independent author-level DM review; the parent's and business specialist's separate DM review remains recorded in `REVIEW-FINAL-CLIENT-DM.md`.

## CF-01: accepted integer radius

The sole application-source change in this delta is `ClientFormModal.tsx`'s number-input step100→1. The actual client desired-place schema accepts integers100..10000; the component preserves the same min/max/default/value/commit/blur logic. The change aligns native validation with that contract without rounding, permitting fractions, changing shared/API policy or changing MatchingTab.

The tracked browser regression uses the real component, hooks and styles, an explicitly loopback managed Vite server and synthetic intercepted HTTP. It checks native Next, real invalid/submit events, `noValidate=false`, eventual exact radius in a schema-valid client write, stored/configured1250,1200/bounds, fractional rejection, and normal review navigation at1440/390. External requests are aborted, and unknown API shapes fail. The synthetic fixture has no production entrypoint/config modification. The Playwright file is outside existing Vitest source-test inclusion.

Retained14-case browser RED/GREEN and decoded write payload evidence were reviewed through the existing reports, not rerun or relabeled as PostgreSQL/production evidence. No weakened acceptance assertion was found.

## DM oracle: exact expected public facts

The final test independently writes the full expected three-line reply from known500000 TJS, saved public shortId and district name/city, plus the literal question. It does not call the production renderer/projector for expected output. Equality rejects all additional/substituted output. Both meaningful actual synthetic ownerContact and the original nonempty private-address sentinel are excluded explicitly.

The complete original negative regex remains on the residual after removal of only exact known public price/location lines. No generic digit scrub, application guard change or shared-helper alphabetization exists. Actual positive variants include public district992 and a free owned high shortId containing992. Their UUID-suffixed names remain unique across attempts sharing one beforeAll fixture; the high-ID allocation reads candidates and updates only the newly captured own property, without sequence resets or foreign-row mutation. Pure extra-contact/address-substitution controls test the stricter oracle rather than application behavior.

The shared golden helper has no delta, and its cleanup remains bound to captured account/scope/property/district IDs. Retained final16-case rerun, prior unchanged7+10 neighbors, two-owned-preparation control, and original cloud full received attribution are distinguished accurately in the reports. No weakened private/public policy or false-green numeric exemption was found.

## Weekly-call fixture: owned invariant

The scheduler actually returns at most one global started call, so the replaced global-count oracle could not identify the fixture client's call. The new case supplies a captured own competing client/showing and waits, with the existing bounded helper, for its first exact showing ID to be CALLING. It requires attempts1/lastAttemptAtNOON; nullable accesses still fail against those exact values if no row is returned.

For its second exact showing ID it requires SKIPPED/weekly_limit, attempts0 and null lastAttemptAt, exactly one bridge invocation whose actual scenario argument carries its clientId, and exactly one own row with non-null attempt history. This does not relax the oracle to a global/nonzero count. Checking initial attempts before the next-day recovery correctly preserves the unchanged policy, which uses lastAttemptAt history and can later refund an unfinished call's attempts.

The new finally cleanup deletes only PostShowingCall/Interaction records for the captured competitor.id, then that Client. Existing own-client beforeEach/afterAll cleanup and telephony mock are unchanged. No global deletion, scheduler/clock/policy change, forced completion or real-call behavior was added. Retained44-case execution predates only the documented nullable type-access followup; this pass does not invent an exact-final44-case rerun or identify the unknown historical cloud competing row.

## Scope boundary and remaining validation

`git diff --name-only` confirms no delta in API application source, Prisma, shared schemas, shared API fixture helpers, dependency manifests/lock, release/operations scripts or workflows. The sole application file changed is the one frontend attribute above. No production action, live configuration or foreign cleanup is introduced. Committed-range `git diff --check` passed during this review.

The parent subsequently reported exact13a9219 consolidated precheck native0; that is separate coordinator evidence, not a test run by this review. No complete exact13a9219 API dispatch/result is claimed. A later independently confirmed expense-table delete-version fix is outside this reviewed commit/delta and needs its own review and final frozen validation. Approval here must not be carried forward silently to later bytes.
