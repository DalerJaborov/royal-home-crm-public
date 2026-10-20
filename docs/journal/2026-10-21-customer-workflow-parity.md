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

Read-only conversational continuity follows the actual immutable owner-approved
revision chain for the same CORE DM assignment. It carries literal customer
words across versions while preserving namespace, credential, ownership and
binding checks. Historical assistant promises, media interpretations, action
consent and delivery authority are not renewed. The ordinary strict memory
fence remains unchanged for current sources and accepted assistant output.

Normal PostgreSQL regression scenarios cover lane separation, accepted name
questions, contact-to-CRM continuity and uncertain delivery. Verification is
pending full CI; targeted PostgreSQL checks and API compilation passed during
development. Source checks, full API verification, release and production adoption
are separate evidence. No customer transcripts or private operational reports
are included in this change.
