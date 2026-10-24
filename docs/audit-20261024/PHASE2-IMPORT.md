# Phase 2 — CSV import contracts

Worktree: `night-audit-20261024-phase2`, base `0466aca`. Own code scope: `lib/csv.ts`, `routes/import.ts` and two new focused regression files. No commits, map regeneration, deployment or production/provider operations by this specialist. Main phase-1 worktree and its dependency tree remain untouched.

## Confirmed baseline defects and intended fixes

- NJ-02: property CSV import converted every explicit currency other than USD to TJS, including unsupported RUB, before the shared enum schema could validate it. Keep blank/missing default TJS and case normalization; reject unsupported explicit currency through the schema instead of reinterpreting its money.
- NJ-03: downloadable property template omitted `Окна`, while current apartment creation requires a window count. Add the column and a valid example, then verify an actual download/upload roundtrip.
- NJ-04: CSV separator detection counted commas and semicolons inside quotes in the first physical line. Count only separators outside quoted fields in the first logical record, recognizing escaped quotes and embedded LF/CRLF/CR. Preserve BOM handling and ordinary comma/semicolon files.

Original read-only proofs and their logs remain in the phase-1 ignored reports directory. The phase-2 dependencies were installed separately by the parent and shared build completed by its designated owner before these tests ran.

## Impact and controls

`where`/impact checks ran before edits. `csv.ts` has four direct source dependants (expense export/workspace, property list export, import); the graph tool reports ALL through the application graph. The changed private detection function is called only by parseCsv, used by the two import routes; csvSafeText export sanitization is unchanged. `routes/import.ts` serves four template/import routes and is imported by app.ts.

Prepared regression files:

- `csv-delimiter-quotes.test.ts`: 10 pure cases for quoted separators, first logical record, LF/CRLF/CR, escaped quotes, BOM and ordinary files.
- `import-currency-template-contract.test.ts`: 9 HTTP/real-PG cases for three unsupported currencies, blank/TJS/USD/case controls and downloaded-template roundtrip. Fixtures are synthetic, district-scoped and cleaned only if their own district exists; owner-contact fixture is masked.

## Execution evidence

- `reports/night-audit-20261024/phase2-import-red.log`: native exit 1, two files / 19 tests; **10 failed / 9 passed** against unchanged baseline source. Four failures reproduced currency/template contracts; six reproduced quoted-separator/logical-record detection. Existing blank/supported/case and ordinary CSV controls passed.
- Source fix: currency now defaults only a trimmed blank/missing value and otherwise reaches enum validation; template adds `Окна` plus example 4; detector scans outside quotes until the first unquoted CR/LF, skipping escaped quote pairs. Public APIs/types and CSV export sanitization are unchanged.
- `reports/night-audit-20261024/phase2-import-green.log`: native exit 0; **6 files / 36 tests passed**. Includes both new files (19), Windows-1251 import (2), non-fresh imported clients (4), property import creation rules (4) and expense CSV/formula/recurring controls (7). `git diff --check` on owned paths passed.

All API/DB checks use the specialist's own `audit_business`, synthetic fixtures and test-only keys. No live provider transport, production record or paid generation is involved. Existing negative-path tests may deliberately log application errors; their terminal test results determine success. Parent owns final build/map/guards and consolidated validation.
