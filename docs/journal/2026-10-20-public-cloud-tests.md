# Public source and cloud test workflow

The public repository starts from a clean source snapshot. Historical customer
incident reports, screenshots, local settings, prior PRs and unfinished work are
retained in the private repositories and the verified local recovery archive.

The initial administrator phone is required through `SEED_ADMIN_PHONE`. The
legacy caption override reads `MARUF_CAPTION_PHONE`, falling back to the public
agency contact. Private runtime databases and packaged Android binaries are
excluded from the public exports.

`npm run ship` uses the complete API suite on twenty standard GitHub Linux
runners, three isolated database workers per runner. It checks the exact commit
and every machine's report; a missing report or failure blocks the release.
`--local-tests` retains the local fallback. Source checks, frontend tests and
release-tool tests also run on GitHub-hosted Linux; there is no self-hosted
runner or production secret in these workflows.

The release workflow first runs the build, frontend suite, source guards and
release-tool regression tests on GitHub. Its planning job must pass before the
twenty API jobs start. Ship requires an explicit successful source-check
attestation for the same commit in the final report, so moving work off the
laptop does not remove a release gate. Historical static tests locating stages
by their human labels now locate stage numbers and require both stages to exist.

The first real bootstrap release exposed a GitHub API edge case: looking up
`actions/workflows/ship-tests.yml/runs` returned 404 while the new workflow was
already running from the release branch. Run discovery now uses repository-wide
runs and requires the exact workflow path, commit, push event, branch and start
window. A regression test rejects other workflows, commits, events and old runs.

Frontend workers are capped at four: all 271 files / 1,658 tests passed locally
in 64.87 seconds with this cap. The original eight frontend failures were
5-second timeouts under concurrent load; test timeouts remain unchanged.

Cloud run URLs and measured complete-suite times will be recorded after the
new public workflow finishes. Older measurements from the private repository
are not used as proof for the new public workflow.
