# HANDOFF 14.11.2026 — потолки Gemini у Шабнам (PR #190)

**Решение владельца (14.11, в чате):** поднять суточный денежный лимит Шабнам (внутренний ассистент, Gemini) до $30; мой довесок для лечения ошибки 17:43 — лимит на ответ $1 (владельцу сообщено).

**Причина:** `apps/api/src/ai/assistant/moneyBudget.ts` брал умолчания $3/сутки и $0.30/ответ; env-переменные не проброшены в `docker-compose.prod.yml`, поэтому `.env.production` их не менял. Счёт Google ни при чём (Royal Home $25.42 из $200, предоплата $25.76 на 14.11).

**Сделано:** ветка `worktree-agent-a54de99f1c3a6714c`, коммит f37800767, PR https://github.com/DalerJaborov/royal-home-crm-public/pull/190 (черновик). Тесты assistant-money 27/27, guards 18/18, build:api, map:check. Полный precheck и test:api — на ship.

**Осталось:**
1. Проверить в `D:/CRM-migration-20261021/WORKSPACES.md`, что PR188 уже не RUNNING (на 14.11 вечером был RUNNING).
2. Дописать строку `CLAUDE PR190 RUNNING` и запустить `npm run ship` из worktree `D:\CRM\.claude\worktrees\agent-a54de99f1c3a6714c` (gh активен DalerJaborov, только из PowerShell; токен не печатать). Junction `node_modules\@royal-home\shared` -> packages/shared этого worktree уже создан.
3. После автовыката (~600 с тишины): ssh rh-vps, `docker exec royalhome-crm-api-1` — новый sha, health 200, ошибок api/worker 0; проверить, что Шабнам отвечает.
4. Строку в WORKSPACES.md закрыть (DONE).

**Не решено (спросить владельца):** клиентский бот (`royal-customer-gemini`) суточного денежного потолка не имеет; `ASSISTANT_GEMINI_DAILY_ATTEMPTS` (300 попыток/сутки) тоже в compose не проброшен — добавить, если упрёмся. Кредиты ElevenLabs (голос Шабнам) не проверены. Баланс предоплаты Gemini $25.76 — пополнить в ближайшую неделю.
