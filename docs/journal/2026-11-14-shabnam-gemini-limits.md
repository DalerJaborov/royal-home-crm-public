# Шабнам: денежные потолки Gemini подняты (14.11.2026)

**Что.** `ai/assistant/moneyBudget.ts`: умолчания суточного потолка $3 → $30, на ответ $0.30 → $1 (владелец дал «да»). Это предохранитель резерва, реальный расход не меняется. 14.11 в 17:43 ассистент упал «Достигнут денежный лимит Gemini» на потолке одного ответа.
**Почему не хватало .env.production.** `ASSISTANT_GEMINI_DAILY_USD` и `ASSISTANT_GEMINI_TURN_USD` не были проброшены в `docker-compose.prod.yml`: значение из файла до контейнера не доходило. Проброшены в общий блок `crm-env` (его берут и api, и worker), пусто = умолчание из кода. `.env.production` на сервере не менялся.
**Проверено.** `assistant-money.unit` (27, новый тест на умолчания), `assistant-gemini-guards.unit` (18). `assistant-language-routing.unit` локально без базы не стартует (SASL), гоняется в ship.
**Осталось.** Прочие суточные потолки Gemini (`ASSISTANT_GEMINI_DAILY_ATTEMPTS`=300, клиентский бот `maxOperationUsd`/`maxAttemptUsd` в `customerAgentProviderConfig.ts`) не менялись: решение владельца после списка.
