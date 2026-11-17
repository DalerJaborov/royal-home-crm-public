# Quick showing opens scheduling without a preselected property

Manual mobile HEAD_OF_SALES QA reproduced the quick action “Записать показ”
opening the past-conversation wizard after choosing a client. The caller passed
SHOWING but no property; the shared modal only inferred scheduling when a
property was already selected.

Pass the existing explicit `mode="schedule"` from ShowingQuickForm. Both its
clean and legacy client pickers now open the same future-appointment form,
with property/date/time selection, rather than the past-conversation AI flow.

Four caller-contract regressions failed before the fix and passed afterward;
28 related frontend tests passed. Manual mobile recheck displayed “Назначить
показ” and empty submission stayed in the form with focus on the required date.
No production appointment or external notification was created by this QA.
