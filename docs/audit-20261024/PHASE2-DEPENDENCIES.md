# Phase 2 dependency remediation

## Trigger and change

The baseline lockfile's version-matched advisory scan reported12 affected production package entries (1critical,8high,3moderate). A separate installed skill collector checked the full lock tree including development tooling and reported15 affected package/version entries among1132 registry-verified entries, with5 unverified registry entries. These differing scopes are retained; neither number is an exploit count. First-package source, lockfile and shared node_modules remained frozen during its complete API run.

Updates were performed only in the phase2 worktree's independent real node_modules. A normal `npm audit fix --dry-run --ignore-scripts --json` plan was reviewed, followed by compatible manifest floors for Prisma, multer, sharp and Zod, then `npm audit fix --ignore-scripts --no-fund`. No `--force`, arbitrary transitive major override, production configuration or migration was used. The compatible Prisma parent release itself changes its deepmerge-ts dependency to8.x.

| Package | Before | After |
| --- | --- | --- |
| @prisma/adapter-pg, @prisma/client, prisma, @prisma/config |7.10.0 |7.10.1 |
| body-parser |2.3.0 |2.4.0 |
| proxy-addr |2.0.7 |2.0.8 |
| multer |2.3.0 |2.5.0 |
| sharp |0.35.4 |0.35.5 |
| zod |4.6.2 |4.6.7 |
| deepmerge-ts |7.1.5 |8.0.2 |
| mysql2 |3.15.3 |3.24.4 |
| vite |8.3.0 |8.3.5 |
| vitest |4.1.11 |4.1.12 |

Other compatible transitive changes are recorded in package-lock.json and the dry-run plan. Native update exit0:4added,8removed,42changed,1052audited. No newly downloaded install scripts were run by the update. Prisma generation was then explicitly run and succeeded with client7.10.1.

## Validation state

- Independent post-update `npm audit --json`: exit0, metadata0info/0low/0moderate/0high/0critical. Raw dependency-audit-patched-r1.json retained under reports/night-audit-20261024. This means no advisory reported by that source for these resolved versions at that time, not proof that the packages contain no vulnerabilities.
- Prisma generate exit0; git diff --check exit0.
- Regenerated product map and consolidated precheck are running; final API/browser compatibility evidence is pending. The earlier phase2 targeted green tests used the previous dependency tree and are not represented as post-update evidence.
- Native sharp/image operations, boundary schemas, multipart uploads, normal/malformed JSON and the complete API suite must be covered proportionately before a final ready claim. No exploit payload is required to validate a compatible dependency update.

See the first-package DEPENDENCIES.md for source-level advisory preconditions and primary advisory links. No production exploitation, deployment or provider result is claimed.

## Independent collector follow-up

The first post-update collector still found the low build-time advisory [GHSA-m5mm-p8h7-m29v](https://github.com/advisories/GHSA-m5mm-p8h7-m29v) against serialize-javascript7.0.7, although npm audit reported0. Its documented prerequisite is attacker-controlled serialized function source, including a spoofed function toString; ordinary string serialization alone is not that prerequisite. CRM exploitability was not established or tested. The dependency comes through the development Rollup terser tooling.

A normal named npm update with install scripts disabled changed exactly that package to7.1.4 (fixed floor7.1.3), without an override. The second collector completed2026-10-23T23:43:30UTC: no matching known advisories in3 root direct tooling dependencies or1129 registry-verified transitive entries;5 lockfile entries remained unverifiable by this collector. Its non-advisory maintainer criteria cover only the3 root tooling dependencies, not all workspace packages. Raw supply-chain-findings-r2.json and supply-chain-report-r2.md remain local. The subsequent frozen-package build/full verdict must be recorded separately.

Post-first-update compatibility had passed15API files/110tests plus3files/12tests, actual mammoth/sharp/multipart operations, Chrome8settings/form cases and6recruitment cases. Exact3305 precheck later passed305webfiles/1877tests, builds and executed guards. These precede the last serialize-javascript-only update and are not presented as its build verification.
