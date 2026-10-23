# Audit scope and coverage

Baseline: 87aecdbcc4a69a3f57ad6de23b4e739ca6c9c3b1. Generated 2026-10-23T21:56:57.719Z.

| Inventory layer | Count |
| --- | ---: |
| sourceFiles | 1958 |
| existingTestFiles | 1805 |
| screens | 68 |
| modules | 78 |
| cron | 104 |
| jobs | 23 |
| external | 13 |

The machine inventory is inventory.json. Its pending states deliberately do not imply that an area is tested. Specialist reports record actual reviewed paths, reproductions and executed checks. A consolidated green suite does not prove all routes, roles or business scenarios.

## Scenario matrix

| Dimension | Required variants | Evidence status |
| --- | --- | --- |
| Identity and permissions | anonymous, agent, manager/admin, director, revoked rights, foreign ownership | assigned API/frontend review; runtime subset pending |
| Inputs | omitted/null/empty/invalid/large text, Unicode, numbers, dates, arrays, files | assigned; runtime subset pending |
| Business state | draft/planned/paid/archive/deleted, stale version, conflicting updates | isolated PG regression subset pending |
| Transport | unavailable network, response lost after commit, timeout, duplicate submit | frontend regression subset pending |
| UI | desktop and 390px, loading/empty/error/permission, cancel and pending submit | component/browser subset pending |
| Async | race/lock order, retries, provider unknown outcome, scheduled status changes | API race tests and parent source review pending |
| Integration | real PG, local browser, provider contract mocks | no live provider delivery or production mutations |

## Completed evidence groups

| Evidence group | Completed scope | Limits |
| --- | --- | --- |
| Precheck | shared/API/web build and ESLint; 304 web files / 1867 tests; all source/map guards | no full API suite, no production proof |
| Business integration | 71-test finance group plus 42-test adjacent group; overlap retained separately | only named scenarios in BUSINESS.md |
| API/privacy integration | 77 tests across 10 distinct files | named authorization/claim/file/stream cases, no exhaustive IDOR audit |
| Frontend component checks | 66 unit tests and 8 Chrome cases at 1440/390; independently reproduced failures on87aecdb and success onb20bc69 | intercepted responses; see FRONTEND-BASELINE.md |
| Real role navigation | final 8/8 roles, five routes at1440/390 each, exact finance permissions and read-only rejection | smoke only; no field mutation/completion, visual or device acceptance |
| Tooling | 14 stand-root/template tests | unrelated scripts not exhaustively audited |

Source-file `pending` inventory states are intentionally conservative. These group results do not silently mark every file exercised by the suite as fully tested. Use the specialist reports and README.md for exact paths and reproductions.

## Explicit limits

Production behavior, physical iOS/Android, external provider delivery, exhaustive role combinations, every scheduler and every source file are unverified until named evidence exists.
