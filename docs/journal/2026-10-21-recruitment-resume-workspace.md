# Candidate résumé and staff recruitment communications

The former eligibility buckets obscured HR stages and incomplete new-core
applications. Recruitment now opens a candidate queue and readable résumé with
original materials, literal source quotes and an explicit next action. Unknown
fields remain unknown; human hiring decisions remain separate from screening.
The queue uses server pagination, stage and position filters, including older
records. Previous query results cannot expose actions under a changed filter.

Each position owns versioned screening rules. Sales-agent templates retain
their age/study/employment requirements; other templates do not inherit them.
Missing facts produce role-specific Russian/Tajik questions. Short answers are
interpreted only against an actually accepted, projected prior question for the
same inquiry. Existing uploaded PDF perception is reused; Word raw text is
extracted in a bounded worker while the original remains in private storage.

Staff may preview and confirm an invitation or missing-information request by
SMS and/or assistant call. The durable staff ledger is distinct from BOT_TURN:
new-core applications retain their real inquiry fence; historical applications
need explicit HR position assignment and retain their distinct source binding.
No historical record is relabelled as a genuine managed input. HR phone edits
are preserved by the core projection. Concurrent changes invalidate previews;
an active assistant call prevents changing its appointment or recipient.

Appointment persistence, provider acceptance, SMS delivery and candidate
confirmation are separate states. Attempts are recorded before physical I/O;
unknown outcomes cannot be resent. The SMS webhook has a durable receipt inbox
for callbacks arriving before the POST response. Assistant testimony remains
visible for HR verification and does not fabricate canonical facts or a hiring
decision. The retired role-agnostic invitation scheduler no longer originates
calls; its historical rows and recordings remain available.

The résumé question protocol has a separate exact V2 upgrade with explicit
owner acknowledgement. Historical V1 pins, provider/limits/scopes/capabilities,
rollout percentage and controller checks remain unchanged. Source preparation
does not activate that protocol or change production policy.

Validation uses a dedicated disposable PostgreSQL container, synthetic résumé
documents, mocked transports, frontend semantic tests and production builds.
The browser demo uses actual components with explicitly synthetic API data;
its send result is DRY_RUN. These checks do not prove real provider delivery.
Exact-commit cloud release and independent production verification remain
separate gates; no real candidates are contacted during tests.
