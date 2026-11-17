# Completed showings in the director queue

Manual Royal Clean QA on an isolated synthetic stand reproduced a completed
showing for a closed deal in the director's today queue as awaiting a reply.
The client history correctly showed it as conducted. Completion deliberately
retains `nextActionDate` for history and KPI, but `loadShowingsToday` did not
exclude `completedAt` records (the calendar already does).

Exclude completed interactions from this pending queue. Do not change the
interaction, its history, ownership, KPI or the deal.

Validation: PostgreSQL regression failed before the fix (4 instead of 2), then
all 10 mission-control-gaps tests passed. It covers pending, confirmed,
completed, completed-confirmed, cancelled and declined showings, plus an empty
queue after completing the remaining two. API build passed. Manual director
recheck on the rebuilt local API removed the completed showing from the queue
while keeping the conducted-showing KPI visible.

Cloud release and production verification are separate from these local checks.
