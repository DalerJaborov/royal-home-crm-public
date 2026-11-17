# Make the working client tab match its label

The buyer/seller working tab requested the unrestricted client list and counted
all undeleted clients. Inactive, lost and completed assignments therefore
appeared under the working label on both desktop and mobile.

Add an explicit inWork list scope and a shared server predicate for that scope
and the buyer/seller counters. The scope requires an active, nonterminal,
undeleted client with an unfinished assignment. The ordinary working tab uses
it; search, explicit status/work-status filters, all-mine and special drilldowns
retain their existing historical access. No client records or ownership change.

The scope is independent of the search AND clause so fuzzy search cannot remove
it. Regression coverage reproduces the old counter mismatch and verifies the
working list, historical search and inactive list. Validation: 35 targeted API
tests and all 1992 frontend tests passed, plus shared/API/web builds and maps.
Full cloud release checks and production verification are separate requirements.
