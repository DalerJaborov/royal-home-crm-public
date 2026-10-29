# Align dashboard overdue tasks with the shared task rules

The dashboard control summary used its own task predicate and counted unfinished
tasks belonging to deleted clients or completed assignments. The oversight page
already excludes these through TASK_WHERE. The summary now uses that same rule,
while retaining role-based investigation visibility and its existing row limit.
The disabled active-client limit now has an explicit explanation rather than
describing a limit of zero.

Validation: a database regression fails against the baseline when an assignment
is completed, and passes with the shared predicate. All eight mission-control
gap tests pass; API build and generated-map checks pass. Complete cloud release
validation and production verification remain separate requirements.
