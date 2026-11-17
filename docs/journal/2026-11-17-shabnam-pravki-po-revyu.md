# 2026-11-17 — Шабнам: правки по независимому ревью

## Что изменилось
1. Заявка на смену статуса, поданная помощником, хранит исходный статус `statusChange.from`
   (`ai/assistant/tools/changePropertyStatus.ts`, схема в `lib/propertyStatusChange.ts`). При «Принять»
   `executeStatusChange` (`routes/properties/changeRequestExecutor.ts`) передаёт его в `changePropertyStatus`
   как `expect.status`: статус уже другой или `from` нет (старая заявка) — FAILED «Объект изменился,
   заявка устарела — подайте новую», статус не тронут.
2. Одна функция `redactSecrets` (`lib/redactSecrets.ts`): токен бота `bot<цифры>:<строка>`, `access_token=`,
   `key=`, `token=`, `secret=`, `password=`, `Bearer …`, `sk-`, `AIza`, `EAA`, JWT → «•••». Пропущены через неё
   тексты журнала ошибок, каналов, фоновых задач, очереди «отказов» (directorTools, brainReadTools).
3. `change_property_status`: `privateTelegram: true` и имя в `GROUP_HIDDEN_TOOLS`. `complete_property_editing` уже был закрыт.
4. `missedWithoutCallbackIds`: `orderBy: { startedAt: "desc" }` при `take`.
5. `runPropertyStatusEffects`: пересчёт карточки продавца обёрнут в try с `logSystemError` — его сбой не съедает
   запись «было → стало» и уведомление о правке в PATCH (раньше пересчёт стоял после них и бросал 500).
6. Тесты: рубильник директора возвращается в `afterAll` и в `finally` (созданная строка настроек убирается);
   в тесте «мозга» показ «сегодня 23:59» больше не зависит от минуты прогона (часы Date на полдень Душанбе).

## Почему
Ревью 17.11: устаревшая заявка переводила объект из чужого статуса; сырые тексты ошибок с ключами уходили
в модель и Telegram; статус менялся из общей группы; хвост выборки без порядка; общий хвост тестов.

## Проверено
`npm run build:api` код 0; `npx vitest run` 9 файлов (property-tools, property-change-requests, director-tools,
brain-read-tools, assistant-telegram, tool-registry, missed-call-callback-escalation, complete-editing,
redact-secrets): 241 тест зелёный. Новые тесты: устаревшая заявка, заявка без `from`, группа, 8 на `redactSecrets`.

## Осталось
Полный `test:api` и `precheck` — сборщик.
