# Карта продукта Royal Home CRM

> **Этот файл собран программой из кода, руками его не правят.**
> Источник — `scripts/product-map.mjs`. Перестроить: `npm run map`.
> Проверить, что карта не отстала от кода: `npm run map:check`.
> Дат в файле нет намеренно: иначе он менялся бы каждый запуск и проверка
> «карта отстала» стала бы бессмысленной.

## Коротко, цифрами

| Что | Сколько |
|---|---|
| Экранов (адресов в интерфейсе) | 67 |
| Из них видно в меню | 35 |
| Модулей сервера | 78 |
| Адресов сервера всего | 659 |
| Задач по расписанию | 103 |
| Типов фоновых заданий | 23 |
| Внешних сервисов | 13 |

## 1. Экраны интерфейса

«В меню» — пункт есть в боковом меню или в нижней панели (`lib/navigation.ts`).
«Только по ссылке» — экран существует, но попасть на него можно лишь прямым адресом.

| Адрес | Экран | В меню | Файл |
|---|---|---|---|
| `/` | Dashboard | **Главная** | `apps/web/src/pages/Dashboard.tsx` |
| `/*` | NotFound | только по ссылке | — |
| `/activity` | Activity | **Активность команды** | `apps/web/src/pages/Activity.tsx` |
| `/ads` | Ads | **Реклама** | `apps/web/src/pages/Ads.tsx` |
| `/ads/launch/*` | Navigate | переход на `/ads` | — |
| `/ai-learning` | AiLearning | **Обучение бота** | `apps/web/src/pages/AiLearning.tsx` |
| `/archive` | Archive | **Архив** | `apps/web/src/pages/Archive.tsx` |
| `/backups` | Backups | **Резервные копии** | `apps/web/src/pages/Backups.tsx` |
| `/bot-training` | Navigate | переход на `/ai-learning?tab=manner` | — |
| `/calendar` | Calendar | **Календарь** | `apps/web/src/pages/Calendar.tsx` |
| `/calls` | Calls | **Звонки** | `apps/web/src/pages/Calls.tsx` |
| `/clients` | Clients | **Клиенты** | `apps/web/src/pages/Clients.tsx` |
| `/clients/:id` | ClientDetail | только по ссылке | `apps/web/src/pages/ClientDetail.tsx` |
| `/clients/all-mine` | Clients | только по ссылке | `apps/web/src/pages/Clients.tsx` |
| `/comments` | Comments | **Комментарии** | `apps/web/src/pages/Comments.tsx` |
| `/deals` | Deals | **Сделки** | `apps/web/src/pages/Deals.tsx` |
| `/deferred-clients` | DeferredClients | **Отложенные** | `apps/web/src/pages/DeferredClients.tsx` |
| `/dev/ask-panel` | — | только по ссылке | — |
| `/dev/calls-port` | — | только по ссылке | — |
| `/dev/design-lab` | — | только по ссылке | — |
| `/dev/event-feed` | — | только по ссылке | — |
| `/dev/pult-actions` | — | только по ссылке | — |
| `/dev/pult-tiles` | — | только по ссылке | — |
| `/dev/sheets-port` | — | только по ссылке | — |
| `/dev/system-sheets-port` | — | только по ссылке | — |
| `/finance` | Finance | **Финансы** | `apps/web/src/pages/Finance.tsx` |
| `/funnel` | Funnel | **Воронка** | `apps/web/src/pages/Funnel.tsx` |
| `/hall-of-fame` | Team | только по ссылке | `apps/web/src/pages/Team.tsx` |
| `/health` | Health | **Здоровье системы** | `apps/web/src/pages/Health.tsx` |
| `/hot-clients` | Navigate | переход на `/clients` | — |
| `/inactive-clients` | Clients | только по ссылке | `apps/web/src/pages/Clients.tsx` |
| `/insights` | Insights | **Инсайты от ИИ** | `apps/web/src/pages/Insights.tsx` |
| `/integrations` | Integrations | **Интеграции и каналы** | `apps/web/src/pages/Integrations.tsx` |
| `/integrations/:name` | ChannelDetail | только по ссылке | `apps/web/src/pages/ChannelDetail.tsx` |
| `/l/:token` | — | только по ссылке | — |
| `/lead-funnel` | LeadFunnel | **Воронка лидов** | `apps/web/src/pages/LeadFunnel.tsx` |
| `/login` | — | только по ссылке | — |
| `/lost-clients` | LostClients | **Потерянные** | `apps/web/src/pages/LostClients.tsx` |
| `/marketing` | MarketingCenter | только по ссылке | `apps/web/src/pages/MarketingCenter.tsx` |
| `/messages` | Messages | **Чаты** | `apps/web/src/pages/Messages.tsx` |
| `/mission-control` | MissionControl | только по ссылке | `apps/web/src/pages/MissionControl.tsx` |
| `/more` | More | **Ещё** | `apps/web/src/pages/More.tsx` |
| `/notifications` | Notifications | только по ссылке | `apps/web/src/pages/Notifications.tsx` |
| `/o/:token` | — | только по ссылке | — |
| `/other-inquiries` | Clients | только по ссылке | `apps/web/src/pages/Clients.tsx` |
| `/oversight` | Oversight | **Контроль руководителя** | `apps/web/src/pages/Oversight.tsx` |
| `/pipeline` | Pipeline | **Подготовка объектов** | `apps/web/src/pages/Pipeline.tsx` |
| `/profile` | Profile | только по ссылке | `apps/web/src/pages/Profile.tsx` |
| `/properties` | Properties | **Объекты** | `apps/web/src/pages/Properties.tsx` |
| `/properties/:id` | PropertyDetail | только по ссылке | `apps/web/src/pages/PropertyDetail.tsx` |
| `/properties/:id/edit` | PropertyEdit | только по ссылке | `apps/web/src/pages/PropertyForm.tsx` |
| `/properties/map` | PropertiesMap | **Карта объектов** | `apps/web/src/pages/PropertiesMap.tsx` |
| `/properties/new` | — | только по ссылке | — |
| `/pult` | Pult | только по ссылке | `apps/web/src/pages/Pult.tsx` |
| `/reports` | Reports | **Отчёты** | `apps/web/src/pages/Reports.tsx` |
| `/security` | SecurityCenter | **Проверки** | `apps/web/src/pages/SecurityCenter.tsx` |
| `/sellers` | Clients | только по ссылке | `apps/web/src/pages/Clients.tsx` |
| `/settings` | Settings | **Настройки CRM** | `apps/web/src/pages/Settings.tsx` |
| `/settings/roles` | RolesMatrix | только по ссылке | `apps/web/src/pages/settings/RolesMatrix.tsx` |
| `/site-changes` | SiteChanges | **Изменения на сайте** | `apps/web/src/pages/SiteChanges.tsx` |
| `/social-videos` | SocialVideos | **Ролики в соцсети** | `apps/web/src/pages/SocialVideos.tsx` |
| `/sources` | Sources | **Источники лидов** | `apps/web/src/pages/Sources.tsx` |
| `/stuck-work` | StuckWork | **Что не доехало** | `apps/web/src/pages/StuckWork.tsx` |
| `/team` | Team | **Команда** | `apps/web/src/pages/Team.tsx` |
| `/team/:id` | TeamMemberDetail | только по ссылке | `apps/web/src/pages/TeamMemberDetail.tsx` |
| `/telephony` | Telephony | **Телефония** | `apps/web/src/pages/Telephony.tsx` |
| `/vacancies` | Vacancies | **Вакансии** | `apps/web/src/pages/Vacancies.tsx` |

### Пункты меню по складкам

| Складка | Пункт | Адрес | Кому видно |
|---|---|---|---|
| main | Главная | `/` | всем |
| main | Календарь | `/calendar` | всем |
| inbox | Сообщения | `/messages` | всем |
| inbox | Комментарии | `/comments` | всем |
| inbox | Звонки | `/calls` | право `calls.transcripts` |
| inbox | Телефония | `/telephony` | всем |
| people | Клиенты | `/clients` | всем |
| people | Воронка лидов | `/lead-funnel` | всем |
| people | Отложенные | `/deferred-clients` | всем |
| people | Потерянные | `/lost-clients` | всем |
| people | Сделки | `/deals` | всем |
| objects | Объекты | `/properties` | всем |
| objects | Карта объектов | `/properties/map` | всем |
| objects | Изменения на сайте | `/site-changes` | всем |
| team | Команда | `/team` | всем |
| team | Активность команды | `/activity` | право `clients.viewAll` |
| team | Контроль руководителя | `/oversight` | всем |
| team | Вакансии | `/vacancies` | всем |
| team | Служба безопасности | `/security` | всем |
| money | Финансы | `/finance` | всем |
| money | Отчёты | `/reports` | всем |
| money | Источники лидов | `/sources` | всем |
| money | Инсайты от ИИ | `/insights` | всем |
| ads | Реклама | `/ads` | всем |
| ads | Ролики в соцсети | `/social-videos` | всем |
| ads | Подготовка объектов | `/pipeline` | всем |
| ads | Воронка | `/funnel` | всем |
| system | Настройки CRM | `/settings` | всем |
| system | Здоровье системы | `/health` | всем |
| system | Интеграции и каналы | `/integrations` | всем |
| system | Резервные копии | `/backups` | всем |
| system | Что не доехало | `/stuck-work` | всем |
| system | Обучение бота | `/ai-learning` | всем |
| system | Архив | `/archive` | всем |
| team | Проверки | `/security` | всем |
| inbox | Чаты | `/messages` | всем |
| system | Ещё | `/more` | всем |

## 2. Модули сервера

«Зовёт интерфейс» — во фронте найден хотя бы один вызов по этому адресу.
Пусто — модуль работает сам (вебхуки, расписание) либо к нему никто не обращается.

| Адрес | Что делает | Адресов внутри | Зовёт интерфейс | Файл |
|---|---|---|---|---|
| `/api/v1/auth` | Вход, двухфакторная проверка, сессии устройств | 2 | да (6 мест) | — |
| `/api/v1/auth` | Вход, двухфакторная проверка, сессии устройств | 13 | да (6 мест) | `apps/api/src/routes/auth.ts` |
| `/api/v1/events` | Живая лента событий в браузере агента | 2 | да (1 мест) | `apps/api/src/routes/events.ts` |
| `/api/v1/me` | Свой профиль, настройки, устройства | 36 | да (12 мест) | `apps/api/src/routes/me.ts` |
| `/api/v1/me/notifications` | Лента уведомлений сотрудника | 4 | да (12 мест) | `apps/api/src/routes/notifications.ts` |
| `/api/v1/agents` | Сотрудники: карточки, права, аватары | 19 | да (8 мест) | `apps/api/src/routes/agents.ts` |
| `/api/v1/agents` | Сотрудники: карточки, права, аватары | 2 | да (8 мест) | `apps/api/src/routes/team.ts` |
| `/api/v1/districts` | Справочник районов | 2 | да (1 мест) | `apps/api/src/routes/districts.ts` |
| `/api/v1/geo` | Поиск адреса и точки по собственному справочнику города | 4 | да (3 мест) | `apps/api/src/routes/geo.ts` |
| `/api/v1/landmarks` | Народные ориентиры, которые ведут агенты | 8 | да (1 мест) | `apps/api/src/routes/landmarks.ts` |
| `/api/v1/properties` | Объекты: список, карточка, фото, видео, публикация | 109 | да (28 мест) | `apps/api/src/routes/properties.ts` |
| `/api/v1/clients` | Клиенты: карточки, передачи, отказы, подбор — самый крупный модуль | 60 | да (13 мест) | `apps/api/src/routes/clients.ts` |
| `/api/v1/deals` | Сделки, документы, выплаты | 3 | да (4 мест) | `apps/api/src/routes/deals.ts` |
| `/api/v1/deals` | Сделки, документы, выплаты | 4 | да (4 мест) | `apps/api/src/routes/dealDocuments.ts` |
| `/api/v1/deals` | Сделки, документы, выплаты | 2 | да (4 мест) | `apps/api/src/routes/dealPayout.ts` |
| `/api/v1/deals` | Сделки, документы, выплаты | 1 | да (4 мест) | `apps/api/src/routes/dealAnnul.ts` |
| `/api/v1/dashboard` | Главная, пульт директора, модули пульта, утренняя сводка | 9 | да (7 мест) | `apps/api/src/routes/dashboard.ts` |
| `/api/v1/dashboard` | Главная, пульт директора, модули пульта, утренняя сводка | 5 | да (7 мест) | `apps/api/src/routes/dashboardMissionControl.ts` |
| `/api/v1/dashboard` | Главная, пульт директора, модули пульта, утренняя сводка | 2 | да (7 мест) | `apps/api/src/routes/pultModules.ts` |
| `/api/v1/dashboard` | Главная, пульт директора, модули пульта, утренняя сводка | 2 | да (7 мест) | `apps/api/src/routes/briefing.ts` |
| `/api/v1/calendar` | Календарь задач и показов | 1 | да (1 мест) | `apps/api/src/routes/calendar.ts` |
| `/api/v1/interactions` | Звонки, показы, встречи — всё, что агент отмечает | 9 | да (3 мест) | `apps/api/src/routes/interactions.ts` |
| `/api/v1/calls` | Журнал звонков и расшифровки | 6 | да (1 мест) | `apps/api/src/routes/calls.ts` |
| `/api/v1/live-voice` | **без подписи** | 2 | да (1 мест) | `apps/api/src/routes/liveVoiceListen.ts` |
| `/api/v1/ai` | Запросы к ИИ из интерфейса | 9 | да (3 мест) | `apps/api/src/routes/ai.ts` |
| `/api/v1/transcribe` | Диктовка голосом в полях CRM | 1 | да (1 мест) | `apps/api/src/routes/transcribe.ts` |
| `/api/v1/reports` | Отчёты за период | 17 | да (3 мест) | `apps/api/src/routes/reports.ts` |
| `/api/v1/telephony/whisper` | Станция забирает подсказки оператору | 2 | нет | `apps/api/src/routes/telephonyWhisper.ts` |
| `/api/v1/settings/restore-points` | Точки возврата настроек | 2 | да (10 мест) | `apps/api/src/routes/settingsRestorePoints.ts` |
| `/api/v1/settings` | Настройки CRM и точки возврата | 42 | да (10 мест) | `apps/api/src/routes/settings.ts` |
| `/api/v1/ui-shell` | **без подписи** | 3 | да (2 мест) | `apps/api/src/routes/uiShell.ts` |
| `/api/v1/sms` | **без подписи** | 6 | да (2 мест) | `apps/api/src/routes/sms.ts` |
| `/api/v1/whatsapp-templates` | **без подписи** | 3 | да (1 мест) | `apps/api/src/routes/whatsappTemplates.ts` |
| `/api/v1/push` | Пуш-уведомления на телефон | 7 | да (2 мест) | `apps/api/src/routes/push.ts` |
| `/api/v1/webhooks` | Входящие от WhatsApp, Instagram, Telegram, сайта, станции | 11 | нет | `apps/api/src/routes/webhooks.ts` |
| `/api/v1/public` | Витрина для сайта royalhome.tj | 4 | нет | `apps/api/src/routes/publicFeed.ts` |
| `/api/v1/expenses` | Расходы агентства | 32 | да (3 мест) | `apps/api/src/routes/expenses.ts` |
| `/api/v1/finance` | Деньги: доходы, комиссии, прогноз | 1 | да (1 мест) | `apps/api/src/routes/finance.ts` |
| `/api/v1/security` | Кабинет службы безопасности | 3 | да (1 мест) | `apps/api/src/routes/security.ts` |
| `/api/v1/marketing` | Кабинет маркетинга и монтажа | 23 | да (3 мест) | `apps/api/src/routes/marketing.ts` |
| `/api/v1/social-videos` | **без подписи** | 20 | да (2 мест) | `apps/api/src/routes/socialVideos.ts` |
| `/api/v1/webhooks` | Входящие от WhatsApp, Instagram, Telegram, сайта, станции | 1 | нет | `apps/api/src/routes/budgetWebhook.ts` |
| `/api/v1/ads/callback` | Возврат из рекламного кабинета после подключения | 1 | да (1 мест) | `apps/api/src/routes/ads.ts` |
| `/api/v1/ads` | Реклама Meta: расходы и привязка объявлений | 19 | да (1 мест) | `apps/api/src/routes/ads.ts` |
| `/api/v1/tiktok/oauth/callback` | Возврат из TikTok после подключения | 1 | да (2 мест) | `apps/api/src/routes/tiktok.ts` |
| `/api/v1/tiktok` | Публикация в TikTok | 4 | да (2 мест) | `apps/api/src/routes/tiktok.ts` |
| `/api/v1/threads/oauth/callback` | **без подписи** | 1 | да (1 мест) | `apps/api/src/routes/threads.ts` |
| `/api/v1/threads` | **без подписи** | 3 | да (1 мест) | `apps/api/src/routes/threads.ts` |
| `/api/v1/search-console/oauth/callback` | **без подписи** | 1 | да (3 мест) | `apps/api/src/routes/searchConsole.ts` |
| `/api/v1/search-console/yandex/oauth/callback` | **без подписи** | 1 | да (3 мест) | `apps/api/src/routes/searchConsole.ts` |
| `/api/v1/search-console` | **без подписи** | 7 | да (3 мест) | `apps/api/src/routes/searchConsole.ts` |
| `/api/v1/team` | Команда: нагрузка, портфель | 2 | да (1 мест) | `apps/api/src/routes/team.ts` |
| `/api/v1/hall-of-fame` | Зал славы по Royal Score | 2 | да (1 мест) | `apps/api/src/routes/hallOfFame.ts` |
| `/api/v1/import` | Загрузка данных пачкой | 4 | нет | `apps/api/src/routes/import.ts` |
| `/api/v1/site-notifications` | Изменения, прилетевшие с сайта | 3 | да (2 мест) | `apps/api/src/routes/siteNotifications.ts` |
| `/api/v1/contacts` | **без подписи** | 5 | да (2 мест) | `apps/api/src/routes/contacts.ts` |
| `/api/v1/conversations` | Переписка по всем каналам | 10 | да (3 мест) | `apps/api/src/routes/conversations.ts` |
| `/api/v1/audit-log` | Журнал действий сотрудников | 1 | да (1 мест) | `apps/api/src/routes/auditLog.ts` |
| `/api/v1/royal-score-events` | Начисления и списания баллов агентам | 2 | да (1 мест) | `apps/api/src/routes/royalScoreEvents.ts` |
| `/api/v1/morning-report` | Служебная выдача для внешней сессии, интерфейс её не зовёт | 1 | нет | `apps/api/src/routes/morningReport.ts` |
| `/api/v1/errors` | Журнал ошибок системы | 8 | да (5 мест) | `apps/api/src/routes/errorLog.ts` |
| `/api/v1/integrations` | Состояние внешних подключений | 1 | да (1 мест) | `apps/api/src/routes/integrations.ts` |
| `/api/v1/stuck-work` | Экран «Что не доехало»: работа, которую система не довела до конца | 2 | да (2 мест) | `apps/api/src/routes/stuckWork.ts` |
| `/api/v1/backups` | Отчёты о резервных копиях | 2 | нет | `apps/api/src/routes/backups.ts` |
| `/api/v1/bot-audit` | Находки ночного судьи диалогов | 6 | да (2 мест) | `apps/api/src/routes/botAudit.ts` |
| `/api/v1/bot-learning` | Уроки, извлечённые из ошибок бота | 8 | да (2 мест) | `apps/api/src/routes/botLearning.ts` |
| `/api/v1/bot-trainer` | Ручная тренировка бота | 3 | да (1 мест) | `apps/api/src/routes/botTrainer.ts` |
| `/api/v1/bot-scenarios` | Сценарии продаж для бота | 1 | да (1 мест) | `apps/api/src/routes/botScenarios.ts` |
| `/api/v1/bot-training` | Экран «Манера» — закрыт тумблером | 6 | да (1 мест) | `apps/api/src/routes/botTraining.ts` |
| `/api/v1/attachments` | Вложения переписки | 1 | да (2 мест) | `apps/api/src/routes/attachments.ts` |
| `/api/v1/media` | Отдача файлов чата по ссылке | 1 | нет | `apps/api/src/routes/mediaProxy.ts` |
| `/api/v1/instagram-comments` | Лента комментариев под публикациями | 4 | да (2 мест) | `apps/api/src/routes/instagramComments.ts` |
| `/api/v1/lead-magnets` | Чек-листы и выдачи лид-магнитов | 10 | да (1 мест) | `apps/api/src/routes/leadMagnets.ts` |
| `/api/v1/vacancies` | Кандидаты на вакансии | 18 | да (4 мест) | `apps/api/src/routes/vacancies.ts` |
| `/api/v1/oversight` | Контроль руководителя | 19 | да (2 мест) | `apps/api/src/routes/oversight.ts` |
| `/api/v1/insights` | Инсайты от ИИ по звонкам | 4 | да (1 мест) | `apps/api/src/routes/insights.ts` |
| `/api/v1/l` | Публичная ссылка на объект для клиента | 2 | да (1 мест) | `apps/api/src/routes/propertyShare.ts` |
| `/api/v1/public/owner-report` | **без подписи** | 1 | нет | `apps/api/src/routes/ownerReportPublic.ts` |

## 3. Что сервер делает сам, по часам

| Имя задачи | Расписание | Что делает |
|---|---|---|
| `absence-return` | `5 * * * *` | Снимает отпуск с агента по наступлении даты выхода |
| `agent-mobile-fallback` | `*/15 * * * *` | Сверяет и восстанавливает переадресацию на мобильный агента |
| `agent-off-crm-alarm` | `0 * * * *` | Ловит признаки увода клиента в обход CRM |
| `agent-unanswered-alarm` | `0 * * * *` | Продавец пишет, а агент молчит день-два |
| `background-jobs` | `* * * * *` | Тик очереди фоновых заданий |
| `bot-audit` | `15 3 * * *` | Ночной судья диалогов: сверяет переписки с правилами и копит нарушения |
| `bot-lessons` | `30 */2 * * *` | Превращает ошибки бота в короткие правила и подмешивает их в его инструкцию |
| `bot-pause-watch` | `20 * * * *` | Бот на паузе и забыли: напоминает, при долгой паузе снимает сам |
| `buyer-no-call-alarm` | `0 * * * *` | Активный покупатель с высокой оценкой без звонка два дня |
| `buyer-thinking-slow-track` | `*/30 * * * *` | Двигает задачи «покупатель думает», заведённые без даты |
| `call-insights` | `10 4 * * *` | Раз в сутки ИИ разбирает разговоры за месяц: где сильно, где просаживается |
| `callback-connect` | `*/10 * * * *` | Соединяет самую старую просьбу «перезвоните» с дежурным оператором |
| `candidate-phone-ask` | `*/15 * * * *` | Просит у кандидатов на вакансию телефон, как откроется окно Meta |
| `client-auto-statuses` | `40 4 * * *` | Пересчитывает статусы клиентов, зависящие от времени |
| `client-follow-ups` | `*/10 * * * *` | Напоминания клиентам, переставшим отвечать в переписке |
| `client-property-count-alarm` | `0 * * * *` | Сравнивает заявленное клиентом число объектов со сделанным в CRM |
| `client-scoring` | `0 2 * * *` | Ночная оценка ИИ всех активных клиентов |
| `clip-review-resend` | `*/5 * * * *` | **без подписи** |
| `clip-review-stale-alarm` | `15 * * * *` | **без подписи** |
| `contact-link-sweep` | `10 3 * * *` | **без подписи** |
| `customer-inbox-jobs` | `*/5 * * * * *` | **без подписи** |
| `customer-intake-jobs` | `*/5 * * * * *` | **без подписи** |
| `customer-outbox-jobs` | `*/5 * * * * *` | **без подписи** |
| `daily-kpi` | `5 0 * * *` | Пересчитывает показатели всех агентов за вчера |
| `daily-stories` | `*/15 * * * *` | **без подписи** |
| `deal-stale-pipeline` | `20 0 * * *` | Застой сделки дольше нормы — пуш руководству и задача агенту |
| `deferred-clients-return` | `*/30 * * * *` | Возвращает в работу клиентов, отложенных до наступившей даты |
| `director-alert-queue-flush` | `*/10 * * * *` | Доставляет руководству накопленные тревоги в разрешённые часы |
| `disk-cleanup` | `5 4 * * *` | **без подписи** |
| `duplicate-fuzzy-scan` | `0 8 * * *` | Ежедневный поиск дублей по похожему имени и номеру |
| `duplicates-weekly-digest` | `20 9 * * 1` | Напоминание руководителю о вероятных дубликатах клиентов |
| `exchange-rate` | `0 1 * * *` | Обновляет курс доллара к сомони с alif.tj |
| `expired-property-drafts-cleanup` | `56 3 * * *` | Удаляет просроченные черновики новых объектов |
| `geo-match-nightly-sweep` | `5 8 * * *` | Ночной подбор объектов ждущим покупателям по району |
| `health-automation` | `*/30 * * * *` | Переспрашивает бота по зависшим диалогам, схлопывает дубли ошибок |
| `heartbeat-watchdog` | `*/15 * * * *` | Сторож: поднимает тревогу о любой задаче, замолчавшей дольше нормы |
| `inactive-traffic-light` | `*/30 * * * *` | Светофор неактивных: напоминает по остывающим, переводит заглохших в потерянные |
| `inactivity-check` | `20 9 * * *` | Предупреждает и штрафует агентов за бездействие по принятым клиентам |
| `incoming-call-lead-sweep` | `*/10 * * * *` | Добирает входящие звонки, по которым не завелась карточка клиента |
| `incoming-calls-silence` | `7 * * * *` | Поднимает тревогу, если входящие звонки перестали доходить или все обрываются сразу |
| `insight-digest` | `0 9 15,28-31 * *` | Раз в две недели — находки ИИ к собранию директоров |
| `instagram-comments` | `* * * * *` | Отвечает, скрывает и эскалирует комментарии под публикациями |
| `instagram-online-followers` | `15 14 * * *` | **без подписи** |
| `instagram-pending-containers` | `*/5 * * * *` | Доводит до публикации в Instagram ролики, которые Meta не успела обработать сразу — проверяет каждые 5 минут и публикует, как только видео готово, вместо того чтобы навсегда потерять уже отснятый материал |
| `instagram-url-backfill` | `47 3 * * *` | Чинит ссылки на публикации Instagram |
| `instagram-webhook-subscriptions` | `25 */3 * * *` | **без подписи** |
| `lead-distribution` | `*/5 * * * *` | Раздаёт накопившиеся лиды, штрафует за сорванный первый звонок |
| `lead-stale-reassignment` | `* * * * *` | Передаёт непринятые лиды дальше по карусели и эскалирует |
| `live-voice-orphan-sweep` | `*/10 * * * *` | **без подписи** |
| `log-cleanup` | `0 3 * * *` | Ночная уборка технических журналов и уведомлений |
| `lost-conversations` | `45 2 * * *` | Разбирает переписки, кончившиеся ничем: на каком шаге теряются люди |
| `lost-inactive-trash-sweep` | `30 0 * * *` | Убирает в корзину потерянных и неактивных старше трёх месяцев |
| `meeting-reminders` | `*/5 * * * *` | Напоминания о встречах и показах, сигналы о непроведённых показах и просроченных задачах |
| `meta-ads-stale-watch` | `10 * * * *` | **без подписи** |
| `meta-ads-sync` | `*/15 * * * *` | Тянет из рекламного кабинета объявления и расходы |
| `monthly-problem-report` | `10 9 1 * *` | Разбор проблемных мест за прошедший месяц |
| `monthly-report` | `0 9 1 * *` | Месячный отчёт руководству |
| `morning-report` | `0 8 * * *` | Утренний дайджест директорам |
| `no-answer-tail` | `*/30 * * * *` | Хвост дозвона: задачи по клиентам, до которых не дозвонились |
| `operator-queue-presence` | `*/5 * * * *` | Сверяет очередь входящих на станции с реальным статусом агентов |
| `outgoing-media-cleanup` | `58 3 * * *` | Удаляет исходящие фото и видео оператора старше недели |
| `phone-lead-watchdog` | `*/15 * * * *` | Клиент оставил номер, а карточки нет: оформляет или отдаёт человеку |
| `photo-posts-tick` | `7 * * * *` | **без подписи** |
| `private-files-cleanup` | `30 3 * * *` | Удаляет старые вложения переписки, чтобы не переполнить диск |
| `property-auto-statuses` | `50 4 * * *` | Чинит расхождение статусов объектов со сделками |
| `property-summaries` | `12 * * * *` | Почасовой блок по объектам: фото и видео, резерв, напоминания |
| `published-channels-audit` | `20 5 * * *` | **без подписи** |
| `refused-high-score-alarm` | `0 * * * *` | Досылает в рабочие часы сигнал об отказе ценного клиента |
| `seller-no-property-alarm` | `0 * * * *` | Съёмка была, а объект так и не принят |
| `seller-property-missing` | `*/30 * * * *` | Продавец без единого объекта дольше нормы уходит в очередь безопасности |
| `seller-work-stalled-alarm` | `20 * * * *` | Агент сам перестал пытаться: два дня тишины — пуш, три — строка владельцу |
| `settings-snapshots-prune` | `40 3 * * *` | Обрезает устаревшие точки возврата настроек |
| `showing-confirmations` | `*/5 * * * *` | Просит клиента подтвердить показ, сигналит агенту о неподтверждённых |
| `silent-client-auto-deactivate` | `25 0 * * *` | Переводит в неактивные тех, кому мы писали последними и кто молчит |
| `site-stats` | `7 * * * *` | **без подписи** |
| `social-digests-tick` | `*/15 * * * *` | **без подписи** |
| `social-reposts-tick` | `12 * * * *` | **без подписи** |
| `social-video-schedule` | `* * * * *` | **без подписи** |
| `stale-property-videos-cleanup` | `50 3 * * *` | Удаляет сырое видео объектов, зависшее после публикации |
| `stale-video-uploads-cleanup` | `55 3 * * *` | Убирает брошенные загрузки видео, за которые платится хранение |
| `station-outage-probe` | `*/5 * * * *` | Зондирует телефонную станцию, записывает окна недоступности |
| `stuck-call-stubs` | `*/5 * * * *` | Находит зависшие пустые заготовки звонков в хронологии |
| `stuck-pending-messages` | `*/5 * * * *` | Достаёт сообщения клиентов, застрявшие из-за перезапуска сервера |
| `supervisor-overdue-digest` | `0 * * * *` | Сводка руководству о просроченных показах, встречах и задачах |
| `telegram-bot-api-volume-cleanup` | `59 3 * * *` | **без подписи** |
| `telegram-group-comments` | `* * * * *` | Отвечает и эскалирует комментарии в группе Telegram-канала |
| `telephony-station-health` | `*/15 * * * *` | Каждые 15 минут проверяет саму телефонную станцию целиком: жива ли связь с ней, загружены ли настройки приёма звонков, есть ли хоть один свободный оператор — и поднимает тревогу, только если поломка подтвердилась дважды подряд |
| `telephony-station-traffic` | `17 * * * *` | **без подписи** |
| `token-and-finance-daily` | `20 1 * * *` | Продление ключей Instagram и рекламы, проверка доступов, расходы на ИИ, зарплаты |
| `tomorrow-digest` | `0 18 * * *` | Вечером шлёт каждому агенту список его задач и встреч на завтра |
| `video-handoff-redelivery` | `*/5 * * * *` | **без подписи** |
| `video-handoff-stale-alarm` | `0 * * * *` | Зависший монтаж видео |
| `video-handoff-unfinished-publish-watchdog` | `*/5 * * * *` | **без подписи** |
| `voicemail-ingest` | `*/2 * * * *` | Забирает сообщения с автоответчика, чтобы ночной звонок не потерялся |
| `webhook-dedupe-cleanup` | `40 3 * * *` | Чистит отметки обработанных входящих сообщений |
| `weekly-lost-digest` | `0 9 * * 1` | Понедельничная сводка «куда уходят клиенты» |
| `weekly-marketing-insights` | `20 9 * * 1` | Недельный разбор маркетинга приходит сам, без открытия отчётов |
| `weekly-problem-report` | `10 9 * * 1` | Недельный разбор проблемных мест агентства |
| `weekly-reactivation-campaign` | `0 10 * * 1` | Ставит рассылку старым клиентам для возврата |
| `weekly-security-review-digest` | `20 9 * * 1` | Недельная сводка безопасности: отказы, похожие на сделку на стороне |
| `whisper-sync` | `*/5 * * * *` | Заранее озвучивает подсказку о звонящем и кладёт её на станцию |
| `working-hours-daily-alerts` | `35 9 * * *` | Утром показывает директору перерасход бюджета и сигналы по рекламе |
| `youtube-comments` | `*/2 * * * *` | Опрашивает YouTube на новые комментарии (вебхука у него нет) |

### Фоновые задания (очередь)

| Тип | Файл |
|---|---|
| `ai-reply-retry` | `apps/api/src/jobs/aiReplyRetry.ts` |
| `ai-turn-blocked-followup` | `apps/api/src/jobs/aiTurnBlockedFollowup.ts` |
| `client-reactivation` | `apps/api/src/jobs/clientReactivation.ts` |
| `clip-compress` | `apps/api/src/jobs/clipCompress.ts` |
| `customer-callback-notify` | `apps/api/src/jobs/customerCallbackNotify.ts` |
| `customer-contact-intake` | `apps/api/src/jobs/customerContactIntake.ts` |
| `customer-inbox-consume` | `apps/api/src/jobs/customerInboxConsume.ts` |
| `customer-intake-notify` | `apps/api/src/jobs/customerIntakeNotify.ts` |
| `customer-intake-policy` | `apps/api/src/jobs/customerIntakePolicy.ts` |
| `customer-outbox-dispatch` | `apps/api/src/jobs/customerOutboxDispatch.ts` |
| `customer-showing-notify` | `apps/api/src/jobs/customerShowingNotify.ts` |
| `customer_owner_question_notify` | `apps/api/src/jobs/customerOwnerQuestionNotify.ts` |
| `deal-close-followup` | `apps/api/src/jobs/dealCloseFollowup.ts` |
| `deal-review-ask` | `apps/api/src/jobs/dealReviewAsk.ts` |
| `deferred-push` | `apps/api/src/jobs/deferredPush.ts` |
| `geo-match-sweep` | `apps/api/src/jobs/geoMatchSweep.ts` |
| `geocode` | `apps/api/src/jobs/geocode.ts` |
| `recording-search-retry` | `apps/api/src/jobs/recordingSearchRetry.ts` |
| `recruitment-recovery` | `apps/api/src/jobs/recruitmentRecovery.ts` |
| `site-resync` | `apps/api/src/jobs/siteResync.ts` |
| `telegram-dm-reply-retry` | `apps/api/src/jobs/telegramDirectReplyRetry.ts` |
| `telegram-reply-retry` | `apps/api/src/jobs/telegramReplyRetry.ts` |
| `transcription-retry` | `apps/api/src/jobs/transcriptionRetry.ts` |

## 4. Внешние сервисы

Определяются по ключам настроек, которые сервер читает из окружения.

| Сервис | Ключей настроек | Где используется (файлов) |
|---|---|---|
| Instagram Graph через прокси | 2 | 1 |
| Telegram | 5 | 7 |
| WhatsApp, Instagram Direct, Messenger (Meta) | 9 | 11 |
| Бюджет Google Cloud | 1 | 1 |
| Голосовой ИИ на звонках (Gemini Live) | 9 | 5 |
| ИИ Google Gemini | 18 | 11 |
| Отчёты о резервных копиях | 1 | 1 |
| Пуш-уведомления | 4 | 2 |
| Реклама Meta (рекламный кабинет) | 3 | 3 |
| Сайт royalhome.tj | 6 | 13 |
| Телефония FreePBX / Asterisk | 3 | 2 |
| Утренний отчёт наружу | 2 | 1 |
| Хранилище Cloudflare R2 | 4 | 1 |

## 5. Без человеческой подписи

Появилось в коде, но не описано в `docs/product-map-labels.json`. Пустые списки —
норма; непустые значат, что функция завелась, а объяснить её никто не удосужился.

- Задач по расписанию: `clip-review-resend`, `clip-review-stale-alarm`, `contact-link-sweep`, `customer-inbox-jobs`, `customer-intake-jobs`, `customer-outbox-jobs`, `daily-stories`, `disk-cleanup`, `instagram-online-followers`, `instagram-webhook-subscriptions`, `live-voice-orphan-sweep`, `meta-ads-stale-watch`, `photo-posts-tick`, `published-channels-audit`, `site-stats`, `social-digests-tick`, `social-reposts-tick`, `social-video-schedule`, `telegram-bot-api-volume-cleanup`, `telephony-station-traffic`, `video-handoff-redelivery`, `video-handoff-unfinished-publish-watchdog`
- Модулей сервера: `/api/v1/live-voice`, `/api/v1/ui-shell`, `/api/v1/sms`, `/api/v1/whatsapp-templates`, `/api/v1/social-videos`, `/api/v1/threads/oauth/callback`, `/api/v1/threads`, `/api/v1/search-console/oauth/callback`, `/api/v1/search-console/yandex/oauth/callback`, `/api/v1/search-console`, `/api/v1/contacts`, `/api/v1/public/owner-report`

