# 23.11.2026 — разрыв кругового импорта в ship для `fix/bot-day-review-23-11`

Три попытки выката PR #406 падали на `audit:deps` (не на флакающей сети, как показалось по "итоговый
отчёт не скачан" — реальный облачный прогон красный все три раза). Причина: `contactPromiseUnkept.ts`
(часть A, «обещал — не выполнил») тянул `lastAgentContactPromise` из `lib/phoneLeadWatchdog.ts`, а тот —
`CUSTOMER_LEAD_ONLY_INTAKE_JOB` из `customerLeadOnlyCore.ts`, которая через `operatorTurn.ts` снова
приходит в `contactPromiseUnkept.ts` — три кольца импортов.

Починка: вынес `lastAgentContactPromise` (и её внутренние помощники `jobConversation`/`sentencesOf`/
`PROMISE_GRACE_MS`) в новый лист `lib/agentContactPromise.ts`, у которого нет пути назад к
`customerLeadOnlyCore`/`operatorTurn`. `phoneLeadWatchdog.ts` и `contactPromiseUnkept.ts` берут функцию
оттуда; `phoneLeadWatchdog.ts` переэкспортирует её же, чтобы старый тест
(`tests/promise-without-card-watchdog-19-11.test.ts`) не трогать.

Проверено: `node scripts/audit-deps-gate.mjs` — новых нарушений нет (круг ушёл); `tsc --noEmit` чисто;
на стенде (`agent_4791`) — `promise-without-card-watchdog-19-11.test.ts` (49), `bot-day-review-23-11.test.ts`
(24), `bot-memory-23-11.test.ts` (46) — 119/119 зелёных; `map`/`map:check` без изменений.
