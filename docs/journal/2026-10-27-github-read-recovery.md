# Recover release reads after a short connection outage

The release client previously stopped after four connection timeouts and cancelled its running cloud checks. A recorded read sequence recovered only on the fifth attempt. A separate attempt stopped at the first failed `git fetch origin main` before starting any cloud checks.

GitHub GETs now have a bounded recovery window, including truncated response bodies. The exact `git fetch origin main` read uses the same bounded policy in preparation, main synchronization and post-merge verification. Authentication, certificate and local-ref errors still stop immediately; no push or merge command enters this retry helper.

Merge writes remain single-attempt. A lost write response is marked for readback, and an unavailable or malformed readback is reported as an unconfirmed outcome instead of claiming nothing changed. Exact head/tree checks, full test artifacts, migration guards and mandatory source checks remain in place. CRM code, roles, model/provider configuration, rollout and numeric budgets are unchanged.

Regression coverage reproduces the four-timeout sequence, truncated reads, exhaustion/deadline, forbidden responses, explicit zero retry, lost write responses and fixed fetch arguments. Local Windows excludes the same pre-existing platform-specific fixture cases; the ordinary Linux source workflow continues to run those cases.
