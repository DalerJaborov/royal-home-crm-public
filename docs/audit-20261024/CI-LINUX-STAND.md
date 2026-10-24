# Linux source-plan failure and stand link correction

The exact3305fdc workflow40040133970 failed in its source-plan job before API workers started. Linux builds, frontend305files/1877tests and source guards passed, but two stand regression tests failed with `spawnSync cmd ENOENT`. The API matrix and verdict jobs were skipped; this is not a completed API test run.

Attribution: the overnight package connected an existing stand test file to test:scripts. Its creation/idempotency cases call the actual helper, which still invoked Windows cmd/mklink unconditionally. Windows14/14 passed, so that local result did not cover the Linux call path. The new CI break belongs to this audit package, rather than a new production CRM defect.

Correction: use Node fs.symlinkSync with junction on Windows and directory symlink on POSIX. Existing target/realpath checks, foreign-link refusal, no-op behavior and return values remain unchanged. No test skip or guard suppression was added. Native Windows14/14 tests passed after the correction. Actual Linux confirmation remains pending the next ordinary source-plan run.

Source-map/impact tooling ran before editing. Raw initial Linux RED: cloud-final-failed-plan.log. Patched Windows GREEN: stand-native-links-green.log and native exit0. Full-package checks must be rerun on the next frozen head; no green cloud/full-suite result is inferred from this local correction.
