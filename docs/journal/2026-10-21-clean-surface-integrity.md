# Clean surface and motion integrity

## Problem

The owner reported overlapping icon/text metadata, nested card surfaces, indistinct edges and distracting motion in desktop and phone workflows. Successful route loading and overflow measurements alone did not verify these visual properties.

## Changes

- Clean CSS animations and transitions are disabled, including pseudo-elements and portal content. Hover/press lift effects stop moving controls; entrance-only hidden cards are revealed in their final state. Stateful positioning, switches, scroll regions and direct drag gestures remain functional.
- The Clean dashboard uses static sections and a non-animated chart. Shared number counters, gallery navigation and sheet release respect the same motion policy. Legacy uses its existing device preference.
- Clean card tokens are opaque. Cards have one visible edge; shared sheet and menu surfaces are opaque and no longer blur the page behind them.
- Property description and people slots no longer add a second painted card around their existing content. Primary and secondary property actions use a predictable phone grid.
- Social video scheduling metadata keeps its calendar icon and label together. Shared Lucide icon rules preserve inline alignment and prevent flex shrink. Publication state labels retain space between icon and text.
- Dashboard KPI cards explicitly override the older transparent/borderless rules in the real dashboard cascade. Named icon and label elements preserve phone labels. Channel detail cards receive the same visible boundary.
- Shared card headings wrap long titles, counters and actions without collisions. The two-action property permission branch keeps both actions full-width on phones; the three-action branch retains its primary/secondary grouping.

## Validation boundaries

Browser regression fixtures import the actual application components and complete application CSS, use synthetic data, and perform no business operations. Cases cover desktop and narrow widths, both themes, control geometry under hover, icon/text gaps, opaque sheet edges, nested focus/close behavior, counters and legacy CSS isolation. This is component/browser evidence, separate from full application and production verification.

Source inventory findings are candidates, not a claim that every candidate is a bug. Production deployment and read-only postchecks remain separate release steps. The AGENT phone device policy and API/shared business contracts are unchanged. No claim of zero future defects or physical iOS/Android acceptance is made.

## Recorded checks

- Browser component matrix: 15/15 passed, including 360/390/768/1024/1440 pixels in both themes, the two-action property permission branch and legacy token isolation. The matrix checks opaque dashboard KPI backgrounds and edges, visible labels, scheduling metadata and publication state icon/text gaps, nested sheets and stable controls; console errors fail the cases.
- Motion policy unit cases: 4/4 passed. The complete web unit suite passed 272 files / 1,663 tests before the final metadata extraction; exact final source cloud validation remains required.
- Web ESLint/TypeScript/Vite build passed before the metadata extraction; TypeScript passed after extraction. Source maps regenerated without tracked changes. Mechanical design detector returned no findings for the changed targets; that is not visual proof.
- Initial local precheck failed because the new worktree did not yet have its generated Prisma client. The client was generated without a database operation. A second local API compile was deliberately stopped to release laptop memory. Neither local precheck is recorded as green; the normal exact-source cloud workflow is the final gate.
- The first expanded browser matrix retained a test-harness failure caused by automatic scrolling before hover geometry comparison. Scrolling is now settled before the comparison; the geometry assertions remain strict.
- A later long-heading browser case reproduced document overflow before the shared heading fix. That failure is retained separately from the successful correction. Independent dashboard and shared-surface source reviews identified the competing CSS rules and the two-action permission branch; source review alone is not production acceptance.
