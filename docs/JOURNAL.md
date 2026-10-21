# Public source journal

The current source was exported on 2026-10-20. Historical incident reports, customer records, screenshots and prior pull requests remain in the private archive.

## 2026-10-22 — Package Prisma's migration engine for the runtime ABI

The build image lacked OpenSSL and selected a 1.1 schema engine while the final image used OpenSSL3. Migration startup could then depend on downloading another engine. Install matching build prerequisites and require the final image's Prisma CLI to work without a network. Source CI builds and records this actual image check for runtime/dependency/gate inputs; docs-only edits avoid that extra build. No database, Prisma version, customer policy or permissions change. Deployment and production verification remain separate from the source check.
