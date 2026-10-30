# Manual role QA: working lists and conducted showing counts

On the synthetic role stand, the agent desktop showed three working buyers while
the legacy mobile list showed four, including a buyer with a closed deal. The
mobile query now uses the shared clientListScope rule. Explicit status filters,
historical search, all-mine/inactive routes and pending acceptance remain distinct;
search from a URL is retained and may cross buyer/seller kinds where permitted.

A complete synthetic deal journey also exposed an object-card count of two
showings after one conducted and one cancelled showing. Property.viewsCount is
incremented at booking time, so it cannot represent conducted visits. The detail
API now returns a filtered aggregate using conductedShowingBaseWhere and the
existing investigation visibility filter. The UI labels that fact explicitly as
conducted showings, without exposing interaction rows or changing historical data.

Validation: mobile query/scope tests 14 PASS; the new property-card regression
failed before the fix, then the card and property-statistics suites passed 8 tests.
Manual synthetic actions covered client edits and invalid budgets, historical
search and filters, deal creation and stages, rejection of closure without a
showing, scheduling/rescheduling/cancellation, conducted-showing confirmation,
agent submission and director approval, and resulting client/property statuses.
These results do not claim exhaustive testing of every role/button or external
message/call delivery. Somon and Paydo features are unchanged.
