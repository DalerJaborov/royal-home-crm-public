# Unresolved product choices, not silent fixes

## Lost leads: flow count versus created-period cohort

An actual authenticated HTTP/PostgreSQL fixture reproduces the reports widget returning lost2, totalLeads1 and lostShare200. The numerator counts older leads lost during the window; the denominator counts leads created during the window. UI wording calls this a share and says N of M. The AI marketing summary has the same source pattern, but generation was not invoked.

The mathematical mismatch is confirmed. Choosing a replacement requires deciding whether the product reports losses as period activity, conversion of the created-period cohort, or both separately. A percentage clamp would hide the mismatch. No formula, lead inclusion policy or historic data was changed. NEXT-REPORTS-READONLY.md records the reproduction, exact source paths and possible directions. This needs an owner's metric choice before a corrective formula is implemented.

## Reminder/deadline semantics

The bounded task pass identified ambiguous repeat/date-only deadline behavior but did not establish a contradictory approved product contract. Only the confirmed cancelled-showing selection defect was repaired. Reminder frequency and deadline policy were preserved; no notification or provider action was triggered to force a result.

These open choices are separate from unverified technical coverage listed in COVERAGE.md. Neither is concealed by green targeted tests or dependency scans.
