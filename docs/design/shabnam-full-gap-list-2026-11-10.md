# Полный список: что умеет CRM и чего нет у Шабнам (10.11.2026)

Источник — карта продукта `docs/product-map-simple.json` на `main` 6cbacaa7 (ФАКТ): все адреса сервера, которые зовёт интерфейс CRM. Отметка «есть у Шабнам» поставлена вручную по реестру её инструментов (ОЦЕНКА: названия адресов машинные, возможны неточности в паре строк).

Всего действий в интерфейсе: **592**. ЕСТЬ: 28 · ЧАСТИЧНО: 19 · НЕТ: 475 · рекомендую оставить в CRM: 70.

GET — посмотреть, POST — добавить или сделать, PATCH/PUT — изменить, DELETE — удалить.

## Порядок работ (решение владельца 10.11.2026)

Владелец: «приоритет добавления объектов через CRM причём полностью, чтобы работало прямо как мастер по добавлению объектов, и вторым приоритетом все возможности директора вплоть от создания или удаления работников и изменения прав до добавления расходов и узнать все расходы».

### Приоритет 1 — мастер объекта в Telegram, полностью (ФАКТ по коду 10.11)
Черновик уже есть: `apps/api/src/telegram/assistantPropertyDraft.ts` (тот же `createProperty`, черновик сервера, фото, геоточка, продавец, агент-приёмщик). Мастер CRM — `apps/web/src/components/property-wizard/*` (шаги: Параметры, Адрес, Продавец, Фото и видео, Проверка). Чего нет в Telegram:
1. Видео — сейчас пропускается (`skipped.videos`); нужны загрузка через те же сессии загрузки, что `drafts/current/videos/sessions`.
2. Рынок: новостройка или вторичка (`marketType`).
3. Стадия и отделка (`stage`), документы (`documentsPreset`, `documentsOther`), разделы объекта (`details`).
4. «Куда пойдёт объект» (`offSite`: сайт/соцсети) — частично.
5. Проверка дубля адреса (`GET /properties/duplicate-check`) до создания.
6. Объект из карточки продавца (`POST /properties/drafts/from-client/:clientId`).
7. Точка на карте → район и ближайшие ориентиры (как `useMapDistrict`, `usePointLandmarks`).
8. Текст для озвучки ролика (шаг Проверка).
9. Итоговая карточка «Проверьте объект» со всеми полями и кнопками «Создать / Исправить / Выйти», как StepReview.
Одна дверь: все поля через `propertyWizardDraftValuesSchema` и `propertyCreateSchema` из `packages/shared`, без своей логики в боте.

### Приоритет 2 — директор целиком
Сотрудники (`agents`): добавить, изменить, заморозить/разморозить, удалить, передать дела и откатить передачу, сбросить 2FA, права (`PUT /agents/:id/permissions`), пауза заявок. Расходы (`expenses`): добавить, изменить, удалить, вернуть, оплатить, отменить оплату, чеки, повторяющиеся, категории, сводка, прогноз, разбивка, выгрузка. Дальше: финансы и прогноз, сделки (создать, изменить, аннулировать), контроль руководителя, служба безопасности, команда, заявки на удаление и споры (одобрить/отклонить), реклама (чтение, пауза), вакансии, журнал действий, ошибки системы.

**Защита (обязательна).** В CRM эти действия требуют подтверждения личности (`requireElevation`, `lib/stepUp.ts`): код Google Authenticator или пароль. В Telegram — только код Authenticator из 6 цифр, только в личке, только у кого есть право (`agents.manage`, `permissions.manage`, `finance.view` …), карточка «Да / Отмена» на каждое действие и сообщение владельцу о каждом изменении прав и удалении сотрудника. Пароль в чат не просить никогда. Кто украл Telegram директора, без кода не получит ничего.

### Остаётся в CRM
Вход и пароли, свой профиль и устройства, ключи и подключения (Настройки → интеграции, Search Console, TikTok/Threads подключение), резервные копии, загрузка пачкой. Это 70 действий из 592.

## Сводка по разделам

| Раздел | Действий | Есть | Частично | Нет | В CRM |
|---|---|---|---|---|---|
| Объекты: список, карточка, фото, видео, публикация (`properties`) | 109 | 13 | 2 | 94 | 0 |
| Клиенты: карточки, передачи, отказы, подбор — самый крупный модуль (`clients`) | 58 | 8 | 2 | 48 | 0 |
| Настройки CRM и точки возврата (`settings`) | 44 | 0 | 0 | 44 | 0 |
| Свой профиль, настройки, устройства (`me`) | 38 | 0 | 0 | 0 | 38 |
| Расходы агентства (`expenses`) | 28 | 1 | 1 | 26 | 0 |
| Кабинет маркетинга и монтажа (`marketing`) | 23 | 0 | 0 | 23 | 0 |
| Кабинет службы безопасности (`security`) | 21 | 0 | 0 | 21 | 0 |
| Реклама Meta: расходы и привязка объявлений (`ads`) | 18 | 0 | 0 | 18 | 0 |
| Сотрудники: карточки, права, аватары (`agents`) | 18 | 0 | 0 | 18 | 0 |
| Отчёты за период (`reports`) | 18 | 0 | 13 | 5 | 0 |
| social-videos (`social-videos`) | 18 | 0 | 0 | 18 | 0 |
| Кандидаты на вакансии (`vacancies`) | 17 | 0 | 0 | 17 | 0 |
| Контроль руководителя (`oversight`) | 16 | 0 | 0 | 16 | 0 |
| Главная, пульт директора, модули пульта, утренняя сводка (`dashboard`) | 14 | 0 | 0 | 14 | 0 |
| Переписка по всем каналам (`conversations`) | 11 | 0 | 0 | 11 | 0 |
| Звонки, показы, встречи — всё, что агент отмечает (`interactions`) | 10 | 4 | 1 | 5 | 0 |
| Чек-листы и выдачи лид-магнитов (`lead-magnets`) | 10 | 0 | 0 | 10 | 0 |
| Уроки, извлечённые из ошибок бота (`bot-learning`) | 8 | 0 | 0 | 8 | 0 |
| Журнал ошибок системы (`errors`) | 7 | 0 | 0 | 7 | 0 |
| search-console (`search-console`) | 7 | 0 | 0 | 0 | 7 |
| Запросы к ИИ из интерфейса (`ai`) | 6 | 0 | 0 | 6 | 0 |
| Вход, двухфакторная проверка, сессии устройств (`auth`) | 6 | 0 | 0 | 0 | 6 |
| Находки ночного судьи диалогов (`bot-audit`) | 6 | 0 | 0 | 6 | 0 |
| Экран «Манера» — закрыт тумблером (`bot-training`) | 6 | 0 | 0 | 6 | 0 |
| Журнал звонков и расшифровки (`calls`) | 6 | 0 | 0 | 6 | 0 |
| Пуш-уведомления на телефон (`push`) | 6 | 0 | 0 | 0 | 6 |
| market (`market`) | 5 | 0 | 0 | 5 | 0 |
| sms (`sms`) | 5 | 0 | 0 | 5 | 0 |
| Сделки, документы, выплаты (`deals`) | 4 | 1 | 0 | 3 | 0 |
| Поиск адреса и точки по собственному справочнику города (`geo`) | 4 | 0 | 0 | 4 | 0 |
| Инсайты от ИИ по звонкам (`insights`) | 4 | 0 | 0 | 4 | 0 |
| Лента комментариев под публикациями (`instagram-comments`) | 4 | 0 | 0 | 4 | 0 |
| Публикация в TikTok (`tiktok`) | 4 | 0 | 0 | 0 | 4 |
| Ручная тренировка бота (`bot-trainer`) | 3 | 0 | 0 | 3 | 0 |
| Изменения, прилетевшие с сайта (`site-notifications`) | 3 | 0 | 0 | 3 | 0 |
| ui-shell (`ui-shell`) | 3 | 0 | 0 | 0 | 3 |
| whatsapp-templates (`whatsapp-templates`) | 3 | 0 | 0 | 3 | 0 |
| Справочник районов (`districts`) | 2 | 0 | 0 | 2 | 0 |
| Зал славы по Royal Score (`hall-of-fame`) | 2 | 0 | 0 | 2 | 0 |
| Загрузка данных пачкой (`import`) | 2 | 0 | 0 | 0 | 2 |
| Начисления и списания баллов агентам (`royal-score-events`) | 2 | 0 | 0 | 2 | 0 |
| Экран «Что не доехало»: работа, которую система не довела до конца (`stuck-work`) | 2 | 0 | 0 | 2 | 0 |
| Команда: нагрузка, портфель (`team`) | 2 | 0 | 0 | 2 | 0 |
| Вложения переписки (`attachments`) | 1 | 0 | 0 | 0 | 1 |
| Журнал действий сотрудников (`audit-log`) | 1 | 0 | 0 | 1 | 0 |
| Отчёты о резервных копиях (`backups`) | 1 | 0 | 0 | 0 | 1 |
| Сценарии продаж для бота (`bot-scenarios`) | 1 | 0 | 0 | 1 | 0 |
| Календарь задач и показов (`calendar`) | 1 | 1 | 0 | 0 | 0 |
| contacts (`contacts`) | 1 | 0 | 0 | 1 | 0 |
| Деньги: доходы, комиссии, прогноз (`finance`) | 1 | 0 | 0 | 1 | 0 |
| Состояние внешних подключений (`integrations`) | 1 | 0 | 0 | 0 | 1 |
| live-voice (`live-voice`) | 1 | 0 | 0 | 0 | 1 |

## Объекты: список, карточка, фото, видео, публикация (`properties`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Добавить: change заявки | `POST /properties/:id/change-requests` | ЕСТЬ |  |
| Вернуть из корзины | `POST /properties/:id/restore` | ЕСТЬ |  |
| Добавить: отправить back в montajer | `POST /properties/:id/send-back-to-montajer` | ЕСТЬ |  |
| Удалить: объекты | `DELETE /properties/:id` | ЕСТЬ |  |
| Открыть: объекты | `GET /properties/:id` | ЕСТЬ |  |
| Добавить: начало | `POST /properties/drafts/current/start` | ЕСТЬ |  |
| Удалить: текущее | `DELETE /properties/drafts/current` | ЕСТЬ |  |
| Показать: текущее | `GET /properties/drafts/current` | ЕСТЬ |  |
| Заменить: текущее | `PUT /properties/drafts/current` | ЕСТЬ |  |
| Показать: карта | `GET /properties/map` | ЕСТЬ |  |
| Показать: корзина | `GET /properties/trash` | ЕСТЬ |  |
| Показать: объекты | `GET /properties` | ЕСТЬ |  |
| Добавить: объекты | `POST /properties` | ЕСТЬ |  |
| Добавить: accept передача | `POST /properties/:id/accept-handover` | НЕТ |  |
| Показать: change заявки | `GET /properties/:id/change-requests` | НЕТ |  |
| Одобрить | `POST /properties/:id/clip-review/approve` | НЕТ |  |
| Отклонить | `POST /properties/:id/clip-review/reject` | НЕТ |  |
| Добавить: ролик видео | `POST /properties/:id/clip-video` | НЕТ |  |
| Добавить: завершить монтаж | `POST /properties/:id/complete-editing` | НЕТ |  |
| Добавить: пересобрать | `POST /properties/:id/cover/regenerate` | НЕТ |  |
| Добавить: загрузка | `POST /properties/:id/cover/upload` | НЕТ |  |
| Показать: заявка на удаление | `GET /properties/:id/delete-request` | НЕТ |  |
| Добавить: заявка на удаление | `POST /properties/:id/delete-request` | НЕТ |  |
| Добавить: discard | `POST /properties/:id/final-video/discard` | НЕТ |  |
| Добавить: finish изменить | `POST /properties/:id/finish-edit` | НЕТ |  |
| Показать: группа share | `GET /properties/:id/group-share` | НЕТ |  |
| Добавить: Instagram stories опубликовать | `POST /properties/:id/instagram-stories-publish` | НЕТ |  |
| Показать: последний | `GET /properties/:id/instagram-stories/last` | НЕТ |  |
| Добавить: Instagram story карточка | `POST /properties/:id/instagram-story-card` | НЕТ |  |
| Добавить: Instagram story sold | `POST /properties/:id/instagram-story-sold` | НЕТ |  |
| Показать: подбор клиенты | `GET /properties/:id/matching-clients` | НЕТ |  |
| Показать: montajer messages | `GET /properties/:id/montajer-messages` | НЕТ |  |
| Показать: montajer предпросмотр | `GET /properties/:id/montajer-preview` | НЕТ |  |
| Одобрить | `POST /properties/:id/narration/:versionId/approve` | НЕТ |  |
| Показать: звук | `GET /properties/:id/narration/:versionId/audio` | НЕТ |  |
| Собрать | `POST /properties/:id/narration/:versionId/generate` | НЕТ |  |
| Добавить: handoff предпросмотр | `POST /properties/:id/narration/:versionId/handoff-preview` | НЕТ |  |
| Добавить: reconcile | `POST /properties/:id/narration/:versionId/reconcile` | НЕТ |  |
| Добавить: очередь | `POST /properties/:id/narration/deliveries/:deliveryId/queue` | НЕТ |  |
| Добавить: доставка reconcile | `POST /properties/:id/narration/delivery-reconcile` | НЕТ |  |
| Добавить: владелец отчёт предпросмотр | `POST /properties/:id/narration/owner-report-preview` | НЕТ |  |
| Добавить: владелец отчёт revoke | `POST /properties/:id/narration/owner-report-revoke` | НЕТ |  |
| Добавить: publication предпросмотр | `POST /properties/:id/narration/publication-preview` | НЕТ |  |
| Показать: narration | `GET /properties/:id/narration` | НЕТ |  |
| Добавить: narration | `POST /properties/:id/narration` | НЕТ |  |
| Удалить: насовсем | `DELETE /properties/:id/permanent` | НЕТ |  |
| Добавить: фото публикация | `POST /properties/:id/photo-post` | НЕТ |  |
| Показать: фото posts | `GET /properties/:id/photo-posts` | НЕТ |  |
| Одобрить | `POST /properties/:id/photos/:photoId/enhance/approve` | НЕТ |  |
| Отклонить | `POST /properties/:id/photos/:photoId/enhance/reject` | НЕТ |  |
| Добавить: улучшить | `POST /properties/:id/photos/:photoId/enhance` | НЕТ |  |
| Удалить: фото | `DELETE /properties/:id/photos/:photoId` | НЕТ |  |
| Показать: archive.zip | `GET /properties/:id/photos/archive.zip` | НЕТ |  |
| Изменить: порядок | `PATCH /properties/:id/photos/order` | НЕТ |  |
| Показать: цена совет | `GET /properties/:id/price-advice` | НЕТ |  |
| Показать: цена waitlist | `GET /properties/:id/price-waitlist` | НЕТ |  |
| Добавить: опубликовать at | `POST /properties/:id/publish-at` | НЕТ |  |
| Добавить: опубликовать сейчас | `POST /properties/:id/publish-now` | НЕТ |  |
| Добавить: продление captions | `POST /properties/:id/refresh-captions` | НЕТ |  |
| Добавить: пересобрать подпись | `POST /properties/:id/regenerate-caption` | НЕТ |  |
| Добавить: repost | `POST /properties/:id/repost` | НЕТ |  |
| Показать: reposts | `GET /properties/:id/reposts` | НЕТ |  |
| Одобрить | `POST /properties/:id/review/approve` | НЕТ |  |
| Отклонить | `POST /properties/:id/review/reject` | НЕТ |  |
| Показать: ссылки для клиента | `GET /properties/:id/share-links` | НЕТ |  |
| Добавить: sms share | `POST /properties/:id/sms-share` | НЕТ |  |
| Добавить: remove | `POST /properties/:id/social-extras/remove` | НЕТ |  |
| Показать: social extras | `GET /properties/:id/social-extras` | НЕТ |  |
| Добавить: social removed по hand | `POST /properties/:id/social-removed-by-hand` | НЕТ |  |
| Добавить: social unpublish | `POST /properties/:id/social-unpublish` | НЕТ |  |
| Показать: platforms | `GET /properties/:id/stats/platforms` | НЕТ |  |
| Показать: цифры | `GET /properties/:id/stats` | НЕТ |  |
| Показать: story card.jpg | `GET /properties/:id/story-card.jpg` | НЕТ |  |
| Добавить: TikTok опубликовать | `POST /properties/:id/tiktok-publish` | НЕТ |  |
| Передать другому | `POST /properties/:id/transfer` | НЕТ |  |
| Добавить: requeue | `POST /properties/:id/video-handoff/requeue` | НЕТ |  |
| Показать: скачать | `GET /properties/:id/videos/:videoId/download` | НЕТ |  |
| Показать: файл | `GET /properties/:id/videos/:videoId/file` | НЕТ |  |
| Удалить: видео | `DELETE /properties/:id/videos/:videoId` | НЕТ |  |
| Показать: archive.zip | `GET /properties/:id/videos/archive.zip` | НЕТ |  |
| Завершить | `POST /properties/:id/videos/upload-sessions/:sessionId/complete` | НЕТ |  |
| Удалить: загрузка сеансы | `DELETE /properties/:id/videos/upload-sessions/:sessionId` | НЕТ |  |
| Добавить: загрузка сеансы | `POST /properties/:id/videos/upload-sessions` | НЕТ |  |
| Показать: видео | `GET /properties/:id/videos` | НЕТ |  |
| Показать: голос | `GET /properties/:id/voice` | НЕТ |  |
| Добавить: пачкой сверка с сайтом | `POST /properties/bulk-sync` | НЕТ |  |
| Добавить: пачкой корзина | `POST /properties/bulk-trash` | НЕТ |  |
| Одобрить | `POST /properties/change-requests/:rid/approve` | НЕТ |  |
| Отменить | `POST /properties/change-requests/:rid/cancel` | НЕТ |  |
| Отклонить | `POST /properties/change-requests/:rid/reject` | НЕТ |  |
| Показать: change заявки | `GET /properties/change-requests` | НЕТ |  |
| Одобрить | `POST /properties/delete-requests/:id/approve` | НЕТ |  |
| Отклонить | `POST /properties/delete-requests/:id/reject` | НЕТ |  |
| Показать: удалить заявки | `GET /properties/delete-requests` | НЕТ |  |
| Удалить: файл | `DELETE /properties/drafts/current/media/:mediaId` | НЕТ |  |
| Завершить | `POST /properties/drafts/current/videos/:mediaId/complete` | НЕТ |  |
| Добавить: from клиент | `POST /properties/drafts/from-client/:clientId` | НЕТ |  |
| Показать: дубль проверка | `GET /properties/duplicate-check` | НЕТ |  |
| Показать: выгрузка | `GET /properties/export` | НЕТ |  |
| Показать: ожидает | `GET /properties/handover/pending` | НЕТ |  |
| Показать: здоровье системы | `GET /properties/health` | НЕТ |  |
| Показать: narration настройки | `GET /properties/narration-settings` | НЕТ |  |
| Заменить: narration настройки | `PUT /properties/narration-settings` | НЕТ |  |
| Показать: needs help | `GET /properties/needs-help` | НЕТ |  |
| Добавить: removal dossiers | `POST /properties/removal-dossiers` | НЕТ |  |
| Удалить: ссылки для клиента | `DELETE /properties/share-links/:linkId` | НЕТ |  |
| Показать: сводка | `GET /properties/summary` | НЕТ |  |
| Изменить: объекты | `PATCH /properties/:id` | ЧАСТИЧНО | только цена и статус; остальные поля — заявкой |
| Добавить: сеансы входа | `POST /properties/drafts/current/videos/sessions` | ЧАСТИЧНО | видео в черновике Telegram пропускается |

## Клиенты: карточки, передачи, отказы, подбор — самый крупный модуль (`clients`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Добавить: назначить | `POST /clients/:id/assign` | ЕСТЬ |  |
| Добавить: отметки в хронологии | `POST /clients/:id/interactions` | ЕСТЬ |  |
| Показать: timeline | `GET /clients/:id/timeline` | ЕСТЬ |  |
| Передать другому | `POST /clients/:id/transfer` | ЕСТЬ |  |
| Открыть: клиенты | `GET /clients/:id` | ЕСТЬ |  |
| Показать: корзина | `GET /clients/trash` | ЕСТЬ |  |
| Показать: клиенты | `GET /clients` | ЕСТЬ |  |
| Добавить: клиенты | `POST /clients` | ЕСТЬ |  |
| Принять | `POST /clients/:id/accept` | НЕТ |  |
| Добавить: включить | `POST /clients/:id/activate` | НЕТ |  |
| Добавить: покупатель requirements | `POST /clients/:id/buyer-requirements` | НЕТ |  |
| Добавить: звонок | `POST /clients/:id/call` | НЕТ |  |
| Показать: переписка выгрузка | `GET /clients/:id/conversation-export` | НЕТ |  |
| Отказаться | `POST /clients/:id/decline` | НЕТ |  |
| Добавить: вернуть | `POST /clients/:id/deferred/return` | НЕТ |  |
| Показать: заявка на удаление | `GET /clients/:id/delete-request` | НЕТ |  |
| Добавить: заявка на удаление | `POST /clients/:id/delete-request` | НЕТ |  |
| Подтвердить | `POST /clients/:id/duplicate-review/confirm` | НЕТ |  |
| Добавить: отклонить | `POST /clients/:id/duplicate-review/deny` | НЕТ |  |
| Добавить: intents | `POST /clients/:id/intents` | НЕТ |  |
| Добавить: вживую голос звонок | `POST /clients/:id/live-voice-call` | НЕТ |  |
| Показать: подбор | `GET /clients/:id/match` | НЕТ |  |
| Добавить: сообщение голос | `POST /clients/:id/message-voice` | НЕТ |  |
| Добавить: сообщение | `POST /clients/:id/message` | НЕТ |  |
| Удалить: насовсем | `DELETE /clients/:id/permanent` | НЕТ |  |
| Показать: объект activity | `GET /clients/:id/property-activity` | НЕТ |  |
| Показать: спор о числе объектов | `GET /clients/:id/property-count-dispute` | НЕТ |  |
| Добавить: спор о числе объектов | `POST /clients/:id/property-count-dispute` | НЕТ |  |
| Принять | `POST /clients/:id/reactivation-offer/accept` | НЕТ |  |
| Отказаться | `POST /clients/:id/reactivation-offer/decline` | НЕТ |  |
| Добавить: отказ клиента | `POST /clients/:id/refuse` | НЕТ |  |
| Добавить: заявка вернуть | `POST /clients/:id/request-restore` | НЕТ |  |
| Вернуть из корзины | `POST /clients/:id/restore` | НЕТ |  |
| Добавить: безопасность разбор | `POST /clients/:id/security-review` | НЕТ |  |
| Показать: продавец object | `GET /clients/:id/seller-object` | НЕТ |  |
| Добавить: отправить объекты | `POST /clients/:id/send-properties` | НЕТ |  |
| Показать: отправить получатель | `GET /clients/:id/send-target` | НЕТ |  |
| Добавить: убрать | `POST /clients/:id/similar-notes/:otherId/dismiss` | НЕТ |  |
| Показать: похожие заметки | `GET /clients/:id/similar-notes` | НЕТ |  |
| Добавить: в кандидат | `POST /clients/:id/to-candidate` | НЕТ |  |
| Показать: WhatsApp first | `GET /clients/:id/whatsapp-first` | НЕТ |  |
| Добавить: WhatsApp first | `POST /clients/:id/whatsapp-first` | НЕТ |  |
| Удалить: клиенты | `DELETE /clients/:id` | НЕТ |  |
| Изменить: клиенты | `PATCH /clients/:id` | НЕТ |  |
| Одобрить | `POST /clients/delete-requests/:id/approve` | НЕТ |  |
| Отклонить | `POST /clients/delete-requests/:id/reject` | НЕТ |  |
| Показать: удалить заявки | `GET /clients/delete-requests` | НЕТ |  |
| Позвонить | `POST /clients/dial` | НЕТ |  |
| Показать: дубль разборы | `GET /clients/duplicate-reviews` | НЕТ |  |
| Показать: дубли | `GET /clients/duplicates` | НЕТ |  |
| Склеить дубли | `POST /clients/merge` | НЕТ |  |
| Одобрить | `POST /clients/property-count-disputes/:id/approve` | НЕТ |  |
| Отклонить | `POST /clients/property-count-disputes/:id/reject` | НЕТ |  |
| Показать: объект количество споры | `GET /clients/property-count-disputes` | НЕТ |  |
| Показать: возврат клиента предложения | `GET /clients/reactivation-offers` | НЕТ |  |
| Показать: сводка | `GET /clients/summary` | НЕТ |  |
| Показать: отложенные | `GET /clients/deferred` | ЧАСТИЧНО | через поиск по статусу |
| Показать: потерянные | `GET /clients/lost` | ЧАСТИЧНО | через поиск по статусу |

## Настройки CRM и точки возврата (`settings`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Добавить: телефонная станция канал станции проверка | `POST /settings/asterisk-ami-test` | НЕТ |  |
| Добавить: телефонная станция проверка | `POST /settings/asterisk-test` | НЕТ |  |
| Показать: оформление | `GET /settings/branding` | НЕТ |  |
| Добавить: ключ доступа | `POST /settings/call-whisper/token` | НЕТ |  |
| Показать: звонок подсказка оператору | `GET /settings/call-whisper` | НЕТ |  |
| Удалить: обложка templates | `DELETE /settings/cover-templates/:id` | НЕТ |  |
| Удалить: openai reference | `DELETE /settings/cover-templates/openai-reference/:format` | НЕТ |  |
| Добавить: openai reference | `POST /settings/cover-templates/openai-reference/:format` | НЕТ |  |
| Добавить: openai проверка | `POST /settings/cover-templates/openai-test` | НЕТ |  |
| Показать: openai | `GET /settings/cover-templates/openai` | НЕТ |  |
| Заменить: openai | `PUT /settings/cover-templates/openai` | НЕТ |  |
| Показать: обложка templates | `GET /settings/cover-templates` | НЕТ |  |
| Добавить: обложка templates | `POST /settings/cover-templates` | НЕТ |  |
| Добавить: kill | `POST /settings/customer-agent/kill` | НЕТ |  |
| Добавить: продление current | `POST /settings/customer-agent/refresh-current` | НЕТ |  |
| Добавить: register | `POST /settings/customer-agent/revisions/register` | НЕТ |  |
| Заменить: rollout | `PUT /settings/customer-agent/rollout` | НЕТ |  |
| Показать: customer сотрудник | `GET /settings/customer-agent` | НЕТ |  |
| Продлить | `POST /settings/exchange-rate/refresh` | НЕТ |  |
| Добавить: Instagram находки ИИ проверка | `POST /settings/instagram-insights-test` | НЕТ |  |
| Добавить: вживую голос проверка звонок | `POST /settings/live-voice-test-call` | НЕТ |  |
| Добавить: elevenlabs проверка | `POST /settings/live-voice/elevenlabs-check` | НЕТ |  |
| Добавить: предпросмотр голос | `POST /settings/live-voice/preview-voice` | НЕТ |  |
| Показать: запись разговора | `GET /settings/live-voice/sessions/:id/recording` | НЕТ |  |
| Показать: сеансы входа | `GET /settings/live-voice/sessions` | НЕТ |  |
| Добавить: логотип | `POST /settings/logo` | НЕТ |  |
| Показать: подключённые мессенджеры | `GET /settings/messenger-accounts` | НЕТ |  |
| Добавить: rotate | `POST /settings/meta-catalog-feed/rotate` | НЕТ |  |
| Вернуть из корзины | `POST /settings/restore-points/:id/restore` | НЕТ |  |
| Показать: вернуть точки | `GET /settings/restore-points` | НЕТ |  |
| Добавить: сайт начальник сброс | `POST /settings/site-admin-reset` | НЕТ |  |
| Добавить: unblock | `POST /settings/somon/recipients/:agentId/unblock` | НЕТ |  |
| Показать: recipients | `GET /settings/somon/recipients` | НЕТ |  |
| Заменить: recipients | `PUT /settings/somon/recipients` | НЕТ |  |
| Закрыть находку | `POST /settings/somon/review/:advertId/resolve` | НЕТ |  |
| Закрыть находку | `POST /settings/somon/seller-review/:advertId/resolve` | НЕТ |  |
| Добавить: recover | `POST /settings/somon/source/recover` | НЕТ |  |
| Заменить: state | `PUT /settings/somon/state` | НЕТ |  |
| Показать: статус | `GET /settings/somon/status` | НЕТ |  |
| Добавить: телефония звук | `POST /settings/telephony-audio/:kind` | НЕТ |  |
| Показать: телефония звук | `GET /settings/telephony-audio` | НЕТ |  |
| Показать: телефония светофор | `GET /settings/telephony-traffic` | НЕТ |  |
| Показать: настройки | `GET /settings` | НЕТ |  |
| Изменить: настройки | `PATCH /settings` | НЕТ |  |

## Свой профиль, настройки, устройства (`me`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Подтвердить | `POST /me/2fa/confirm` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Добавить: выключить | `POST /me/2fa/disable` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Добавить: настройка | `POST /me/2fa/setup` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Отменить | `POST /me/active-call/cancel` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Показать: активен звонок | `GET /me/active-call` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Добавить: фотография сотрудника | `POST /me/avatar` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Добавить: готово | `POST /me/callback-requests/:id/done` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Добавить: transition | `POST /me/callback-requests/:id/transition` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Показать: перезвонить заявки | `GET /me/callback-requests` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Изменить: ролик разбор Telegram | `PATCH /me/clip-review-telegram` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Добавить: заблокировать звонящий | `POST /me/incoming-call/:id/block-caller` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Удалить: заявка пауза | `DELETE /me/lead-pause` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Добавить: заявка пауза | `POST /me/lead-pause` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Показать: входы | `GET /me/logins` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Изменить: montage copies | `PATCH /me/montage-copies` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Добавить: прочитано | `POST /me/notifications/:id/read` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Добавить: прочитано все | `POST /me/notifications/read-all` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Добавить: прочитано many | `POST /me/notifications/read-many` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Показать: уведомления | `GET /me/notifications` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Добавить: ответ | `POST /me/owner-questions/:id/answer` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Показать: владелец вопросы | `GET /me/owner-questions` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Удалить: ключи входа | `DELETE /me/passkeys/:id` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Подтвердить | `POST /me/passkeys/confirm` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Добавить: варианты | `POST /me/passkeys/options` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Показать: ключи входа | `GET /me/passkeys` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Заменить: пожелания | `PUT /me/preferences` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Показать: очередь пауза | `GET /me/queue-pause` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Добавить: очередь пауза | `POST /me/queue-pause` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Добавить: совет | `POST /me/royal-score/advice` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Показать: Royal баллы | `GET /me/royal-score` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Показать: баллы месяцы | `GET /me/score-months` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Удалить: сеансы входа | `DELETE /me/sessions/:id` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Показать: сеансы входа | `GET /me/sessions` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Добавить: Telegram ссылка | `POST /me/telegram-link` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Изменить: Telegram moderation | `PATCH /me/telegram-moderation` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Добавить: Telegram отвязать | `POST /me/telegram-unlink` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Показать: я | `GET /me` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Изменить: я | `PATCH /me` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |

## Расходы агентства (`expenses`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Добавить: расходы | `POST /expenses` | ЕСТЬ |  |
| Добавить: pay | `POST /expenses/:id/pay` | НЕТ |  |
| Удалить: receipts | `DELETE /expenses/:id/receipts/:receiptId` | НЕТ |  |
| Добавить: receipts | `POST /expenses/:id/receipts` | НЕТ |  |
| Вернуть из корзины | `PATCH /expenses/:id/restore` | НЕТ |  |
| Добавить: undo payment | `POST /expenses/:id/undo-payment` | НЕТ |  |
| Удалить: расходы | `DELETE /expenses/:id` | НЕТ |  |
| Изменить: расходы | `PATCH /expenses/:id` | НЕТ |  |
| Показать: в архив | `GET /expenses/archive` | НЕТ |  |
| Изменить: categories | `PATCH /expenses/categories/:id` | НЕТ |  |
| Показать: categories | `GET /expenses/categories` | НЕТ |  |
| Добавить: Telegram | `POST /expenses/export/telegram` | НЕТ |  |
| Показать: выгрузка | `GET /expenses/export` | НЕТ |  |
| Показать: выгрузка | `GET /expenses/export` | НЕТ |  |
| Показать: прогноз | `GET /expenses/forecast` | НЕТ |  |
| Показать: pivot | `GET /expenses/pivot` | НЕТ |  |
| Показать: пульс | `GET /expenses/pulse` | НЕТ |  |
| Добавить: pay | `POST /expenses/recurring/:id/pay` | НЕТ |  |
| Вернуть из корзины | `PATCH /expenses/recurring/:id/restore` | НЕТ |  |
| Добавить: skip | `POST /expenses/recurring/:id/skip` | НЕТ |  |
| Добавить: undo payment | `POST /expenses/recurring/:id/undo-payment` | НЕТ |  |
| Повторяющиеся | `DELETE /expenses/recurring/:id` | НЕТ |  |
| Повторяющиеся | `PATCH /expenses/recurring/:id` | НЕТ |  |
| Повторяющиеся | `GET /expenses/recurring` | НЕТ |  |
| Повторяющиеся | `POST /expenses/recurring` | НЕТ |  |
| Показать: upcoming | `GET /expenses/upcoming` | НЕТ |  |
| Показать: расходы | `GET /expenses` | НЕТ |  |
| Показать: сводка | `GET /expenses/summary` | ЧАСТИЧНО | общая сводка финансов |

## Кабинет маркетинга и монтажа (`marketing`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Показать: каналы статус | `GET /marketing/channels-status` | НЕТ |  |
| Добавить: запустить | `POST /marketing/digests/run` | НЕТ |  |
| Показать: digests | `GET /marketing/digests` | НЕТ |  |
| Показать: монтажёр очередь | `GET /marketing/editor-queue` | НЕТ |  |
| Показать: монтажёры нагрузка | `GET /marketing/editors-load` | НЕТ |  |
| Показать: facebook crosspost проверка | `GET /marketing/facebook-crosspost-check` | НЕТ |  |
| Показать: first seconds | `GET /marketing/first-seconds` | НЕТ |  |
| Показать: статус | `GET /marketing/meta-catalog-feed/status` | НЕТ |  |
| Показать: публикация analysis | `GET /marketing/post-analysis` | НЕТ |  |
| Показать: публикация цифры | `GET /marketing/post-stats` | НЕТ |  |
| Показать: опубликовать schedule | `GET /marketing/publish-schedule` | НЕТ |  |
| Показать: очередь | `GET /marketing/queue` | НЕТ |  |
| Показать: недавно опубликованные | `GET /marketing/recently-published` | НЕТ |  |
| Показать: сводка | `GET /marketing/summary` | НЕТ |  |
| Показать: Telegram chats проверка | `GET /marketing/telegram-chats-check` | НЕТ |  |
| Отменить | `POST /marketing/video-handoff/:id/cancel` | НЕТ |  |
| Добавить: hold | `POST /marketing/video-handoff/:id/hold` | НЕТ |  |
| Добавить: move | `POST /marketing/video-handoff/:id/move` | НЕТ |  |
| Добавить: resend | `POST /marketing/video-handoff/:id/resend` | НЕТ |  |
| Добавить: unhold | `POST /marketing/video-handoff/:id/unhold` | НЕТ |  |
| Показать: очередь state | `GET /marketing/video-handoff/queue-state` | НЕТ |  |
| Добавить: пауза | `POST /marketing/video-handoff/queue/pause` | НЕТ |  |
| Добавить: продолжить | `POST /marketing/video-handoff/queue/resume` | НЕТ |  |

## Кабинет службы безопасности (`security`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Добавить: decisions | `POST /security/cases/:id/decisions` | НЕТ |  |
| Добавить: severity | `POST /security/cases/:id/severity` | НЕТ |  |
| Показать: случаи | `GET /security/cases/:id` | НЕТ |  |
| Показать: agency label предпросмотр | `GET /security/cases/agency-label-preview` | НЕТ |  |
| Показать: automation предпросмотр | `GET /security/cases/automation-preview` | НЕТ |  |
| Показать: покупатель показ candidates | `GET /security/cases/buyer-showing-candidates` | НЕТ |  |
| Показать: настройка | `GET /security/cases/config` | НЕТ |  |
| Заменить: настройка | `PUT /security/cases/config` | НЕТ |  |
| Показать: manual contact предпросмотр | `GET /security/cases/manual-contact-preview` | НЕТ |  |
| Показать: named assignment предпросмотр | `GET /security/cases/named-assignment-preview` | НЕТ |  |
| Показать: recurrence | `GET /security/cases/recurrence` | НЕТ |  |
| Показать: продавец управление предпросмотр | `GET /security/cases/seller-control-preview` | НЕТ |  |
| Добавить: покупатель кандидат | `POST /security/cases/seller-control/buyer-candidate` | НЕТ |  |
| Показать: продавец управление | `GET /security/cases/seller-control` | НЕТ |  |
| Показать: weekly operational предпросмотр | `GET /security/cases/weekly-operational-preview` | НЕТ |  |
| Показать: workflow сотрудник предпросмотр | `GET /security/cases/workflow-agent-preview` | НЕТ |  |
| Показать: workflow observations | `GET /security/cases/workflow-observations` | НЕТ |  |
| Показать: случаи | `GET /security/cases` | НЕТ |  |
| Показать: потерянные клиенты | `GET /security/lost-clients` | НЕТ |  |
| Показать: потерянные объекты | `GET /security/lost-properties` | НЕТ |  |
| Показать: сводка | `GET /security/summary` | НЕТ |  |

## Реклама Meta: расходы и привязка объявлений (`ads`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Изменить: владение клиентом | `PATCH /ads/:id/ownership` | НЕТ |  |
| Изменить: объекты | `PATCH /ads/:id/properties` | НЕТ |  |
| Изменить: объект | `PATCH /ads/:id/property` | НЕТ |  |
| Показать: подключения | `GET /ads/accounts` | НЕТ |  |
| Показать: доска | `GET /ads/board` | НЕТ |  |
| Добавить: подключить | `POST /ads/connect` | НЕТ |  |
| Показать: creatives | `GET /ads/creatives` | НЕТ |  |
| Отключить | `POST /ads/disconnect` | НЕТ |  |
| Показать: чужой | `GET /ads/foreign` | НЕТ |  |
| Показать: находки ИИ | `GET /ads/insights` | НЕТ |  |
| Показать: leaderboard | `GET /ads/leaderboard` | НЕТ |  |
| Показать: pacing | `GET /ads/pacing` | НЕТ |  |
| Показать: объект | `GET /ads/property/:id` | НЕТ |  |
| Показать: reconcile | `GET /ads/reconcile` | НЕТ |  |
| Показать: отчёт | `GET /ads/report` | НЕТ |  |
| Добавить: сверка с сайтом | `POST /ads/sync` | НЕТ |  |
| Показать: trend | `GET /ads/trend` | НЕТ |  |
| Показать: без пары | `GET /ads/unmatched` | НЕТ |  |

## Сотрудники: карточки, права, аватары (`agents`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Добавить: сброс | `POST /agents/:id/2fa/reset` | НЕТ |  |
| Добавить: фотография сотрудника | `POST /agents/:id/avatar` | НЕТ |  |
| Добавить: звонок | `POST /agents/:id/call` | НЕТ |  |
| Добавить: заморозить | `POST /agents/:id/freeze` | НЕТ |  |
| Добавить: передача | `POST /agents/:id/handover` | НЕТ |  |
| Показать: handovers | `GET /agents/:id/handovers` | НЕТ |  |
| Удалить: заявка пауза | `DELETE /agents/:id/lead-pause` | НЕТ |  |
| Добавить: заявка пауза | `POST /agents/:id/lead-pause` | НЕТ |  |
| Показать: вживую | `GET /agents/:id/live` | НЕТ |  |
| Показать: обзор | `GET /agents/:id/overview` | НЕТ |  |
| Показать: точки | `GET /agents/:id/points` | НЕТ |  |
| Добавить: разморозить | `POST /agents/:id/unfreeze` | НЕТ |  |
| Удалить: сотрудники | `DELETE /agents/:id` | НЕТ |  |
| Изменить: сотрудники | `PATCH /agents/:id` | НЕТ |  |
| Показать: свободные | `GET /agents/extensions/free` | НЕТ |  |
| Добавить: revert | `POST /agents/handovers/:batchId/revert` | НЕТ |  |
| Показать: сотрудники | `GET /agents` | НЕТ |  |
| Добавить: сотрудники | `POST /agents` | НЕТ |  |

## Отчёты за период (`reports`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Изменить: за месяц | `PATCH /reports/monthly/:id` | НЕТ |  |
| Собрать | `POST /reports/monthly/generate` | НЕТ |  |
| Заменить: настройка | `PUT /reports/post-showing-cohort/config` | НЕТ |  |
| Изменить: проблемы | `PATCH /reports/problems/:id` | НЕТ |  |
| Собрать | `POST /reports/problems/generate` | НЕТ |  |
| Показать: сотрудники | `GET /reports/agents` | ЧАСТИЧНО | сводки статистики и источников |
| Показать: demand supply | `GET /reports/demand-supply` | ЧАСТИЧНО | сводки статистики и источников |
| Показать: воронка | `GET /reports/funnel` | ЧАСТИЧНО | сводки статистики и источников |
| Показать: горячие объекты | `GET /reports/hot-properties` | ЧАСТИЧНО | сводки статистики и источников |
| Показать: потерянные по канал | `GET /reports/lost-by-channel` | ЧАСТИЧНО | сводки статистики и источников |
| Показать: маркетинг воронка | `GET /reports/marketing-funnel` | ЧАСТИЧНО | сводки статистики и источников |
| Показать: маркетинг находки ИИ | `GET /reports/marketing-insights` | ЧАСТИЧНО | сводки статистики и источников |
| Показать: за месяц | `GET /reports/monthly` | ЧАСТИЧНО | сводки статистики и источников |
| Показать: публикация показ cohort | `GET /reports/post-showing-cohort` | ЧАСТИЧНО | сводки статистики и источников |
| Показать: проблемы | `GET /reports/problems` | ЧАСТИЧНО | сводки статистики и источников |
| Показать: response speed | `GET /reports/response-speed` | ЧАСТИЧНО | сводки статистики и источников |
| Показать: источники | `GET /reports/sources` | ЧАСТИЧНО | сводки статистики и источников |
| Показать: ожидают сейчас | `GET /reports/waiting-now` | ЧАСТИЧНО | сводки статистики и источников |

## social-videos (`social-videos`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Добавить: add destinations | `POST /social-videos/:id/add-destinations` | НЕТ |  |
| Добавить: copy | `POST /social-videos/:id/copy` | НЕТ |  |
| Добавить: ии | `POST /social-videos/:id/cover/ai` | НЕТ |  |
| Удалить: обложка | `DELETE /social-videos/:id/cover` | НЕТ |  |
| Добавить: обложка | `POST /social-videos/:id/cover` | НЕТ |  |
| Добавить: mark removed | `POST /social-videos/:id/mark-removed` | НЕТ |  |
| Опубликовать | `POST /social-videos/:id/publish` | НЕТ |  |
| Добавить: remove from socials | `POST /social-videos/:id/remove-from-socials` | НЕТ |  |
| Добавить: повторить | `POST /social-videos/:id/retry` | НЕТ |  |
| Добавить: unschedule | `POST /social-videos/:id/unschedule` | НЕТ |  |
| Удалить: social videos | `DELETE /social-videos/:id` | НЕТ |  |
| Открыть: social videos | `GET /social-videos/:id` | НЕТ |  |
| Изменить: social videos | `PATCH /social-videos/:id` | НЕТ |  |
| Добавить: ии подпись | `POST /social-videos/ai-caption` | НЕТ |  |
| Показать: ии providers | `GET /social-videos/ai-providers` | НЕТ |  |
| Показать: вживую | `GET /social-videos/channels/live` | НЕТ |  |
| Показать: каналы | `GET /social-videos/channels` | НЕТ |  |
| Показать: trends | `GET /social-videos/trends` | НЕТ |  |

## Кандидаты на вакансии (`vacancies`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Добавить: звонок | `POST /vacancies/:id/call` | НЕТ |  |
| Показать: contact options | `GET /vacancies/:id/contact-options` | НЕТ |  |
| Показать: переписка | `GET /vacancies/:id/conversation` | НЕТ |  |
| Добавить: предпросмотр | `POST /vacancies/:id/invitations/preview` | НЕТ |  |
| Добавить: invitations | `POST /vacancies/:id/invitations` | НЕТ |  |
| Показать: invite звонок recording | `GET /vacancies/:id/invite-call-recording` | НЕТ |  |
| Удалить: вакансии | `DELETE /vacancies/:id` | НЕТ |  |
| Открыть: вакансии | `GET /vacancies/:id` | НЕТ |  |
| Изменить: вакансии | `PATCH /vacancies/:id` | НЕТ |  |
| Добавить: пачкой | `POST /vacancies/bulk` | НЕТ |  |
| Заменить: positions | `PUT /vacancies/positions/:key` | НЕТ |  |
| Показать: recovery | `GET /vacancies/positions/recovery/:campaign` | НЕТ |  |
| Добавить: recovery | `POST /vacancies/positions/recovery` | НЕТ |  |
| Показать: templates | `GET /vacancies/positions/templates` | НЕТ |  |
| Показать: positions | `GET /vacancies/positions` | НЕТ |  |
| Показать: вакансии | `GET /vacancies` | НЕТ |  |
| Добавить: вакансии | `POST /vacancies` | НЕТ |  |

## Контроль руководителя (`oversight`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Показать: сотрудник потери серия | `GET /oversight/agent-loss-series` | НЕТ |  |
| Показать: сотрудники at предел | `GET /oversight/agents-at-limit` | НЕТ |  |
| Показать: бесконечные переговоры | `GET /oversight/endless-negotiations` | НЕТ |  |
| Показать: неактивные клиенты | `GET /oversight/inactive-clients` | НЕТ |  |
| Показать: заявка передачи | `GET /oversight/lead-transfers` | НЕТ |  |
| Показать: просроченные задачи | `GET /oversight/overdue-tasks` | НЕТ |  |
| Показать: отказавшиеся high баллы | `GET /oversight/refused-high-score` | НЕТ |  |
| Показать: продавец объект отсутствует | `GET /oversight/seller-property-missing` | НЕТ |  |
| Показать: запись разговора | `GET /oversight/showing-survey-calls/:id/recording` | НЕТ |  |
| Показать: показ опрос звонки | `GET /oversight/showing-survey-calls/:id` | НЕТ |  |
| Показать: показ опрос звонки | `GET /oversight/showing-survey-calls` | НЕТ |  |
| Показать: молчащие после показ | `GET /oversight/silent-after-showing` | НЕТ |  |
| Показать: заглохшие клиенты | `GET /oversight/stalled-clients` | НЕТ |  |
| Показать: сводка | `GET /oversight/summary` | НЕТ |  |
| Показать: светофор светофор сводка | `GET /oversight/traffic-light-summary` | НЕТ |  |
| Показать: передать пары | `GET /oversight/transfer-pairs` | НЕТ |  |

## Главная, пульт директора, модули пульта, утренняя сводка (`dashboard`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Показать: сводка | `GET /dashboard/briefing` | НЕТ |  |
| Показать: графики | `GET /dashboard/charts` | НЕТ |  |
| Добавить: просмотрено | `POST /dashboard/counters/seen` | НЕТ |  |
| Показать: счётчики | `GET /dashboard/counters` | НЕТ |  |
| Показать: каналы | `GET /dashboard/heatmap/channels` | НЕТ |  |
| Показать: тепловая карта | `GET /dashboard/heatmap` | НЕТ |  |
| Показать: находки ИИ | `GET /dashboard/insights` | НЕТ |  |
| Добавить: вопрос | `POST /dashboard/mission-control/ask` | НЕТ |  |
| Показать: вживую | `GET /dashboard/mission-control/live` | НЕТ |  |
| Показать: бегущая строка | `GET /dashboard/mission-control/ticker` | НЕТ |  |
| Показать: зоны | `GET /dashboard/mission-control/zones` | НЕТ |  |
| Показать: sales управление | `GET /dashboard/sales-control` | НЕТ |  |
| Показать: сводка | `GET /dashboard/summary` | НЕТ |  |
| Показать: команда вживую | `GET /dashboard/team-live` | НЕТ |  |

## Переписка по всем каналам (`conversations`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Добавить: ссылка клиент | `POST /conversations/:id/link-client` | НЕТ |  |
| Добавить: пауза | `POST /conversations/:id/pause` | НЕТ |  |
| Добавить: ответ отзыв | `POST /conversations/:id/reply-feedback` | НЕТ |  |
| Добавить: ответ файл | `POST /conversations/:id/reply-media` | НЕТ |  |
| Добавить: ответ голос | `POST /conversations/:id/reply-voice` | НЕТ |  |
| Ответить | `POST /conversations/:id/reply` | НЕТ |  |
| Добавить: продолжить | `POST /conversations/:id/resume` | НЕТ |  |
| Добавить: перевести | `POST /conversations/:id/translate` | НЕТ |  |
| Открыть: переписки | `GET /conversations/:id` | НЕТ |  |
| Показать: groups | `GET /conversations/groups/:groupId` | НЕТ |  |
| Показать: переписки | `GET /conversations` | НЕТ |  |

## Звонки, показы, встречи — всё, что агент отмечает (`interactions`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Завершить | `PATCH /interactions/:id/complete` | ЕСТЬ |  |
| Отменить | `PATCH /interactions/:id/showing/cancel` | ЕСТЬ |  |
| Изменить: перенести | `PATCH /interactions/:id/showing/reschedule` | ЕСТЬ |  |
| Показать: отметки в хронологии | `GET /interactions` | ЕСТЬ |  |
| Показать: запись разговора | `GET /interactions/:id/recording` | НЕТ |  |
| Добавить: retranscribe | `POST /interactions/:id/retranscribe` | НЕТ |  |
| Добавить: перевести | `POST /interactions/:id/translate` | НЕТ |  |
| Добавить: work response | `POST /interactions/:id/work-response` | НЕТ |  |
| Показать: сводка | `GET /interactions/summary` | НЕТ |  |
| Показать: расшифровка | `GET /interactions/:id/transcript` | ЧАСТИЧНО | только последний звонок клиента |

## Чек-листы и выдачи лид-магнитов (`lead-magnets`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Добавить: дубль | `POST /lead-magnets/:id/duplicate` | НЕТ |  |
| Изменить: включено | `PATCH /lead-magnets/:id/enabled` | НЕТ |  |
| Удалить: файл | `DELETE /lead-magnets/:id/file` | НЕТ |  |
| Добавить: файл | `POST /lead-magnets/:id/file` | НЕТ |  |
| Добавить: порепетировать | `POST /lead-magnets/:id/rehearse` | НЕТ |  |
| Удалить: лид-магниты | `DELETE /lead-magnets/:id` | НЕТ |  |
| Изменить: лид-магниты | `PATCH /lead-magnets/:id` | НЕТ |  |
| Показать: доставки | `GET /lead-magnets/deliveries` | НЕТ |  |
| Показать: лид-магниты | `GET /lead-magnets` | НЕТ |  |
| Добавить: лид-магниты | `POST /lead-magnets` | НЕТ |  |

## Уроки, извлечённые из ошибок бота (`bot-learning`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Добавить: поднять | `POST /bot-learning/:id/bump` | НЕТ |  |
| Удалить: уроки бота | `DELETE /bot-learning/:id` | НЕТ |  |
| Изменить: уроки бота | `PATCH /bot-learning/:id` | НЕТ |  |
| Добавить: выжимка сейчас | `POST /bot-learning/distill-now` | НЕТ |  |
| Изменить: группа | `PATCH /bot-learning/group` | НЕТ |  |
| Закрыть находку | `POST /bot-learning/lost/reviews/:id/resolve` | НЕТ |  |
| Показать: потерянные | `GET /bot-learning/lost` | НЕТ |  |
| Показать: уроки бота | `GET /bot-learning` | НЕТ |  |

## Журнал ошибок системы (`errors`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Добавить: открыть заново | `POST /errors/:id/reopen` | НЕТ |  |
| Закрыть находку | `POST /errors/:id/resolve` | НЕТ |  |
| Добавить: gemini здоровье системы проверка | `POST /errors/gemini-health-check` | НЕТ |  |
| Закрыть все находки | `POST /errors/resolve-all` | НЕТ |  |
| Добавить: повторить | `POST /errors/stuck-conversations/retry` | НЕТ |  |
| Показать: застрявшие переписки | `GET /errors/stuck-conversations` | НЕТ |  |
| Показать: ошибки | `GET /errors` | НЕТ |  |

## search-console (`search-console`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Отключить | `POST /search-console/disconnect` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Показать: начало | `GET /search-console/oauth/start` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Показать: обзор | `GET /search-console/overview` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Заменить: app | `PUT /search-console/yandex/app` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Отключить | `POST /search-console/yandex/disconnect` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Показать: начало | `GET /search-console/yandex/oauth/start` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Показать: обзор | `GET /search-console/yandex/overview` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |

## Запросы к ИИ из интерфейса (`ai`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Показать: помощник проверка | `GET /ai/assistant-audit` | НЕТ |  |
| Показать: стоимость | `GET /ai/cost` | НЕТ |  |
| Добавить: собрать публикация | `POST /ai/generate-listing` | НЕТ |  |
| Показать: находки ИИ | `GET /ai/insights` | НЕТ |  |
| Добавить: разобрать заметка | `POST /ai/parse-note` | НЕТ |  |
| Добавить: объект черновик | `POST /ai/property-draft/:clientId` | НЕТ |  |

## Вход, двухфакторная проверка, сессии устройств (`auth`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Добавить: варианты | `POST /auth/passkey/login/options` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Добавить: проверить | `POST /auth/passkey/login/verify` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Показать: сеанс | `GET /auth/session` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Показать: повторная проверка личности | `GET /auth/step-up` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Добавить: повторная проверка личности | `POST /auth/step-up` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Добавить: повторная проверка личности | `POST /auth/step-up` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |

## Находки ночного судьи диалогов (`bot-audit`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Закрыть находку | `POST /bot-audit/:id/resolve` | НЕТ |  |
| Показать: группа примеры | `GET /bot-audit/group-examples` | НЕТ |  |
| Закрыть находку | `POST /bot-audit/group/resolve` | НЕТ |  |
| Закрыть все находки | `POST /bot-audit/resolve-all` | НЕТ |  |
| Добавить: запустить | `POST /bot-audit/run` | НЕТ |  |
| Показать: бот проверка | `GET /bot-audit` | НЕТ |  |

## Экран «Манера» — закрыт тумблером (`bot-training`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Добавить: решение | `POST /bot-training/decide` | НЕТ |  |
| Показать: сторож цифры | `GET /bot-training/guard-stats` | НЕТ |  |
| Показать: следующий | `GET /bot-training/next` | НЕТ |  |
| Удалить: примеры | `DELETE /bot-training/samples/:id` | НЕТ |  |
| Изменить: примеры | `PATCH /bot-training/samples/:id` | НЕТ |  |
| Показать: примеры | `GET /bot-training/samples` | НЕТ |  |

## Журнал звонков и расшифровки (`calls`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Показать: лента | `GET /calls/feed` | НЕТ |  |
| Показать: входящие | `GET /calls/incoming` | НЕТ |  |
| Показать: находки ИИ | `GET /calls/insights` | НЕТ |  |
| Показать: сводка | `GET /calls/summary` | НЕТ |  |
| Показать: главная | `GET /calls/telephony/dashboard` | НЕТ |  |
| Показать: звонки | `GET /calls` | НЕТ |  |

## Пуш-уведомления на телефон (`push`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Показать: настройка | `GET /push/config` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Показать: пожелания | `GET /push/preferences` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Изменить: пожелания | `PATCH /push/preferences` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Добавить: подписаться | `POST /push/subscribe` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Добавить: проверка | `POST /push/test` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Добавить: отписаться | `POST /push/unsubscribe` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |

## market (`market`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Добавить: публикация contact | `POST /market/listing-contact` | НЕТ |  |
| Добавить: статус | `POST /market/matches/:matchId/status` | НЕТ |  |
| Показать: объект | `GET /market/matches/property/:id` | НЕТ |  |
| Показать: dynamics | `GET /market/property/:id/dynamics` | НЕТ |  |
| Показать: объект | `GET /market/property/:id` | НЕТ |  |

## sms (`sms`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Показать: balance | `GET /sms/balance` | НЕТ |  |
| Показать: настройки | `GET /sms/settings` | НЕТ |  |
| Изменить: настройки | `PATCH /sms/settings` | НЕТ |  |
| Показать: статус | `GET /sms/status` | НЕТ |  |
| Добавить: проверка | `POST /sms/test` | НЕТ |  |

## Сделки, документы, выплаты (`deals`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Показать: сделки | `GET /deals` | ЕСТЬ |  |
| Добавить: annul | `POST /deals/:id/annul` | НЕТ |  |
| Изменить: сделки | `PATCH /deals/:id` | НЕТ |  |
| Добавить: сделки | `POST /deals` | НЕТ |  |

## Поиск адреса и точки по собственному справочнику города (`geo`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Показать: ориентиры | `GET /geo/landmarks` | НЕТ |  |
| Показать: поиск | `GET /geo/lookup` | НЕТ |  |
| Закрыть находку | `GET /geo/resolve` | НЕТ |  |
| Показать: подсказать | `GET /geo/suggest` | НЕТ |  |

## Инсайты от ИИ по звонкам (`insights`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Открыть: находки ИИ | `GET /insights/:id` | НЕТ |  |
| Изменить: случаи | `PATCH /insights/cases/:id` | НЕТ |  |
| Собрать | `POST /insights/generate` | НЕТ |  |
| Показать: находки ИИ | `GET /insights` | НЕТ |  |

## Лента комментариев под публикациями (`instagram-comments`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Скрыть | `POST /instagram-comments/:id/hide` | НЕТ |  |
| Ответить | `POST /instagram-comments/:id/reply` | НЕТ |  |
| Показать обратно | `POST /instagram-comments/:id/unhide` | НЕТ |  |
| Показать: Instagram комментарии | `GET /instagram-comments` | НЕТ |  |

## Публикация в TikTok (`tiktok`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Показать: автор сведения | `GET /tiktok/creator-info` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Отключить | `POST /tiktok/disconnect` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Показать: находки ИИ | `GET /tiktok/insights` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Показать: начало | `GET /tiktok/oauth/start` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |

## Ручная тренировка бота (`bot-trainer`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Добавить: решение | `POST /bot-trainer/decide` | НЕТ |  |
| Показать: очередь | `GET /bot-trainer/queue` | НЕТ |  |
| Добавить: варианты | `POST /bot-trainer/variants` | НЕТ |  |

## Изменения, прилетевшие с сайта (`site-notifications`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Закрыть находку | `POST /site-notifications/:id/resolve` | НЕТ |  |
| Закрыть все находки | `POST /site-notifications/resolve-all` | НЕТ |  |
| Показать: сайт уведомления | `GET /site-notifications` | НЕТ |  |

## ui-shell (`ui-shell`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Показать: настройка | `GET /ui-shell/config` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Заменить: настройка | `PUT /ui-shell/config` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Показать: ui shell | `GET /ui-shell` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |

## whatsapp-templates (`whatsapp-templates`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Изменить: account | `PATCH /whatsapp-templates/account` | НЕТ |  |
| Добавить: submit | `POST /whatsapp-templates/submit` | НЕТ |  |
| Показать: WhatsApp templates | `GET /whatsapp-templates` | НЕТ |  |

## Справочник районов (`districts`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Показать: районы | `GET /districts` | НЕТ |  |
| Добавить: районы | `POST /districts` | НЕТ |  |

## Зал славы по Royal Score (`hall-of-fame`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Показать: лучшие сотрудники | `GET /hall-of-fame/top-agents` | НЕТ |  |
| Показать: зал of славы | `GET /hall-of-fame` | НЕТ |  |

## Загрузка данных пачкой (`import`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Добавить: клиенты | `POST /import/clients` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |
| Добавить: объекты | `POST /import/properties` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |

## Начисления и списания баллов агентам (`royal-score-events`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Изменить: переопределить | `PATCH /royal-score-events/:id/override` | НЕТ |  |
| Показать: по клиент | `GET /royal-score-events/by-client/:clientId` | НЕТ |  |

## Экран «Что не доехало»: работа, которую система не довела до конца (`stuck-work`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Добавить: повторить | `POST /stuck-work/:id/retry` | НЕТ |  |
| Показать: застрявшие work | `GET /stuck-work` | НЕТ |  |

## Команда: нагрузка, портфель (`team`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Показать: этапы | `GET /team/stages` | НЕТ |  |
| Показать: команда | `GET /team` | НЕТ |  |

## Вложения переписки (`attachments`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Открыть: вложения | `GET /attachments/:name` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |

## Журнал действий сотрудников (`audit-log`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Показать: проверка журнал | `GET /audit-log` | НЕТ |  |

## Отчёты о резервных копиях (`backups`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Показать: резервные копии | `GET /backups` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |

## Сценарии продаж для бота (`bot-scenarios`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Показать: бот сценарии | `GET /bot-scenarios` | НЕТ |  |

## Календарь задач и показов (`calendar`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Показать: задачи | `GET /calendar/tasks` | ЕСТЬ |  |

## contacts (`contacts`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Изменить: contacts | `PATCH /contacts/:id` | НЕТ |  |

## Деньги: доходы, комиссии, прогноз (`finance`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Показать: прогноз | `GET /finance/forecast` | НЕТ |  |

## Состояние внешних подключений (`integrations`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Показать: интеграции | `GET /integrations` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |

## live-voice (`live-voice`)

| Действие | Адрес | Шабнам | Примечание |
|---|---|---|---|
| Показать: активен | `GET /live-voice/active` | В CRM | вход, пароли, ключи, подключения — оставить в CRM |

## Живая Шабнам — мозговой штурм владельца (10.11.2026)

ФАКТ по коду: уже умеет реакции на сообщения (`setMessageReaction`), голосовые ответы (`assistantVoice.ts`), карточки и альбомы фото объектов (`sendPhoto`, `sendMediaGroup`). Стикеров, GIF, своих картинок-сводок и Mini App у неё нет. Разбор звонков есть (`ai/callAnalysis.ts`, `callInsights.ts`), но Шабнам по ним сама не пишет.

Решение владельца 10.11: замечаний после звонков НЕ делать; Шабнам сама пишет только по очень серьёзному поводу, «редко беспокоить людей». Пункты 2, 3, 7, 8, 11, 15 — только по запросу или в одной сводке.

Единый список (порядок — предложение):
1. Telegram Mini App: мастер объекта с фото и картой, расходы, карта объектов — внутри Telegram (снимок Mini App сайта — PR сайта #29).
2. Замечания после звонка лично агенту через 5 минут: что клиент спросил и осталось без ответа, что обещано, задача; тон наставника.
3. Обещания из звонков и чатов → напоминание.
4. Свой стикерпак Шабнам (15–20 штук: принято, ищу, нашла, ура сделка, доброе утро, не нашла), один раз, утверждает владелец.
5. Картинка вместо таблицы: итоги дня, график, мини-карта с точками объектов.
6. Голосом на голос, на языке собеседника.
7. Похвала конкретная и итоги недели в группе (Royal Score, зал славы), челлендж недели.
8. Праздники и личное: дни рождения, Навруз, годовщина в компании — открытка.
9. Характер и лёгкий юмор; без шуток в деньгах, ошибках, жалобах, увольнении.
10. Память манеры: кому коротко, кому подробно, кому голосом.
11. Утренняя голосовая планёрка в группе (1 мин).
12. Подсказка к показу по фото квартиры: что выделить.
13. Inline-режим: @бот «трёшка Сино» в любом чате Telegram → карточка объекта.
14. Замечания по данным один раз, без навязчивости (дубль карточки и т.п.).
15. Директору — итог по команде, не каждый звонок; лучшие звонки — в пример.
16. Тумблер живости у каждого (много/мало/без стикеров), в группе сдержаннее.
17. Предел инициативных сообщений в день, тихие часы, не во время показа (по календарю).
18. Замер: отвечают ли на подсказки; раздражает — убавить.
Не делаем: случайные GIF из интернет-библиотек (неподходящий контент), видео-аватар (дорого, не нужно сейчас), сама пишет клиентам без «Да».
