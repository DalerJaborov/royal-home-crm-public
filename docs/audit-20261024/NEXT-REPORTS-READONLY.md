# Read-only pass — reports, period filters and catalogue export

Source inspected: frozen phase-2 `3305fdc`, `D:/PublicWorktrees-20261021/night-audit-20261024-phase2`. No app/default-test/dependency/source changes, broad suites or live configuration/provider/production writes. This report is saved in the main audit worktree as requested. Existing expense/payment/deal fixes were excluded from new defect hunting.

Started from generated product map entries for /reports, /reports/{funnel,agents,sources,lost-by-channel,response-speed,demand-supply}, /ads/report and /properties/export, then read the corresponding code and actual UI callers. The coverage matrix remains an inventory: reading a module is not a completed behavioral check.

## NR-01 — loss percentage mixes two different cohorts

**Confirmed wrong aggregate; the intended replacement metric needs a policy choice.** `routes/reports.ts:442–487` counts LOST clients by recent escalatedAt, but divides by all clients created recently. Old clients lost this period are not necessarily members of the denominator. `web/src/pages/Sources.tsx:734–768` labels the result “доля потерянных лидов канала” and renders “N лидов из M”, so percentages above 100% are misleading for the stated subset share.

Actual authenticated HTTP + real PostgreSQL reproduction on fresh owned `audit_reports`:

- Create one WEBSITE lead yesterday and two WEBSITE leads 120 days ago, mark only the old two LOST with escalatedAt yesterday.
- GET /api/v1/reports/lost-by-channel as an owned ADMIN returns HTTP 200, days=90, `lost:2,totalLeads:1,lostShare:200`.
- Expected for a labelled share: numerator and denominator describe the same lead cohort; “2 out of 1” must not be presented as a subset share. This does not establish whether product wants cohort conversion or counts of transitions during the reporting window.

Root cause is the mismatched date predicates, not a missing percentage clamp. The same source pattern is independently present in `lib/marketingInsights.ts:117–146`, whose `summarizeLost` at 79–85 prints “потеряно N из M”. That AI-fed variant was source-traced only; generation was not invoked.

Reviewable fix options: retain recent-loss flow counts but separately compute losses from the created-in-window cohort for the percentage; or explicitly rename/redefine the existing ratio as transitions/intake. Do not clamp 200 to 100 or silently drop old losses from the count without deciding that distinction. A regression should include old-lost/new-active, all-losses-in-cohort, no recent leads and deleted clients, and use one helper for UI/AI inputs if that policy is unified.

## NR-02 — invalid calendar periods silently select another period

**Confirmed boundary-validation defect.** In `routes/ads.ts:440–468`, month has only a shape regex, then Date.UTC normalizes month 00/13 into adjacent years. Explicit day ranges test only NaN, which does not reject JavaScript rollover dates, and do not reject inverted ranges. `reports.ts:140–155` uses shared `querySchemas.ts:277–280` date coercion with the same rollover/reversal issue.

Actual HTTP + real PostgreSQL responses, all HTTP 200:

| Request | Actual response period |
| --- | --- |
| /ads/report?month=2026-13 | 2027-01-01 … 2027-01-31, label January 2027 |
| /ads/report?month=2026-00 | 2025-12-01 … 2025-12-31, label December 2025 |
| /ads/report?from=2026-02-30&to=2026-03-02 | 2026-03-02 … 2026-03-02, but label still contains 2026-02-30 |
| /ads/report?from=2026-10-20&to=2026-10-01 | inverted period returned unchanged |
| /reports/funnel?from=2026-02-30&to=2026-03-02 | normalized March 2 local-day range |
| /reports/funnel?from=2026-10-20&to=2026-10-01 | from 2026-10-19T19:00Z > to 2026-10-01T18:59:59.999Z |

Expected: reject nonexistent month/day and reversed periods with a structured 400; do not substitute a different calendar period behind the requested labels. Existing ads-routes coverage rejects an Invalid Date such as 2026-13-99, but that does not cover valid-Date rollovers such as February 30. This family is separate from the already fixed finance forecast month handling.

Source blast radius: resolvePeriod has six call sites in ads.ts; normal reports parseRange is shared by funnel/agents/sources. Shared dateRangeQuerySchema also extends into interaction feed/audit schemas, so a global schema rewrite would need separate caller review. Minimal plan: strict round-trip calendar parsing + explicit month bounds + from<=to checks at the relevant period boundary, preserving Dushanbe instant-day handling for reports and UTC DATE handling for advertising daily rows. Regression fixture can reuse the exact authenticated requests above, plus valid same-day/leap-day/month-rollover controls. No fix was made during the source freeze.

## Executed controls and rejected suspicions

Separate ignored control probe executed actual CSV and JSON catalogue-export HTTP against four owned properties: two AVAILABLE, one SOLD, one soft-deleted AVAILABLE. Both formats returned the same two IDs, ten CSV fields, quoted multiline/semicolon/double-quote title, formula-safe address, preserved zero price and blank null rooms. SOLD/deleted rows were excluded. CSV parsing used the actual source parser; no browser/Excel claim is made.

Catalogue export does **not** inherit the Reports screen's date filter: source explicitly defines it as the entire AVAILABLE catalogue, and the actual frontend download function sends format only (`hooks/useReports.ts:7–16`, `Reports.tsx:169`). This is not reported as an ignored-filter bug. It remains a full-catalogue export by design.

Pure source-function controls passed: response-speed boundaries at 0/1/5/15/60 minutes; empty fold returns zero shares/null rates; negative response delay is excluded; leap-February monthRange ends at 2024-02-29T19:00Z (March 1 midnight Dushanbe). Missing Settings fallback yields a finite positive conversion context and zero USD amount converts to zero, without any rate/settings writes. A valid same-day /reports/funnel request returned the correct 2026-09-30T19:00Z … 2026-10-01T18:59:59.999Z interval.

Other source-only checks: response-speed uses created-at cohort consistently for its showing/deal relation queries and flags 20000-row truncation; demand-supply explicitly handles low samples/no supply without division by zero; monthly-report boundary uses next local month exclusive. No new bug was confirmed in those inspected portions. Marketing funnel's current-month counters are explicitly documented as period activity, not a cohort funnel; that intentional distinction is not conflated with NR-01's labelled share.

## Evidence and isolation

Ignored artifacts live under phase-2 `reports/night-audit-20261024/`:

- `reports-readonly-probe.mts` / `.log`: native Node exit 0, real authenticated routes and PostgreSQL proofs above. Initial setup attempt exited 1 because the schema-only template has no Settings row; the probe was corrected to accept missing/disabled ads configuration without creating settings. No finding is based on that setup failure.
- `reports-controls-probe.mts` / `.log`: native Node exit 0, pure controls and CSV/JSON parity.

Owned DB was created as `audit_reports TEMPLATE audit_template` in the existing own loopback-15439 container. No foreign/full-suite DB was used. Both probes pin external environment and replace fetch with a throwing stub; the ads setting was verified not enabled and no sync/provider call was requested. HTTP was local in-process via supertest; all business queries/rows were real PostgreSQL, not Prisma mocks.

Only captured fixture IDs were removed. One late best-effort export audit entry arrived after the probe's initial cleanup; it was identified and deleted by its exact synthetic audit ID + captured owned agent ID + PROPERTIES_EXPORT action. Final readback: Agent=0, Client=0, Property=0, District=0, AuditLog=0 in this own schema-only database. No bulk cleanup, schema reset or DB drop occurred.

Limits: bounded report/export pass; no paid AI insight generation, advertising sync, real notification delivery, browser rendering, production access or exhaustive role/data-volume test. NR-01's visible mathematical inconsistency is reproduced; selecting its business metric remains unresolved. NR-02 is reproduced but unfixed while the source package is frozen. Parent owns prioritization and any next review-ready correction.

## Proposed followup scope after parent opened freeze

Parent explicitly leaves NR-01 policy-uncertain and authorizes planning only for NR-02 until review. Installed Zod 4 `z.iso.date()` was checked directly: rejects 2026-02-30 and non-leap 2026-02-29, accepts leap 2024-02-29; no new dependency needed. Existing expenseDateSchema has an unrelated 1900–2199 year bound, so reusing it would silently add policy outside this report's scope.

Proposed API-local reusable calendar checker (`lib/reportPeriod.ts`), ads day/month field validation plus reversed-period rejection, and a LOCAL derived reports schema; keep global shared dateRangeQuerySchema and its `.extend` callers unchanged. Preserve report ISO timestamps/Date coercion, Dushanbe day boundaries and MAX_RANGE cap; advertising stays UTC DATE. Durable real-PG/HTTP RED and valid boundary controls should precede implementation. No application/shared source change has yet been made by this worker.

Source pins captured while unrelated parent changes continue: ads.ts SHA-256 `c7f2b761dd00d5ec9e2e6d5cfcbf4855cdb7f8b2e8bc1691f0f482817483628c`; reports.ts `1daa5eb0f904f06faff9a93d6389a84a511843519013c5714be67c2f9a4361c9`; shared/querySchemas.ts `c62df5b2f908c2a13e22a0db35c5b523e0501eda6131b727e0b73a41867b3a07`. The build-only serialize-javascript dependency update occurred after the original probes; it does not replace their retained evidence.

After explicit parent approval and durable RED, NR-02 was corrected only in the phase-2 worktree. See phase-2 `docs/audit-20261024/PHASE2-REPORT-PERIODS.md` for the narrow helper/two-route diff, source hashes and final evidence (RED22failed/8controls; GREEN5files66; final33-case regression after3additional controls). NR-01 remains policy-uncertain with no formula change. This followup does not retroactively change the read-only baseline evidence above.
