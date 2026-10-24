# Calendar task completion error

TU01: render the actual task-completion mutation error in Calendar's shared critical alert and let the agent acknowledge it. Previously completion rejection left the task in place without explaining the failure. The acknowledgment retains the task; ordinary retry remains possible.

Actual Calendar/hooks, synthetic AGENT transport, installed Chrome at 1440 and 390: durable baseline 2 RED + 4 passing controls, unchanged regression then 6 GREEN. Cases cover failure message, acknowledgment, retry, successful completion, showing-edit validation/pending guard and failed-save draft retention. No API, task/score policy, provider or production change. Evidence and command: `docs/audit-20261024/FINAL-CALENDAR-COMPLETE-ERROR.md`.

Independent test review then caught an unpinned browser date that would make the fixed future-day fixture stale after 25 October. Pinned browser Date to 24 October before navigation; final six pass again (native0), separate raw clock-follow-up evidence preserved. This correction affects only test durability.
