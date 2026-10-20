# Public repository fallback for source synchronization

The synchronization helper already receives GITHUB_REPOSITORY in Actions. Its fallback for an explicit invocation outside Actions now also points to the public CRM, so a configured token cannot silently target the private archive by default. Application code, runtime policy and database schema are unchanged.

This source-only change follows the independently validated migration release and still uses npm run ship with cloud source checks.
