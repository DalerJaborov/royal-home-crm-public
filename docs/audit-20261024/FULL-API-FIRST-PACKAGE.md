# Complete API run: first package

Source pin: `0466aca29e9090e046e8affdf93760c9224144bd`. Started22:45:11UTC23October; ordinary local `npm run test:api`,4workers, owned audit_parent database and worker clones. Native exit **1** after1911.3seconds. This run was completed and failed; it is separate from the earlier deliberately interrupted attempt.

| Metric | Result |
| --- | ---: |
| Physical test files |1482 |
| Passing files |1479 |
| Failing files |3 |
| Total tests |13985 |
| Passed tests |13934 |
| Failed tests |2 |
| Skipped tests |46 |
| TODO tests |3 |

One failing file failed during setup, so its46tests are skipped rather than counted as individual failures. The runner's4709 suite blocks are not physical file count. Raw stdout, native exit file, exact source pin and four original Vitest JSON shards are retained under reports/night-audit-20261024/api-full-local-final*.

## Diagnosed failures

1. `customer-legacy-physical-postgres.test.ts`: its strict setup guard found29 foreign unattributed physical attempts. On a fresh owned database, unchanged legacy tests passed46/46; running unchanged instagram-comments71tests first left exactly29synthetic UNKNOWN attempts, then the same legacy setup failed0→29. The comment fixture's fake response lacked real Response.clone and omitted cleanup of its own physical-attempt records. The guard and production safety behavior remain correct; fixture repair is being validated separately.
2. `customer-accepted-callback-question-postgres.test.ts`: working-hours case expected assigned but received unassigned. This reproduced unchanged on a fresh owned database (11pass/1fail). The fixture did not create its own eligible active agent. A fixture-only correction is being validated without changing real assignment policy or weakening the expectation.
3. `recruitment-document-text.test.ts`: require.resolve could not find declared mammoth in the reused first-package dependency install. The phase2 fresh independent npm install resolves the dependency; all4document-text tests passed there unchanged, including actual Word bytes and literal field extraction. No source bug or production dependency outage is inferred from the first install gap.

The fresh phase2 dependency tree also passed a15-file/110-test compatibility group and a separate3-file/12-test group after the advisory updates. Groups have explicitly named scopes and are not a substitute for a final consolidated run. Two non-existent CLI filter names in the first compatibility invocation matched no files; its actual result is15files/110tests, not17files. The missing intended import controls were included in the later3-file group.

## Consequence

The first package has no green complete-API verdict. Phase2 includes new source fixes, compatible dependency updates and confirmed fixture repairs; those changes justify a fresh consolidated run after its final source freeze. No production or provider verification follows from either a local test or a draft PR.
