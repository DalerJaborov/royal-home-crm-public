# Independent review: phase 2 CSV/import fixes

**Scoped conclusion: APPROVE for parent integration; no actionable introduced defect found.** This is a read-only review of the current worktree diff from `0466aca29e9090e046e8affdf93760c9224144bd`, not release/production acceptance. No source/test edits or suite reruns were performed by this reviewer.

| Finding severity | Count |
| --- | --- |
| Critical / high / medium / low introduced findings | 0 / 0 / 0 / 0 |

Residual scope risk is bounded: parser behavior affects both imports, so parent still owns final integration/build/guards. The patch's targeted evidence is meaningful; it does not establish all import workflows.

## Scope and history

Reviewed both complete changed source mechanisms and both new regression files: `apps/api/src/lib/csv.ts`, `apps/api/src/routes/import.ts`, `apps/api/tests/csv-delimiter-quotes.test.ts`, `apps/api/tests/import-currency-template-contract.test.ts`. Source diff is +20/-5 lines across two files. Git history/blame places the original detection/currency behavior in the cleaned public bootstrap; the modifications are the current uncommitted phase 2 overlay.

Followed currency through shared `propertyCreateSchema`/`CURRENCIES`, parsed data, row filtering and `createMany`; followed scanner through `parseCsv` → `csvToRecords` → the two client/property import handlers. The private detector has one caller; `parseCsv` has one production wrapper caller; the wrapper has two production route callers. Export `csvSafeText` is unchanged. Router authentication/`import.run`, one-file/5 MiB limits, database write path and duplicate checks are unchanged.

## Currency contract

- Missing, empty and whitespace-only values reach default **TJS**. The explicit trim is consistent with `csvToRecords`' existing value trimming. Missing-header handling is source-confirmed; the new HTTP tests cover blank/whitespace rather than a physically absent currency column.
- Explicit `USD`, `TJS` and lowercase `usd` normalize and preserve their currency; there is no conversion of the numeric price. The tests inspect persisted currency and price, not only a success response.
- A nonblank unsupported value now reaches `z.enum(CURRENCIES)` (`USD`/`TJS`) unchanged after normalization. An invalid row takes the `skipped` path before `toInsert`; it cannot fall through to the database's default or get rewritten as TJS. Tests for RUB/EUR/USDD check the currency-specific error and absence of a property row.
- The HTTP contract remains partial per-row results (`200` with `created`/`skipped`), so asserting status 200 for rejected rows is appropriate.

## Template control

The new `Окна` header and example `4` occupy corresponding positions. The rest of the header/example alignment is preserved. The existing property schema requires windows for this apartment example; no validation was relaxed.

The test downloads the **actual endpoint template**, parses those bytes, changes only synthetic identity/district/contact fields, then uploads the result through the actual import route and inspects stored `windowCount`. It does not invent a separate passing template or add missing mandatory fields itself. The baseline log's rejection specifically identifies missing `Окна`, making the regression sensitive to the original defect. It also avoids an existing address/identity collision through its own district and counter.

## Delimiter scanner

The new state machine counts only delimiters outside quoted fields, skips doubled quotes while staying inside a quoted field, and stops at the first unquoted CR **or** LF. Embedded quoted LF/CRLF/CR is therefore data, not an early header boundary. These transitions agree with the unchanged parser's quote handling. BOM stripping occurs before detection. Ordinary comma/semicolon behavior and comma-on-tie/default remain unchanged.

The scanner is a single forward pass; its worst case is bounded by the unchanged upload limit and the parser's existing full-file scan. No new recursion, unbounded buffering, network behavior or authorization branch was introduced.

The ten parser cases cover quoted extra separators in both directions, three newline forms, quoted multiline first headers, escaped quotes, BOM and normal files. Some CR cases already pass on the baseline because delimiter counts happen to balance; these remain useful controls, not independent red reproduction claims. Malformed/unclosed quoting and inherently ambiguous single-column inference retain the parser's existing permissive behavior; this patch does not claim to redesign those contracts.

## Evidence reviewed, not rerun

- `phase2-import-red.log`: 19 cases, **10 failed / 9 passed**. Inspection confirms currency failures and missing-window template failure, plus quote/logical-record assertions; ordinary/supported-value controls pass.
- `phase2-import-green.log`: **36 passed / 6 files**, including the 19 new cases, Windows-1251 import, non-fresh client import, property creation rules, and expense/formula/recurring controls. Terminal native success is recorded by the author; this reviewer inspected the raw terminal result, not a fresh independent execution.
- `git diff --check` on the four reviewed paths succeeds.

No production records, external providers, installed dependencies or application sources were modified by this review. The author's isolated-PostgreSQL execution and parent integration checks remain separate evidence layers.
