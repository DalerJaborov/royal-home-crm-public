# 2026-10-24 — report calendar period validation

Advertising and ordinary report boundaries silently normalized nonexistent dates/months or accepted reversed windows. Added API-local shared calendar schemas and narrow ads/reports validation; global shared dateRangeQuerySchema and loss-percentage policy remain unchanged.

Actual own-PG/HTTP baseline RED:22 failed/8 valid controls passed. Targeted GREEN:5files66passed; final new regression file33passed after3additional compatibility controls. No providers/full suite/production changes. Evidence and source hashes: docs/audit-20261024/PHASE2-REPORT-PERIODS.md. Parent review/integration pending.
