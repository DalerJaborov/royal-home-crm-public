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

An exact receipt-backed own intake relation preserves customer words and contact
availability across the bridge's new Client binding and its single normal
assignment. Name-only contact updates retain the real earlier phone receipt;
they do not pretend the latest input contained a phone. A foreign native rebind,
deletion, later reassignment or takeover cannot revive that relation. Historical
input and OUT fences remain unchanged.

The managed FINAL adapter now records the genuine inbound in the existing
outbound shield, which the legacy-only webhook loop did not do for CORE. The
original arrival time and exact endpoint are retained. It records reply activity
without clearing a native pause or replacing the captured controller. Existing
initiative/global/repeat protection stays enabled.

Normal PostgreSQL regression scenarios cover lane separation, accepted name
questions, contact-to-CRM continuity and uncertain delivery. Verification is
pending full CI; targeted PostgreSQL checks and API compilation passed during
development. Source checks, full API verification, release and production adoption
are separate evidence. No customer transcripts or private operational reports
are included in this change.

The first full cloud run exposed an UPDATE plan that could claim more than the
single job returned to the runner. A materialized locking selection now fixes
the batch at one row. Regression assertions verify the second job remains
pending while the first handler is blocked. Tests that create genuine managed
inbound shield state also clean up their own dependent rows before deleting
scopes; policy restoration is protected by finally. Failed full-run evidence is
retained, and a new complete cloud run remains mandatory.
