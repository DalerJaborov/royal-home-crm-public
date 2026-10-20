# Clean mobile client actions and expense date scope

## Problem and change

Four client quick actions used non-shrinking 90px bases inside a narrower phone row. Clean phone styles now distribute the available width between all four actions without hiding buttons, clipping the document or changing handlers. Both the single-number call wrapper and the direct multi-number chooser are supported. Desktop styles and the agent phone legacy policy are unchanged.

The expense table now explains that its date range selects records with a payment date. Month-only historical records remain available in Expenses. Query parameters, API filtering, amounts and stored dates are unchanged.

## Verification

- Component regression asserts the caption and the exact existing server query.
- Browser regression checks all four actions at 360/390/430px in both themes, desktop bounds, 44px minimum touch dimensions and the absence of document horizontal overflow. Both call component branches are exercised without making a call or writing a phone number to the database.
- Existing client More → Edit and genuine seeded agent desktop/phone role checks remain part of targeted acceptance.
- Earlier isolated checks passed: ESLint/TypeScript/Vite build, 14 targeted unit tests and three browser scenarios. These results precede this clean public-source port; exact public-commit cloud validation is required before release.

No backend, shared contract, device-policy or migration source was changed. No production mutation was submitted by these checks. Physical installed-PWA behavior on iOS and Android is not established by browser emulation. Source validation and production deployment acceptance are separate release steps.
