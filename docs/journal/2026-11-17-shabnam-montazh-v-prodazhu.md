# 17.11.2026 — Шабнам: «монтаж готов» выводит объект в продажу, причина «почему не в продаже» называется словами

- Что изменилось:
  - `lib/propertyCompleteEditing.ts` — одна дверь «Готово»: `checkCompleteEditing` (не найден → не ваш объект →
    не на «Монтаже» → не готов к продаже, порядок и тексты прежние), `completeEditing` (условный перевод
    `EDITING → AVAILABLE` через `updateMany` по образцу `finalizePropertyAvailability`, затем
    `publishAfterEditingComplete`, `skipVideoHandoffOnManualPublish`, `publishPropertyUpdated`),
    `saleBlockerAdvice` (причины и «что сделать» словами; число записей сверено с `blockersForSale` тестом).
    `POST /properties/:id/complete-editing` теперь тонкий: зовёт `completeEditing`, ответы и коды экрана те же
    (404/403/409/409, 200 или 207 с `siteSyncError`). Два одновременных нажатия — одна публикация, второе 409
    «доступна только на этапе «Монтаж»» (раньше `update` без условия мог дать две).
  - `publishAfterEditingComplete` принимает ещё и `PublishAuditAuthor { agentId, meta }`: журнал
    `PROPERTY_EDITING_DONE` от имени нажавшего «Подтвердить» с источником «помощник» (раньше: запрос или «Система»).
  - Новый инструмент `complete_property_editing` (`ai/assistant/tools/completePropertyEditing.ts`, уровень C):
    тонкая обёртка над дверью, право как у кнопки (`canManagePropertyAs`), карточка «Подтвердить/Отменить» через
    брокер. Не готов (мало фото, нет ссылки на ролик в Instagram) — карточка НЕ создаётся, модель получает причины и
    шаг (`NOT_READY_FOR_SALE`). Только личка: `privateTelegram` + `GROUP_HIDDEN_TOOLS`. Сайт не принял — итог
    `PARTIAL` (Telegram показывает строку ⚠️), статус в CRM уже сменился.
  - `change_property_status`: AVAILABLE для объекта на «Монтаже» — отказ `USE_COMPLETE_EDITING` с названием нового
    инструмента, а не заявка «Другое» и не безадресный «используйте Готово»; описание инструмента отсылает туда же.
  - `get_property_work_status` для объекта в конвейере отдаёт `saleReadiness`: этап, `blockers` (что не так и что
    сделать), состояние ролика словами («готовый ролик принят (11 дн. назад), публикация в Instagram ещё не
    завершена»), `readyForSale`, `nextStep`. Описание дополнено фразами по-русски и по-таджикски («чаро ба фурӯш
    набаромад»). Список «мои/очередь» не тронут (там нет запроса по фото).
- Почему: живой случай владельца 17.11, ОБ-000193: объект на «Монтаж» не выходил в продажу, Шабнам не знала причины
  и предлагала «заявку на смену статуса». Класс «ответила — не сделала / не знает причины» (Т1 в
  `docs/design/shabnam-brain-2026-11-17/recon-tools.md`): выход из монтажа был единственной дверью без пути
  для помощницы.
- Чем проверено: ТОЛЬКО чтением кода (каждый импорт сверен по исходникам и схеме Prisma). Сборка и тесты НЕ
  запускались (в копии нет `node_modules`, память ПК занята). Прогнать:
  `npm run build:shared && npm run prisma:generate && npm run build:api`, затем
  `cd apps/api && npx vitest run tests/ai-assistant-complete-editing.test.ts tests/property-complete-editing.test.ts tests/ai-assistant-property-tools.test.ts tests/ai-assistant-tool-registry.test.ts tests/assistant-property-work-status.unit.test.ts tests/assistant-human-tool-instructions.unit.test.ts tests/property-goes-on-sale.test.ts tests/property-moderate-permission.test.ts tests/property-owner-visibility-permission.test.ts`
  и тесты, задетые `propertyPipeline.ts`/`crud.ts` (`node scripts/impact-tests.mjs --for=apps/api/src/lib/propertyPipeline.ts`),
  затем `npm run map`, `npm run map:check`, `npm run precheck`.
- Что осталось:
  - В `tests/ai-assistant-property-tools.test.ts` тест «объект на монтаже в продажу помощник не выводит» ждёт `/Готово/`
    в тексте отказа — новый текст его содержит («кнопка «Готово»»); по желанию добавить проверку названия инструмента.
  - Подписи прогресса: добавлена запись в `WRITE_LABELS` (`partialAnswer.ts`); статусной фразы кроме `statusPhrase` нет.
  - Другие выходы из конвейера для помощницы (проверка фото/видео модератором) не делались — ведёт маркетинг.
  - Строка в `docs/TASKS.md` и в WORKSPACES.md — на сборщике.
