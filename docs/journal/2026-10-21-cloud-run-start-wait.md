# Bounded cloud workflow discovery

GitHub can create the genuine push workflow after the release command's former
five-minute discovery deadline. The command then exits before observing tests,
even though the delayed run subsequently completes successfully.

Workflow discovery now waits up to fifteen minutes within the unchanged
ninety-minute overall bound. Until an exact new run is discovered, output says
that it is waiting rather than claiming tests have started. Timeout output
states the observed missing run without guessing billing or disabled Actions
and without recommending a local fallback.

SHA, workflow, push event, branch and fresh-run selection remain unchanged.
Completed old runs cannot replace the current command's evidence. Full report,
source checks and mandatory merge checks are still required. Clock/sleep/log
injection is used only by tests; production retains real time and normal waits.

Validation uses mocked GitHub responses and an injected test clock: a genuine
seven-minute delayed run, stale/wrong run rejection, fifteen-minute stop,
ninety-minute total stop including a late completed response, and the same
discovery behavior for source-only checks. No production command is run by
these tests.
