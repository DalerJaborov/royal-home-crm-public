# All release scopes use cloud validation

Backend and shared changes keep the full API workflow on twenty runners.
Frontend, documentation and release-script changes now use the cloud source
workflow as well: the laptop only synchronizes the branch and verifies results.
The source-only gate requires the exact commit, CI workflow path and exactly
one completed successful `precheck` job. Missing, skipped, failed and unrelated
runs are rejected. Regression tests cover these refusal cases.

Changes to API test files now require the complete API workflow: the source-only
job has no PostgreSQL and must not silently omit changed database tests.
`--local-tests` remains an explicit local fallback.

The release message reports a verified GitHub merge without claiming deployment.
The new public repositories are not yet connected to the production servers.

The first protected source-only release validated successfully but GitHub
returned 405 while the parallel PR precheck was still finishing. Ship now waits
through read-only PR status checks before its single merge request, requiring
unchanged head/main commits. Conflicts and a bounded wait failure stop the
release. Regression tests cover pending-to-clean and commit/protection failures.
