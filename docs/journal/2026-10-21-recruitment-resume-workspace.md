# Candidate résumé and staff recruitment communications

The former eligibility buckets obscured HR stages and incomplete new-core
applications. Recruitment now opens a candidate queue and readable résumé with
original materials, literal source quotes and an explicit next action. Unknown
fields remain unknown; human hiring decisions remain separate from screening.
The queue uses server pagination, stage and position filters, including older
records. Previous query results cannot expose actions under a changed filter.
Sidebar and dashboard counts now count the same genuine new HR replies,
including missing-phone applications, rather than the retired fit bucket.

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

Final UI review covers the actual résumé and invitation components at desktop,
390px mobile, 320px narrow and 1024px tablet layouts. Position settings use the
same fields and surfaces, keep role requirements visible and collapse technical
publication mappings. Read-only profiles cannot open a position write flow even
when their permission list contains settings.manage. Communication language is
labelled separately from languages mentioned in a résumé. The synthetic catalog
fixture now uses the complete shared schema and revision-aware updates.

Short status answers use separate work/study aliases in Russian and Tajik.
An answer about work cannot populate the study field or vice versa; explicit
independent facts remain sourced. Contradictory, third-party and future answers
stay unresolved, while status replies and plain yes/no cannot become a name.

The first full cloud gate exposed a schema/default mismatch and a contact-router
validator leaking into unrelated vacancy endpoints. The ledger schema now declares
the database's existing timestamp default; all four additive SQL migrations stay
unchanged. UUID validation remains strict on the three new contact endpoints while
historical conversation/ATS routes retain their behavior. Legacy call tests now
seed historical records explicitly and verify the retired PATCH launch is rejected
without side effects; receipt, no-answer, rescheduling and history checks remain.
