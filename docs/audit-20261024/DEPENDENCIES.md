# Dependency advisory review — 24 October 2026

## Evidence and scope

The frozen first-package lockfile was scanned with `npm audit --omit=dev --json`. Native exit1 indicates reported advisories. Raw ignored evidence: reports/night-audit-20261024/dependency-audit-r1.json. The metadata reports12 affected package entries:1critical,8high,3moderate. Entries include transitive parents and multiple advisories; these counts are not independent CRM defects or demonstrated exploits. Installed package versions were checked against the lockfile. No exploit payload was executed for this review.

The installed supply-chain-risk-auditor collector and renderer completed successfully (collector native0). Its root-manifest direct-dependency view measures3 development dependencies, not the API/web workspace direct dependencies. Its full-lock advisory sweep checked1132 registry-verified entries beyond that direct set and flagged15 package/version entries including development tooling;5 lockfile entries lacked registry attestation and were not checked. These results differ in scope from npm's production-only12 package entries. Raw JSON and rendered coverage table are retained in reports/night-audit-20261024/supply-chain-findings-r1.json and supply-chain-report-r1.md. No complete workspace maintainer/license/install-script assessment is claimed. No maintainer, popularity or abandonment figures have been estimated.

## Version-matched findings and source interpretation

| Package | Locked / fixed | Source interpretation and next action |
| --- | --- | --- |
| proxy-addr |2.0.7 /2.0.8 | Critical advisory requires a particular misconfigured mapped-IPv6 trust prefix. app.ts uses named loopback/linklocal/uniquelocal trust only when TRUST_PROXY=1; this exact advisory precondition was not found in static source. Patch update remains appropriate. |
| body-parser |2.3.0 /2.4.0 | express.json has a1MB limit and default inflate behavior. The advisory describes an uncaught decompression error before route authentication. Version and middleware path match; actual process crash was not tested. Prioritize the compatible update. |
| sharp |0.35.4 /0.35.5 | Advisory affects embedded SVG processing with platform/runtime preconditions. Linux image decoding reachability and runtime conditions remain unverified. |
| multer |2.3.0 /2.4.0 | Advisory concerns aborted disk-storage multipart requests leaving files. Version matches; reachable route and cleanup consequences need proportional regression review. |
| zod |4.6.2 /4.6.6 | Resource exhaustion on oversized invalid values. The API body limit bounds some inputs but does not establish absence. Shared/API boundary behavior must be checked after updating. |
| deepmerge-ts |7.1.5 /8.0.0 | Cyclic object recursion; JSON cannot represent self references. Current path is through Prisma configuration. Do not introduce a forced transitive major override without the compatible parent update. |

Other reported entries: @prisma/config, prisma, brace-expansion, fast-uri, ip-address and mysql2. Parent/transitive relationships and available compatible updates require lockfile review before mutation. Frozen first-package dependency files and shared node_modules remain unchanged. Phase2 has its own install so any later update cannot invalidate the running first-package suite.

Primary advisory sources: [proxy-addr](https://github.com/advisories/GHSA-jqcg-44mw-7w3h), [body-parser](https://github.com/advisories/GHSA-27r3-jxmh-p828), [sharp](https://github.com/advisories/GHSA-wq5f-xc86-pv6w), [multer](https://github.com/advisories/GHSA-3pph-fpjx-jg34), [zod](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), [deepmerge-ts](https://github.com/advisories/GHSA-ggr8-5vv4-36mx). Advisory descriptions were checked against these sources during this run.

## Status

No dependencies have been updated yet. No production exploit or deployed fix is claimed. A later clean advisory scan would describe the assessed versions only and would not establish that dependencies are free of vulnerabilities.
