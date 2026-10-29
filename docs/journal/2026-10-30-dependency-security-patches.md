# Dependency security updates

The lockfile audit reported 13 production dependency findings, including proxy-addr, request parsing/upload handling, image processing and validation libraries. Refresh compatible lockfile resolutions without changing manifest ranges or using force upgrades. The lockfile-only production audit now reports zero findings; four low-severity development-tool findings remain.

The proxy-addr advisory requires a specially misconfigured IPv4-mapped IPv6 trust subnet. The application's fixed trust-proxy configuration does not establish that exploit condition, so the scanner result is not proof of a production compromise.

Release requires the full cloud API suite, frontend/build checks and runtime-image validation. Audit counts alone do not establish runtime compatibility or absence of all vulnerabilities.
