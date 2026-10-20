# Customer contact and interactive processing

Customer inbox, delivery and intake work use bounded independent slots in the
existing PostgreSQL queue. Atomic claims, attempt accounting and graceful shutdown
are retained; a long model turn or media job cannot occupy the delivery slot.

A bare customer name requires a genuine preceding server-sealed name question
accepted by the provider before that inbound message. Endpoint, ownership,
credential and current input checks remain separate from name syntax.

A committed complete contact schedules durable CRM intake through the existing
new-only lead service. It waits until the current turn and its legitimate sends
finish before changing the native client binding. An UNKNOWN send is never
repeated; an uncertain mutation commit is never treated as permission to create
again. Customer wishes remain attributed customer statements, not verified
property facts. Existing lead distribution and working hours are reused.

This change adds no emergency handover or alternative reply provider. Existing
permissions and rollout percentage are not changed by source registration.

Normal PostgreSQL regression scenarios cover lane separation, accepted name
questions, contact-to-CRM continuity and uncertain delivery. Verification is
pending CI; source checks, full API verification, release and production adoption
are separate evidence. No customer transcripts or private operational reports
are included in this change.
