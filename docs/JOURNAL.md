# Public source journal

The current source was exported on 2026-10-20. Historical incident reports, customer records, screenshots and prior pull requests remain in the private archive.

## 2026-10-22 — Package Prisma's migration engine for the runtime ABI

The build image lacked OpenSSL and selected a 1.1 schema engine while the final image used OpenSSL3. Migration startup could then depend on downloading another engine. Install matching build prerequisites and require the final image's Prisma CLI to work without a network. Source CI builds and records this actual image check for runtime/dependency/gate inputs; docs-only edits avoid that extra build. No database, Prisma version, customer policy or permissions change. Deployment and production verification remain separate from the source check.

## 2026-10-30 — Run station health beside the ARI listener

The worker's station health check read its own empty ARI socket and pause state, raising a false disconnected warning even when the API listener was connected. Schedule the same check in the API process and register its cadence for the worker heartbeat watchdog. Preserve actual disconnected/paused checks, overlap protection and error reporting. Regression ownership tests failed before the move; 25 targeted ownership, robot health, heartbeat and timezone tests pass afterward. No routing, account or customer data changes.

## 2026-10-30 — Source failure diagnostics and role labels

Somon network failures previously lost their cause, and HTTP errors omitted the status in the journal. Retain bounded timeout/DNS/connection/body-limit codes and HTTP status without copying upstream URLs, bodies or credentials. Preserve the request budget, backoff and stop gate. Test timeout, DNS, generic failures, forbidden responses and a stopped source.

Browser QA on an isolated seeded database found that the manager summary called agents with no pending acceptance requests free even while their active workload was nonzero; name that metric explicitly. Use the shared role label for a shareholder who also uses this dashboard. Builds and 1992 frontend tests pass; 94 role/oversight/Somon tests plus 20 source/parser/delivery tests pass. Live source availability is distinct from recovery and delivery proof.
