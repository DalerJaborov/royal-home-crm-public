# Client lifecycle, traffic light and status presentation

Automatic inactivity and temperature classification used different definitions of
contact. Answered station calls without an AI outcome, legacy recordings, manual
calls, completed meetings and current incoming-message timestamps could be missed.
The no-answer worker could reuse a telephone streak despite newer contact elsewhere.
Repeated or delayed decisions could reset an existing inactive clock or cross a
terminal state, ownership change or return to work.

The change shares actual-call and held-meeting predicates, rejects stale decisions,
uses guarded writes for transitions and traffic counters, preserves terminal states,
clears obsolete inactive fields on return/defer, and scans successive batches instead
of permanently stopping at the same first 500 candidates. Incomplete legacy traffic
records start a fresh cycle rather than being charged for an unknown past period.
The retention sweep also checks recent contact and outstanding return offers.

The client header and rows use one primary lifecycle label on desktop and mobile.
Trash/security review, terminal outcome, deferred/inactive state and acceptance take
precedence over temperature. Duplicate inactive/temperature/hidden-reason badges
are removed. Missing depth is neutral; a cleared security review is not pending.
Historical enums and customer history are retained.

The discipline settings describe automatic checks rather than removed push reminders,
show the actual intervals through loss, expose inverted depth ordering, and provide a
form preset matching the existing application policy. Schema defaults now match the
fallback. The migration changes defaults only: it does not rewrite saved settings or
client states. Existing policy values require an explicit save through Settings.

Regression coverage includes all contact channels, stale/duplicate transitions,
terminal and deferred states, manual return, incomplete clocks, concurrent ticks,
pagination, privacy-preserving acceptance flags and a single primary badge. The
initial reproduction failed 16 of 19 targeted scenarios before implementation.
Source validation, browser checks and production rollout are separate evidence;
this journal does not assert a deployment or repair of historical customer records.
