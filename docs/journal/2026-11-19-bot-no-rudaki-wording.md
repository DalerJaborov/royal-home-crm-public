# 19.11.2026 — бот говорит клиентам «работаем по Душанбе», без района Рудаки

**Что изменилось.** Решение владельца 19.11: «Не нужно говорить, что мы работаем по Душанбе и Рудаки.
Надо просто говорить, что мы работаем по Душанбе, и всё». Этап 0.1 плана `docs/bot-operator/PLAN.md`.

- `lib/serviceArea.ts`: `SERVICE_AREA_RU = "Душанбе"`, `serviceAreaIn` → «в Душанбе» / «дар Душанбе»,
  подсказки модели говорят «клиентам вслух только Душанбе, район Рудаки принимаем, но не называем»; новые
  `SERVICE_AREA_WORK_RU`, `SERVICE_AREA_ONLY_RU`, чтобы копии фразы не жили по файлам; прежние фразы
  «…и районе Рудаки» остались в `RUDAKI_ERA_SERVICE_AREA_LINES` только как память о старых чатах.
- `ai/customerAgentRenderer.ts`, `ai/customerAgentLiveWording.ts`, `ai/agencyFactsLessons.ts`,
  `ai/leadQualifier.ts`, `messengers/comments.ts` — слова берут из `lib/serviceArea.ts`.

**Что НЕ менялось.** Логика зоны: объекты района Рудаки принимаются как раньше (`RUDAKI_SELLER_RULE`,
`coverageGuard`, списки районов, адреса объектов).

**Чем проверено.** Новый сторож `tests/bot-no-rudaki-in-client-text.test.ts` (5/5; проверен внесением
старого слова — красный) и задетые `voice-anna-fixes-16-11`, `customer-bot-8-chats-15-11`,
`customer-bot-audit-16-11`, `other-city-honest-intake`, `sales-playbook` — зелёные на стенде. Сторож одной
двери зоны (`voice-anna-fixes-16-11`) поймал три копии фразы, внесённые этой же правкой, — исправлено.
Полный прогон — облачный в `npm run ship`.

**Что осталось.** Остальные этапы плана: оператор приёма заявок (1), входные данные (2), каналы и Arvan (3).
