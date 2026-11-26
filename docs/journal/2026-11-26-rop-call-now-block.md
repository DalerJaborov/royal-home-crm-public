# 26.11.2026 — у РОП вернулся блок «Позвонить сейчас»

**Жалоба владельца:** у агента «Ноза РОП» исчезли «Позвонить клиентам».

**Причина (ФАКТ, по коду main bedab1ed8):**
1. Блок `agentFirstCalls` («Позвонить сейчас») в `components/look/home/registry.tsx` был только у роли `AGENT`; у `HEAD_OF_SALES` его не было в реестре и в `HOME_LAYOUT`.
2. Сервер (`routes/dashboard.ts`, `/summary`) считал `firstCallDue` и `assignedBySupervisor` только при `ownAgentId`, а `scopeToOwnAgent` отдаёт `undefined` всем с правом `clients.viewAll` — у РОП оно есть. Список был пуст, даже если бы блок показали.

**Что изменено:**
- `dashboard.ts`: `callOwnerId = ownAgentId ?? (роль в SALES_AGENT_ROLES ? свой id : undefined)` — для РОП «позвонить» и «назначил руководитель» считаются по её личным клиентам. Директор и админ по-прежнему получают пусто.
- `registry.tsx`: блок `agentFirstCalls` доступен `HEAD_OF_SALES`, встал в раскладку после плиток.
- `leader.test.tsx`: обновлён порядок блоков РОП.
- Новый тест `apps/api/tests/dashboard-rop-first-call.test.ts`.

**Проверено:** пока только чтением кода; сборка и тесты — см. отчёт выкатчика.
**Осталось:** прогнать сборку/тесты, `npm run map`, ship, посмотреть главную РОП глазами.
