# 16.11.2026 — Сняты автоматические штрафы Royal Score, удалён мёртвый код

Ветка `claude/remove-dead-code-penalties-16-11`, стоит поверх #220 (папки и статусы
клиента убраны) — вливать после неё.

- **Что изменилось.** Решение владельца 16.11.2026: «убрать мёртвый код и
  автоматические штрафы»; модуль Royal Score и плюсовые баллы остаются — «скоро
  включим баллы».
  - **Каталог (`packages/shared/src/royalScoreEvents.ts`).** 20 видов переведены в
    группу «только для чтения старых записей» (`editable: false`, цена 0):
    `lead_declined_1..4plus`, `lead_ignored`, `call_15min_missed`,
    `mandatory_window_on_time/overdue` (окна удалены ещё 13.09), `card_not_filled`,
    `showing_missed`, `meeting_overdue`, `task_overdue`, `property_reworked`,
    `property_rework_fixed`, `photos_overdue`, `video_overdue`,
    `client_lost_agent_fault`, `client_lost_no_fault`, `inactivity_warning`,
    `inactivity_penalty`; `lead_missed` тоже 0. В Настройках их больше нет.
  - **Одна дверь со сторожем.** Новый тип `ActiveScoreEventKind` (только
    `editable: true`): `recordScoreEvent`/`recordScoreEventInTransaction` принимают
    только его — снятый штраф не соберётся (`tsc`). `loadEventPoints` берёт цены
    из Настроек только для начисляемых видов: старая «−5» в
    `Settings.royalScoreEventPoints` больше не действует, старые строки штрафов в
    окне счёт не тянут. Журнал агента (`loadScoreEvents`) снятые виды не
    показывает. Тест каталога: минус у начисляемого вида — только у компенсации
    плюса (`deal_closed_reversed`, `client_recovered_bonus_reversed`).
  - **Почему компенсации оставлены, а `property_rework_fixed` снят.**
    `deal_closed_reversed` / `client_recovered_bonus_reversed` гасят уже
    начисленный плюс за сделку, которую аннулировали, — без них баллы за
    несостоявшуюся сделку висели бы. `property_rework_fixed` (+2.7) был возвратом
    90% штрафа за доработку: без штрафа это чистый плюс за то, что объект
    вернули, больше, чем за «фото приняты с первого раза» (+1).
  - **Писатели штрафов.** Первый звонок (`services/leads/firstCall.ts`,
    `penalizeMissedFirstCalls` → `handleMissedFirstCalls`): хронология, сигнал
    руководителю, передача по тумблеру обучения — как были; штраф убран. Отметка
    «срыв уже разобран» теперь — системная запись «Первый звонок не совершён…»
    после этого приёма, а не строка штрафа (иначе запись и сигнал повторялись бы
    каждую минуту; при выключенном рубильнике Royal Score так и было — починено).
    Отказ от лида (`assignment.ts`), «не принял и не отклонил»
    (`reassignment.ts`), возврат объекта на доработку (`propertyReview.ts`), фото
    после возврата (`routes/properties/photos.ts`), видео после возврата и
    просрочка фото/видео (`propertyPipeline.ts`), отказ и передача клиента
    (`clientRefuse.ts`, `clientTransfer.ts`), закрытие задачи с опозданием
    (`taskCompletion.ts` — опоздание теперь без плюса и без минуса).
  - **Удалены целиком (работы не осталось):** `lib/cardReminders.ts` (после
    02.10 только ставил отметки + штраф), `notifyMissedShowings` и
    `notifyOverdueTasks` (`meetingReminders.ts`, только штраф + отметка
    `noShowNotifiedAt`, которую никто не читал), `lib/inactivityPenalty.ts` и крон
    `inactivity-check`, блок «Бездействие по клиенту» в Настройках → Дисциплина и
    поля `inactivity*` в схеме PATCH (колонки в базе остались). Пуш руководству о
    непроведённом показе/просроченной встрече (`notifySupervisorsOfOverdue`) не
    тронут.
  - **Просрочка фото/видео объекта:** сигнал руководителю теперь один на каждое
    попадание объекта на этап (от `stageEnteredAt`), и приходит и по объекту без
    ответственного агента (проверка стояла ради штрафа).
  - **Отчёты.** «Разбор проблемных мест»: убраны показатели, считавшиеся по
    штрафам («Первый звонок не сделан вовремя», «Клиенты потеряны окончательно»,
    «Обязательные окна», «Задачи, показы и встречи сорваны», «Отказы агентов»);
    «Кто проседает» теперь по клиентам без касания. «Инсайты от ИИ»: источник
    «штраф Royal Score» снят (вид `score_penalty` остался для старых выпусков).
    `clientLossFault.ts`: одиночная версия удалена, пакетная осталась — её читает
    кабинет СБ.
  - **Мёртвый код:** `lib/silentInviteCalls.ts` + `scripts/recall-silent-invite-calls.ts`
    (разовый перезвон немых звонков 28.09–03.10), `lib/video/propertyCovers.ts`
    (без единого импорта), повторы `openaiApiKey` в `SECRET_SETTINGS_FIELDS`
    (было 4) + тест «без повторов», остатки «Задач в Telegram» в фикстурах
    `apps/web/scripts` (`teamRequestsPending`).
- **После ревью (тот же день).**
  - «Кто проседает» в «Разборе проблемных мест» считается по общему правилу «без
    контакта» (`packages/shared/src/clientNoContact.ts`, дверь `lib/noContact.ts`),
    а не по `lastContactAt`; ключ показателя новый (`noContact`), чтобы тренд не
    сравнивал два разных правила.
  - Переопределение вины директором удалено целиком: маршрут
    `routes/royalScoreEvents.ts`, карточка в `ClientDetail.tsx`, хуки в
    `useClients.ts`, право `score.clientLossOverride` (сохранённые id отбрасываются
    при чтении). Старые строки отмены считаются как прежде (цена 0).
  - Просрочка фото/видео: новое правило действует с `MATERIALS_ALERT_RULE_SINCE`
    (16.11 12:00 UTC) — просрочки, наступившие раньше, сигнала не дают, залпа
    давних сигналов после выката не будет.
  - Слово «штраф» убрано из подсказок (выходные компании и сотрудника, таблица
    баллов, первый звонок, «Маркетинг», «Инсайты», уведомления, права). Минус в
    цене события Настройки больше не принимают — ни экран, ни сервер — кроме двух
    компенсаций (`minScoreEventPoints` в общем каталоге); старый минус из базы
    поднимается до нуля.
- **Оставлено сознательно (используется):** `executeNewOnlyCustomerLeadBridge`
  (вызывают тесты контракта моста, файл держит и живую
  `createCustomerLeadAfterContactAction`), `runClientAutopilot` и
  `detectExplicitRefusal` (зовутся внутри своих модулей, экспорт — для тестов),
  `objectInterestPullsQueueLead` (живой флаг окружения),
  `lib/telephony/missedCallEscalation.ts` (зовут `routes/calls.ts` и
  `morningNumbers.ts`), `telegramOwnerChatId`/`isOwnerChat` (живые),
  запасное имя `TEAM_REQUESTS_TOKEN` (утренний отчёт на проде может брать токен
  только из него — `docker-compose.prod.yml`; убрать после сверки `.env` на
  сервере), `lib/propertyVoice/backfill.ts` (зовёт скрипт
  `scripts/backfill-property-voice.mjs`, который запускает владелец).
- **Чем проверено.** `build:shared`/`build:api`/`build:web` (eslint+tsc+vite) — 0;
  `test:web` — 363 файла, 2262 теста зелёные (2 файла с jsdom не стартуют: jsdom
  не установлен в общем `node_modules`, файлы правкой не тронуты); 41 файл тестов
  сервера, задетых правкой, — зелёные (переписаны под «штрафа нет»); все аудиты
  `precheck` (deps, theme, nginx, typeset, rules, mocks, fetch-timeout, labels,
  secrets, test:scripts) — 0; `map` + `map:check` — 0; сторож карты против #220:
  пропал только крон `inactivity-check` (намеренно). Полный `test:api` на машине
  не прошёл до конца (свободно 0,6 ГБ памяти) — его делает `npm run ship`.
- **Что осталось.** Решить
  судьбу полей `Settings.inactivity*` и `Interaction.noShowNotifiedAt` (колонки
  без читателей — миграция отдельно); `coverPoster.generateCoverPoster` теперь
  зовут только тесты — следующий кандидат.
