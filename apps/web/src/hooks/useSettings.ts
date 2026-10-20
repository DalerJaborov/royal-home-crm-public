import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CoverProvider } from "@royal-home/shared";
import { api } from "../lib/api";
import { currentSessionEpoch, rollbackInSameSession } from "../lib/sessionGuard";
import { FALLBACK_USD_TO_TJS } from "../lib/format";

/**
 * ВНИМАНИЕ: полный объект приходит только ADMIN/DIRECTOR (см. routes/settings.ts).
 * Рядовому сотруднику сервер отдаёт усечённую версию — брендинг и курс валюты.
 * Поэтому за пределами страницы «Настройки» (она admin-only) читать отсюда можно
 * только эти поля; для курса есть готовый useUsdToTjsRate ниже.
 */
/** Откуда взят действующий ключ Meta: из Настроек CRM, из окружения сервера или ниоткуда. */
export type MetaKeySource = "settings" | "env" | null;

/** Откуда взято действующее имя модели Gemini: выбор владельца, переменная сервера
 *  или заводское значение из кода. */
export type ModelSource = "settings" | "env" | "default";

export interface Settings {
  id: string;
  /** Структура комиссии: доли риелтора/компании, % от цены объекта.
   *  commissionIntakePercent («за приём объекта», отменено 11.09.2026) сервер ещё
   *  возвращает как историческое поле БД, но в Настройках оно больше не
   *  редактируется — не показывайте его как действующую настройку. */
  commissionIntakePercent: string;
  commissionRealtorPercent: string;
  commissionCompanyPercent: string;
  monthlyCommissionPlan: string;
  geminiApiKeyConfigured: boolean;
  geminiApiKeyMasked: string | null;
  geminiApiKeySource: "settings" | "env" | null;
  geminiApiKey2Configured: boolean;
  geminiApiKey2Masked: string | null;
  geminiApiKey2Source: "settings" | "env" | null;
  /** Маски дополнительных ключей Gemini (их может быть сколько угодно). Сырые ключи
   *  наружу не отдаются никогда, а порядок масок совпадает с порядком ключей в базе —
   *  именно на место в этом списке ссылается сохранение (см. AiTab). */
  geminiExtraKeysMasked: string[];
  /**
   * ДЕЙСТВУЮЩИЕ ИМЕНА МОДЕЛЕЙ и то, откуда они взяты.
   *
   * `*Effective` — что бот спрашивает у Google прямо сейчас; `*Source` — чей это
   * выбор: `settings` (владелец вписал), `env` (переменная на сервере) или
   * `default` (заводское значение из кода). Без источника экран не отличил бы выбор
   * владельца от совпавшего с ним дефолта, а это разные вещи: первый переживёт
   * обновление, второй сменится вместе с ним.
   */
  geminiModelEffective: string;
  geminiModelSource: ModelSource;
  geminiFallbackModelsEffective: string[];
  geminiFallbackModelsSource: ModelSource;
  geminiTranscribeModelsEffective: string[];
  geminiTranscribeModelsSource: ModelSource;
  geminiImageModelEffective: string;
  geminiImageModelSource: ModelSource;
  /** Дешёвая ступень для простых задач. Пустая строка — не настроена: простые
   *  задачи идут обычной моделью диалогов. */
  geminiLiteModelEffective: string;
  geminiLiteModelSource: ModelSource;
  companyName: string;
  companySlogan: string;
  companyLogoUrl: string | null;
  /** Обложки для соцсетей (23.09.2026): как выбирается шаблон на публикацию. */
  coverTemplateMode: "FIXED" | "RANDOM";
  coverTemplateId: string | null;
  coverTemplateEnabledIds: string[];
  leadAcceptMinutes: number;
  /** Сколько минут после принятия лида даётся на разговор с клиентом. */
  leadCallMinutes: number;
  // leadEscalationEnabled («режим обучения») УДАЛЕНО ИЗ ТИПА 25.09.2026 —
  // код (сервер и клиент) больше не читает и не пишет это поле.
  /** Забирать лид у агента, который принял его, но не позвонил вовремя —
   *  лид сразу снимается и уходит следующему; по умолчанию выключено. */
  leadReassignOnMissedCallEnabled: boolean;
  /** Щиток занятости (21.08.2026): агент на показе или в живом звонке через CRM
   *  новых лидов не получает, пока не освободится. */
  agentOccupancyShieldEnabled: boolean;
  agentOccupancyShieldAfterMinutes: number;
  // leadPoolAfterMinutes убран из типа настроек (17.09.2026, закон о владении
  // клиентом П-4/Р-3) — пул «ничьих» удалён целиком, GET /settings это поле
  // больше не отдаёт (см. routes/settings.ts::toPublicSettings).
  /** Реактивация старых клиентов пачкой (Пачка 12, 11.09.2026): понедельник
   *  10:00 Душанбе, см. apps/api/src/lib/reactivationCampaign.ts. */
  reactivationEnabled: boolean;
  reactivationAfterDays: number;
  reactivationBatchSize: number;
  reactivationMessageTemplate: string;
  /** «Бот на паузе и забыли» (Пачка 17, 12.09.2026): см. apps/api/src/lib/botPauseWatch.ts. */
  botPauseWatchEnabled: boolean;
  botPauseAlertHours: number;
  botPauseEscalateHours: number;
  /** Сколько секунд разговора считаются состоявшимся звонком; 0 = порога нет. */
  leadCallMinSeconds: number;
  /** Максимум активных лидов у агента одновременно; 0 = без лимита. */
  leadActiveLimit: number;
  /** Максимум объектов у агента одновременно в конвейере подготовки; 0 = без лимита. */
  propertyActiveLimit: number;
  /** Веса шкалы совпадения «клиент ↔ объект» (Путь покупателя, п.5.1) — общая
   *  шкала: и обычный подбор объекта с карточки клиента, и «свой объект» ниже. */
  matchScoreBase: number;
  matchScoreDistrict: number;
  matchScoreRooms: number;
  matchScoreBudget: number;
  matchScoreHotBonus: number;
  /** Расстояние до желаемого места клиента (12.09.2026) — отдельный вес,
   *  matchScoreDistrict не трогает. */
  matchScoreDistance: number;
  /** Единая политика подбора «клиент ↔ объект» (17.09.2026, matchPolicy.ts):
   *  общий рубильник автоподбора — новый объект сам находит ждущих покупателей. */
  autoMatchEnabled: boolean;
  /** Включать в подбор клиентов со статусом «Неактивный». */
  matchIncludeInactive: boolean;
  /** Включать в подбор отложенных (DEFERRED) клиентов. */
  matchIncludeDeferred: boolean;
  /** Хозяину объекта приходит пуш, когда его объект предложили чужому клиенту. */
  matchNotifyPropertyOwner: boolean;
  /** Срок жизни пожелания покупателя от последнего касания, дней; 0 — без срока. */
  matchRequirementTtlDays: number;
  /** На сколько процентов должна упасть цена объекта, чтобы уже уведомлённого
   *  покупателя предупредили повторно. */
  matchPriceDropRenotifyPct: number;
  /** Допуск по бюджету клиента, % сверх названной суммы. */
  matchBudgetTolerancePct: number;
  /** Допуск по площади объекта, % от желаемой. */
  matchAreaTolerancePct: number;
  /** Допустимая разница в числе комнат. */
  matchRoomsTolerance: number;
  /** Радиус вокруг точки на карте по умолчанию для новой точки клиента, метров. */
  matchDefaultRadiusM: number;
  /** Во сколько раз можно расширить радиус, если кандидатов меньше minCandidates. */
  matchRadiusMaxMultiplier: number;
  /** Минимум объектов-кандидатов в радиусе, иначе радиус расширяется. */
  matchMinCandidates: number;
  /** Приоритет «свой объект» (11.08.2026): агент, принявший объект, получает
   *  клиента по нему вне очереди по KPI. Порог — по шкале подбора 0..100. */
  ownPropertyPriorityEnabled: boolean;
  ownPropertyMatchThreshold: number;
  /** Жёсткое исключение без порога: бот уже показал клиенту этот объект. */
  ownPropertyShownExceptionEnabled: boolean;
  ownPropertyShownWindowDays: number;
  /** Лимит активных лидов ограничивает смешанный портфель; свои объекты выходят
   *  за него через освобождение места, а без обычных лидов — просто сверх. */
  ownPropertyOverLimitEnabled: boolean;
  ownPropertyReleaseEnabled: boolean;
  // ownPropertyReleaseMode убран из ответа API 17.09.2026 (закон владения
  // П-4/П-6 — режим "random" отменён, система жертву больше не выбирает сама).
  /** Потолок лидов по своим объектам сверх общего лимита; 0 = без предела. */
  ownPropertyLeadCap: number;
  /** «Взвешенные слоты» лимита: свежий лид занимает целое место, после показа —
   *  половину, «думающий» — четверть. Веса в процентах слота. Выключено по
   *  умолчанию: правило меняет раздачу лидов всей компании. */
  weightedLeadSlotsEnabled: boolean;
  leadSlotWeightFreshPercent: number;
  leadSlotWeightAfterShowingPercent: number;
  leadSlotWeightThinkingPercent: number;
  /** Раздача портфеля уволенного: клиенты — сильным по KPI, объекты — слабым. */
  handoverClientsToHighKpi: boolean;
  handoverPropertiesToLowKpi: boolean;
  /** Кнопки «Принять/Отклонить» прямо в шторке уведомлений и срок жизни маркера. */
  pushLeadActionsEnabled: boolean;
  pushActionTtlMinutes: number;
  /** Что ещё присылать: порог частоты о сообщениях, дубли показов руководству.
   *  pushOnScoreChange/pushScoreThrottleMinutes убраны 28.09.2026 — их никто не читал. */
  pushMessageThrottleMinutes: number;
  pushShowingsToSupervisors: boolean;
  /** Обязательное окно после исчерпания переносов блокирует работу во всей CRM. */
  /** Бот возвращает клиента к последнему незакрытому вопросу. */
  botTopicLockEnabled: boolean;
  botTopicDriftTurns: number;
  // refusalCommentMinLength убран из типа 28.09.2026: API его не принимает с 13.09,
  // экран не читает (литерал в shared/schemas.ts). Колонка в БД осталась.
  /** Порог скоринга для автопередачи клиента сильному агенту; 0 = выключено. */
  hotScoreThreshold: number;
  /** Сроки этапов конвейера подготовки объекта, дни. */
  propertyReviewDays: number;
  propertyPhotoDays: number;
  propertyVideoDays: number;
  propertyEditingDays: number;
  /** Предел передач лида между агентами; дальше — «Потерянный». */
  leadMaxTransfers: number;
  /** Слова-признаки конфликта в обязательном комментарии причины передачи OTHER —
   *  совпадение уводит передачу прямо руководителю, минуя автоподбор агента. */
  transferConflictKeywords: string[];
  // autoRouteRefusedLeads убран из ответа API 17.09.2026 (Р-6) — форма
  // Настроек больше его не видит, кнопочный отказ агента продолжает читать
  // сохранённое значение на сервере.
  /** Автосообщения клиенту с просьбой подтвердить показ. По умолчанию выключена 18.08.2026. */
  askClientsToConfirmShowings: boolean;
  /** Режим «не принимаю лиды»: потолок длительности и пауза до следующего включения. */
  agentPauseMaxHours: number;
  agentPauseCooldownHours: number;
  /** Обязательные окна: отсрочка и её предел, сроки требований, дневное окно. */
  propertySummaryAfterHours: number;
  propertySummaryWindowStart: string;
  propertySummaryWindowEnd: string;
  // waitingCheckAfterMinutes/waitingCheckMaxRepeats и callSummaryAfterMinutes убраны
  // из типа 28.09.2026: ни экран, ни сервер их не читают. Колонки в БД остались.
  /** Резерв объекта на сделке — сколько рабочих дней держим, прежде чем вернуть в продажу. */
  dealReservationBusinessDays: number;
  /** Штраф за бездействие: сроки предупреждения и штрафа, цена штрафа в баллах. */
  inactivityWarnAfterDays: number;
  inactivityPenaltyAfterDays: number;
  inactivityPenaltyPoints: number;
  /** «Застой сделки» (владелец 30.08.2026): продавец без единого объекта в CRM,
   *  или покупатель без единой сделки, дольше стольких дней — сигнал владельцу и
   *  задача агенту (см. lib/dealStalePipeline.ts). */
  dealStaleSellerDays: number;
  dealStaleBuyerDays: number;
  /** Светофор неактивных клиентов (владелец 20-21.08.2026): цвет ставит система,
   *  эти числа настраивают только темп напоминаний и порог перевода в Потерянные
   *  для каждого уровня (см. lib/inactiveTrafficLight.ts). */
  inactiveGreenPingHours: number;
  inactiveGreenMaxAttempts: number;
  inactiveYellowPingHours: number;
  inactiveYellowMaxAttempts: number;
  inactiveRedPingHours: number;
  inactiveRedMaxAttempts: number;
  /** Минимум зафиксированных попыток связаться перед переводом клиента в Неактивные
   *  с причиной «перестал отвечать»/«другое». */
  inactivateMinAttempts: number;
  /** Перевёл клиента в Неактивные — следующий лид агенту не раньше чем через это время. */
  inactivateCooldownHours: number;
  /** Потерянный/Неактивный клиент, написавший сам, ждёт прежнего агента это время. */
  lostReturnAcceptMinutes: number;
  /** Приёмка от продавца принята, объекта в CRM ещё нет — предупреждение / критично. */
  sellerPropertyMissingWarnDays: number;
  sellerPropertyMissingCriticalDays: number;
  /** Медленный трек «покупатель думает»: первое/второе напоминание, дальше — раз в N дней. */
  buyerThinkingFirstPingHours: number;
  buyerThinkingSecondPingHours: number;
  buyerThinkingSlowTrackDays: number;
  /** Сколько минут живёт подтверждение личности в защищённых разделах (потолок 240). */
  stepUpMinutes: number;
  /** Глобальный рубильник входа по отпечатку/лицу — false прячет кнопку у всех
   *  сотрудников; сам вход и привязка новых устройств отдельно проверяются на сервере. */
  passkeyLoginEnabled?: boolean;
  /** Настоящий рубильник модуля Royal Score целиком (владелец 15.09.2026) —
   *  выключен: начисления не пишутся, push не уходит, кабинет и карточка в
   *  профиле агента не показываются. */
  royalScoreEnabled: boolean;
  /** Веса показателей KPI ({response: 20, ...}); null — зашитые значения. */
  kpiWeights: Record<string, number> | null;
  /** «Что бот умеет» — каждая способность выключается отдельно и убирает
   *  соответствующий кусок промта (см. messengers/botCapabilities.ts). */
  botCanSendPhotos: boolean;
  /** Сколько снимков объекта уходит клиенту за один показ (1–10). */
  botPhotosPerOffer: number;
  botCanBookShowings: boolean;
  botCanConfirmShowings: boolean;
  botCanFollowUp: boolean;
  botCanAnswerComments: boolean;
  /** «Соедините с оператором»: очередь звонков и push агентам. */
  botCanRequestCallback: boolean;
  /** Дежурный оператор обратных звонков; null — авто-соединения нет. */
  callbackOperatorAgentId: string | null;
  /** «Уточню у собственника»: выключено — отвечает агент по звонку. */
  botCanAskOwner: boolean;
  /** Анкеты кандидатов на вакансии — собирает и передаёт в раздел «Вакансии». */
  botCanHandleVacancies: boolean;
  /** Публикации вакансии (коды или ссылки Instagram), по одной в строке.
   *  Пусто — действует список по умолчанию из кода (api: lib/vacancyPosts.ts). */
  botVacancyPostCodes: string | null;
  /** Ссылки на объекты в переписке. */
  botCanSendLinks: boolean;
  /** Режим запуска: отвечать строго на спрошенное. */
  botCautiousMode: boolean;
  /** Экономия промта: подробности сценария — только своему намерению. */
  botPromptIntentEconomy: boolean;
  contactLinkSweepEnabled: boolean;
  /** Явный кэш правил бота у Google: гарантированная скидка 90% на стабильную часть. */
  geminiExplicitCachingEnabled: boolean;
  /** Экран «Тренировка» (/bot-training): доступен владельцу только пока включено. */
  botTrainingScreenEnabled: boolean;
  /** Действующий промт чат-бота (кастомный или дефолтный). */
  botSystemPrompt: string;
  /** true — промт переопределён админом (не дефолт из кода). */
  botSystemPromptIsCustom: boolean;
  /** Действующий промт ответов на комментарии Instagram (свой или зашитый). */
  botCommentPrompt: string;
  /** true — промт комментариев переписан владельцем. */
  botCommentPromptIsCustom: boolean;
  /** Какая модель пишет текстовые ответы бота: "claude" или "gemini". */
  /** Глобальный рубильник бота — false выключает ответы на всех каналах сразу. */
  botEnabled: boolean;
  /** Рубильники бота по каналам: false — бот в этом канале молчит, но входящие
   *  по-прежнему приходят в «Сообщения» и сотрудник отвечает вручную. Подключение
   *  канала это не трогает (за него отвечают metaEnabled и ключи). */
  botWhatsappEnabled: boolean;
  botInstagramEnabled: boolean;
  botFacebookEnabled: boolean;
  botTelegramEnabled: boolean;
  botWebsiteChatEnabled: boolean;
  /** Задан ли маркер бота Telegram в окружении сервера. Без него канала нет. */
  telegramConfigured: boolean;
  /** Рубильник прямой интеграции с Meta (WhatsApp, Instagram Direct, Messenger). */
  metaEnabled: boolean;
  /** Готов ли к работе хотя бы один канал Meta. */
  metaConfigured: boolean;
  /** Какие именно каналы готовы — по ним интерфейс показывает, чего не хватает. */
  metaChannelsConfigured: ("WHATSAPP" | "INSTAGRAM" | "FACEBOOK")[];
  /** Есть ли маркер Instagram, которым реально пойдут публикация и проверка
   *  статистики: основной аккаунт списка «Аккаунты Instagram», поле «Маркер
   *  Instagram» или окружение сервера. Предупреждения смотрят сюда, а не на маску
   *  одного запасного поля (28.09.2026). */
  metaIgTokenAvailable: boolean;
  /** Маркер берётся у основного аккаунта списка — поле «Маркер Instagram» запасное. */
  metaIgTokenFromAccount: boolean;
  /** Маски ключей Meta — сами значения наружу не отдаются. */
  metaAppSecretMasked: string | null;
  metaVerifyTokenMasked: string | null;
  metaWaTokenMasked: string | null;
  metaIgTokenMasked: string | null;
  /** Маркер УДАЛЕНИЯ Instagram (20.09.2026) — Facebook Login, graph.facebook.com,
   *  НЕ то же самое, что metaIgTokenMasked выше (переписка, graph.instagram.com
   *  через прокси). Не задан — снятие Reels уходит в ручной список, как раньше. */
  metaIgManageTokenMasked: string | null;
  metaIgAppSecretMasked: string | null;
  metaPageTokenMasked: string | null;
  /** Откуда взято действующее значение: "settings" — из Настроек, "env" — с сервера. */
  metaAppSecretSource: MetaKeySource;
  metaVerifyTokenSource: MetaKeySource;
  metaWaTokenSource: MetaKeySource;
  metaIgTokenSource: MetaKeySource;
  metaIgManageTokenSource: MetaKeySource;
  metaIgAppSecretSource: MetaKeySource;
  metaPageTokenSource: MetaKeySource;
  /** Идентификаторы номера WhatsApp и Страницы Facebook — не секреты, показываются как есть. */
  metaWaPhoneId: string | null;
  metaPageId: string | null;
  /** Id партнёрских Страниц для кросспостинга (28.09.2026, lib/facebookCrosspost.ts). */
  facebookCrosspostPageIds: string[];
  /** Группы Facebook для ручной раздачи объекта (28.09.2026) — строка = «Название |
   *  ссылка», см. api/lib/facebookGroupShare.ts::parseShareGroups. */
  facebookShareGroups: string[];
  /** Рекламный кабинет (расходы по объектам, раздел «Реклама»). Маркер — со своим
   *  правом ads_read, отдельным от маркеров переписки. */
  metaAdsEnabled: boolean;
  metaAdsTokenMasked: string | null;
  metaAdsTokenSource: MetaKeySource;
  metaAdsConfigured: boolean;
  /** Номера кабинетов через запятую — реклама может идти из нескольких. */
  metaAdAccountId: string | null;
  /** Номер приложения Meta — нужен для обмена маркера на 60-дневный. */
  metaAppId: string | null;
  metaAdsSyncedAt: string | null;
  /** Секрет в адресе push-подписки Pub/Sub для бюджетных оповещений Google Cloud.
   *  Значение наружу не отдаётся (аудит №4) — только признак «задан». */
  googleBudgetTokenConfigured: boolean;
  /** Маркер станции для озвученных подсказок — тоже только признак. */
  callWhisperStationTokenConfigured: boolean;
  /** Фид каталога Meta для рекламы (28.09.2026) — тумблер и маска ключа ссылки.
   *  Сам ключ наружу не идёт: показывается один раз ответом POST .../rotate. */
  metaCatalogFeedEnabled: boolean;
  metaCatalogFeedKeyMasked: string | null;
  /** Публикации — кросспостинг ролика, присланного монтажёром
   *  (docs/video-pipeline-handoff-only-04-09-2026.md). */
  autoPublishEnabled: boolean;
  /** Истории Instagram (21.09.2026) — отдельный рубильник, только для
   *  автоматической публикации вслед за Reels. */
  instagramStoriesEnabled: boolean;
  /** Истории Facebook (28.09.2026, Page Stories API) — ПОВЕРХ Instagram, свой
   *  рубильник, проверяется всегда (и ручными кнопками тоже). */
  facebookStoriesEnabled: boolean;
  /** Ежедневная подборка сторис (26.09.2026) — публикует карточки объектов
   *  без привязки к событию, раз в сутки. */
  dailyStoriesEnabled: boolean;
  dailyStoriesCount: number;
  /** Час запуска подборки по Душанбе, 0-23. */
  dailyStoriesHourDushanbe: number;
  /** Фото-посты для объектов без ролика (28.09.2026) — карусель Instagram/
   *  фото-пост Facebook/альбом Telegram из уже загруженных фото. */
  photoPostsEnabled: boolean;
  photoPostAfterHours: number;
  /** Повторные показы объектов (28.09.2026, agent-brief.md reposts-digests) —
   *  новый круг публикации через repostAfterDays дней после последнего показа. */
  repostsEnabled: boolean;
  repostAfterDays: number;
  repostMaxRounds: number;
  /** Еженедельная подборка объектов (28.09.2026, agent-brief.md
   *  reposts-digests) — «5 квартир до X в районе» одним постом. */
  digestsEnabled: boolean;
  digestWeekday: number;
  digestHourDushanbe: number;
  /** Агенту его готовый пост в Telegram (28.09.2026) — общий рубильник; у
   *  самого агента есть личный (Agent.sharePostTelegram в профиле). */
  agentSharePostTelegram: boolean;
  /**
   * РАСПИСАНИЕ ВЫХОДА РОЛИКОВ (23.09.2026) — сетка, по которой принятый от
   * монтажёра ролик встаёт в очередь вместо мгновенной отправки. Считает по ним
   * сервер (lib/publishScheduleRules.ts); здесь только показ и правка.
   */
  publishScheduleEnabled: boolean;
  /** Часы выхода берутся из тепловой карты активности, а не из окон ниже. */
  publishScheduleUseHeatmap: boolean;
  /** Часы выхода по статистике Instagram «подписчики в сети» (с недели сбора). */
  publishScheduleUseInstagramOnline: boolean;
  /** Границы рабочего окна публикаций, минуты от полуночи по Душанбе. */
  publishScheduleWindowStartMin: number;
  publishScheduleWindowEndMin: number;
  /** Минимум между двумя публикациями, минуты. */
  publishScheduleMinGapMin: number;
  /** Постоянные часы публикации — плоский список пар «начало-конец» в минутах.
   *  Работают, когда тепловая карта выключена или в ней мало событий. */
  publishSchedulePriorityWindows: number[];
  /** За сколько дней считать тепловую карту. */
  publishScheduleHeatmapDays: number;
  /** Насколько раньше часа пик выкладывать, чтобы пост успел разойтись. */
  publishScheduleLeadHours: number;
  telegramChannelId: string | null;
  /** Дополнительные чаты Telegram (26.09.2026) — chat_id/@username через
   *  запятую/пробел/перевод строки, поверх основного канала выше. */
  telegramExtraChatIds: string | null;
  telegramDiscussionGroupId: string | null;
  telegramDirectMessagesEnabled: boolean;
  /** YouTube Shorts (31.08.2026) — OAuth2 Google, отдельно от Meta. clientId —
   *  не секрет, показывается как есть; secret/refreshToken — только маска/признак. */
  youtubeClientId: string | null;
  youtubeClientSecretMasked: string | null;
  /** Нет .env-резерва у YouTube/TikTok — но SecretKeyEditor по умолчанию читает
   *  "не settings" как "из .env сервера" (17.09.2026), поэтому источник всё равно
   *  нужен передавать явно, а не полагаться на его отсутствие. */
  youtubeClientSecretSource: MetaKeySource;
  youtubeRefreshTokenMasked: string | null;
  youtubeRefreshTokenSource: MetaKeySource;
  youtubeConfigured: boolean;
  /** TikTok Content Posting API (17.09.2026) — clientKey не секрет, показывается
   *  как есть; secret/refreshToken — только маска. refreshToken пишет только
   *  consent-flow (кнопка «Подключить» в ChannelsTab), форма его не редактирует. */
  tiktokClientKey: string | null;
  tiktokClientSecretMasked: string | null;
  tiktokClientSecretSource: MetaKeySource;
  tiktokRefreshTokenMasked: string | null;
  tiktokConfigured: boolean;
  tiktokOpenId: string | null;
  tiktokCreatorUsername: string | null;
  tiktokCreatorNickname: string | null;
  tiktokCreatorAvatarUrl: string | null;
  tiktokConnectedAt: string | null;
  tiktokPrivacyLevel: "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "FOLLOWER_OF_CREATOR" | "SELF_ONLY" | null;
  tiktokAllowComments: boolean;
  tiktokAllowDuet: boolean;
  tiktokAllowStitch: boolean;
  tiktokBrandMode: "NONE" | "ORGANIC" | "BRANDED";
  /** Threads (Meta), 23.09.2026 — тот же приём: appId не секрет, показывается
   *  как есть; appSecret/accessToken — только маска. accessToken пишет только
   *  consent-flow (кнопка «Подключить» в ChannelsTab), форма его не редактирует. */
  threadsAppId: string | null;
  threadsAppSecretMasked: string | null;
  threadsAppSecretSource: MetaKeySource;
  threadsAccessTokenMasked: string | null;
  threadsConfigured: boolean;
  threadsConnected: boolean;
  threadsUserId: string | null;
  threadsUsername: string | null;
  threadsAvatarUrl: string | null;
  threadsConnectedAt: string | null;
  threadsTokenExpiresAt: string | null;
  /** Ручная передача видео монтажёру через Telegram (01.09.2026, lib/videoHandoff.ts) —
   *  единственный путь подготовки ролика с 04.09.2026. */
  videoHandoffEnabled: boolean;
  /** Проверять фото и видео агента перед монтажом (25.09.2026). false — CRM одобряет сама. */
  rawReviewRequired: boolean;
  /** Готовый ролик проверяет модератор перед публикацией (25.09.2026, lib/clipReview.ts). */
  clipReviewEnabled: boolean;
  /** Адресат пуша «объект ждёт проверки» по умолчанию — не заменяет право properties.moderate. */
  videoModeratorAgentId: string | null;
  /** Единственный монтажёр, получающий сырые ролики в очереди «строго один-в-работе». */
  videoMontajerAgentId: string | null;
  /** Этап 4 (телефония): подключение к Asterisk ARI. URL/логин — как есть, пароль — маска. */
  asteriskAriUrl: string | null;
  asteriskAriUsername: string | null;
  asteriskAriPasswordMasked: string | null;
  asteriskConfigured: boolean;
  /** Куда станция звонит сотруднику перед соединением с клиентом: "mobile" — на
   *  мобильный из карточки (софтфоны ещё не розданы), "extension" — на внутренний. */
  asteriskAgentDialMode: "mobile" | "extension" | "auto";
  /** Управление станцией (AMI): порт и логин — как есть, пароль — маска. Адреса
   *  здесь нет: он берётся из asteriskAriUrl, станция одна. */
  asteriskAmiPort: number;
  asteriskAmiUsername: string | null;
  asteriskAmiPasswordMasked: string | null;
  asteriskAmiConfigured: boolean;
  /** Живой голос (эксперимент, пункт 5 очереди ИИ 23.08.2026): бот отвечает по
   *  телефону через Gemini Live вместо текстовых реплик. Выключено по умолчанию,
   *  живым звонком не проверено — см. apps/api/src/lib/telephony/liveVoiceBridge.ts.
   *  Тестовый номер владелец заводит на станции сам (вне этого репозитория). */
  liveVoiceEnabled: boolean;
  postShowingCallEnabled: boolean;
  liveVoiceTestExtension: string | null;
  /** Полный контроль из интерфейса (13.09.2026) — тот же приём, что у botSystemPrompt:
   *  действующий текст (свой или дефолт) + флаг «изменён». */
  liveVoicePrompt: string;
  liveVoicePromptIsCustom: boolean;
  liveVoiceVoiceName: string | null;
  liveVoiceVoiceNameTajik: string | null;
  /** Адрес собеседования для робота-приглашения (25.09.2026). */
  interviewInviteAddress?: string | null;
  liveVoiceForceRussianOnly: boolean;
  liveVoiceBreathEnabled: boolean;
  liveVoiceOfficeAmbienceEnabled: boolean;
  liveVoiceOfficeAmbienceVolume: number;
  /** Что не так с адресом звука на сервере (LIVE_VOICE_RTP_HOST/PORT); null — всё задано. */
  liveVoiceRtpProblem?: string | null;
  /** Консультант на телефоне (24.09.2026): когда берёт настоящие входящие, сколько
   *  секунд днём звонит оператор до него, кому переводить без агента объекта. */
  liveVoiceInboundMode: "off" | "no_answer" | "always";
  liveVoiceInboundWaitSeconds: number;
  liveVoiceTransferAgentId: string | null;
  /** Кто слышит и говорит за робота на телефоне (02.10.2026): Google Gemini Live
   *  или агент ElevenLabs. Роль, справочник и функции у обоих наши. */
  liveVoiceProvider: "google" | "elevenlabs";
  elevenLabsAgentId: string | null;
  elevenLabsVoiceIdRu: string | null;
  elevenLabsVoiceIdTg: string | null;
  /** Пол русского голоса ElevenLabs; null — женский. Нужен роду в промте робота. */
  elevenLabsVoiceGender: "female" | "male" | null;
  /** Ключ ElevenLabs — только маска и признак, как у ключей Gemini. */
  elevenLabsApiKeyConfigured: boolean;
  elevenLabsApiKeyMasked: string | null;
  elevenLabsApiKeySource: MetaKeySource;
  /** Может ли консультант на входящих работать на самом деле (28.09.2026, только
   *  чтение, считает сервер): `rtpHostConfigured` — на сервере задан адрес звука
   *  (без него станции уходит пустой режим); `stationDialplan` — последний снимок
   *  сводной проверки «есть ли на станции ветка консультанта» (раз в 15 минут),
   *  `null` — проверка ещё не проходила. Необязательное: старый сервер его не шлёт. */
  liveVoiceInbound?: {
    wanted: boolean;
    rtpHostConfigured: boolean;
    stationDialplan: { ok: boolean | null; detail: string | null; checkedAt: string } | null;
  };
  /** Голосовые ответы бота в переписке (13.09.2026) — озвучивает свой текст, только
   *  если клиент сам прислал голосовое в этом же ходе. По умолчанию false (владелец:
   *  «создай, но выключи, сам протестирую»). Тумблер в BOT_ABILITIES (BotTab.tsx). */
  botCanSendVoiceReplies: boolean;
  /* Поля браузерного софтфона (asteriskWebrtc*) и список операторов входящих
   * (incomingOperatorIds) убраны 18.08.2026 вместе с самим механизмом: роль
   * оператора отменена, звонки идут прямо агентам. Сервер их пока отдаёт —
   * лишнее поле в ответе ничего не ломает. */
  /** Контексты диалплана АТС, из которых звонок считается входящим. Пустой массив —
   *  действует встроенный набор (см. api/lib/telephony/incomingCalls.ts). */
  incomingInboundContexts: string[];
  incomingAutoCreateClient: boolean;
  incomingDefaultKind: "OTHER" | "BUYER" | "SELLER";
  incomingAssignOnQualify: boolean;
  /** Номер, куда станция уводит непринятый звонок. Уводит по-прежнему АТС — CRM
   *  лишь кладёт значение в её внутреннюю базу (см. api/lib/telephony/failoverSync.ts). */
  incomingForwardPhone: string | null;
  /** Что станция делает со звонком, которого никто не взял. */
  incomingNoAnswerAction: "none" | "forward" | "voicemail" | "both";
  incomingNoAnswerSeconds: number;
  /** Ночной режим: вне рабочих часов очередь пропускается вовсе. */
  incomingNightAction: "none" | "forward" | "voicemail";
  incomingNightStart: string;
  incomingNightEnd: string;
  /** Куда идёт входящий в первую очередь: "queue" — операторам, как было;
   *  "extension" — прямо на SIP-аппарат (incomingPrimaryExtension), очередь молчит. */
  incomingPrimaryTarget: "queue" | "extension";
  /** Внутренний номер аппарата для режима "extension" (например, 1021). */
  incomingPrimaryExtension: string | null;
  incomingPanelEnabled: boolean;
  /** Уведомление о входящем звонке на телефон оператора: окно оператора живёт
   *  только в открытой вкладке, а это приходит и при закрытой CRM. */
  incomingPushEnabled: boolean;
  /** Часы приёма входящих ("HH:MM" по Душанбе) — влияют только на уведомления,
   *  журнал звонков ведётся круглосуточно. Отдельные от workHoursStart/End. */
  incomingHoursEnabled: boolean;
  incomingHoursStart: string;
  incomingHoursEnd: string;
  /** Звонок известного клиента сначала уходит ЕГО ответственному агенту, и только
   *  если тот не взял — в общую очередь операторов (решение владельца 16.08.2026).
   *  Возврат в очередь исполняет сама АТС, а не CRM. */
  incomingRouteToAssignedAgent: boolean;
  /** Сколько секунд станция звонит агенту, прежде чем вернуть звонок в очередь. */
  incomingRouteRingSeconds: number;
  /** ПОДСКАЗКА АГЕНТУ О ЗВОНЯЩЕМ: станция играет её агенту в ухо перед соединением,
   *  клиент в это время слушает гудки (владелец 20.08.2026, docs/telephony-whisper.md). */
  callWhisperEnabled: boolean;
  callWhisperIncoming: boolean;
  callWhisperOutgoing: boolean;
  /** Состав фразы — блоки из WHISPER_PARTS (имя, вид, объект, бюджет, давность…).
   *  Порядок звучания фиксирован на сервере, здесь только набор. */
  callWhisperIncomingParts: string[];
  callWhisperOutgoingParts: string[];
  /** Язык подсказки по умолчанию; у сотрудника может стоять своё. */
  callWhisperLanguage: string;
  callWhisperVoice: string;
  /** Добавлять зацепку от ИИ по истории клиента — единственный блок, который не
   *  собирается из полей карточки и потому может ошибиться. */
  callWhisperAiHint: boolean;
  /** Заготовка на будущий способ маршрутизации незнакомых звонков (очередь по
   *  KPI, отдельный оператор, голосовое меню) — см. RoutingModeSetting в
   *  ChannelsTab.tsx. Реально на линии сейчас работает только
   *  "assigned_then_forward", остальные значения синхронизируются в базу
   *  станции про запас, диалплана под них ещё нет. "Веерный вызов всем
   *  агентам" исключён из списка 20.08.2026 — владелец передумал: агенты
   *  путают такие звонки со своими клиентами. */
  incomingRoutingMode: "assigned_then_forward" | "kpi_queue" | "dedicated_operator" | "ivr_menu";
  /** Дежурная ротация для "dedicated_operator" — порядок в массиве = порядок
   *  очереди, дежурный на сегодня выбирается по календарному дню (Душанбе). */
  incomingDutyAgentIds: string[];
  /* Поля браузерного звонка (telephonyRingtone*, telephonyRetryViaMobileEnabled)
   * убраны 18.08.2026 вместе с софтфоном: звенеть в браузере и переключать
   * браузерное плечо на мобильный больше нечему. */
  /** Разбор проблемных мест (Отчёты): недельный и месячный — каждый со своим
   *  выключателем. Выключенный отчёт не собирается вовсе. */
  problemReportWeeklyEnabled: boolean;
  problemReportMonthlyEnabled: boolean;
  /** Рабочие часы распределения лидов, "HH:MM" по Душанбе. Бот отвечает 24/7 —
   * это влияет только на то, когда новый лид уходит агенту. */
  workHoursStart: string;
  workHoursEnd: string;
  /** Общие выходные компании (11.10.2026), 0 — воскресенье … 6 — суббота. Пусто — выходных нет. */
  companyDaysOff?: number[];
  /** Ответ бота клиенту вне рабочих часов. */
  /** Пауза перед ответом бота, секунды: сколько тишины ждать, пока клиент дописывает. */
  botReplyDelaySec: number;
  /** Потолок ожидания от первого сообщения пачки, секунды. */
  botReplyMaxWaitSec: number;
  /** Идёт ли сравнение манер продажи. false — все новые диалоги на манере по умолчанию. */
  salesScenarioTestEnabled: boolean;
  /** Бот сам напоминает о себе клиенту, который перестал отвечать (до 3 раз). */
  followUpEnabled: boolean;
  /** Окно инициативных сообщений бота, "HH:MM" по Душанбе. */
  aiAssistantEnabled: boolean;
  /** Google Search grounding для справочных вопросов ассистента CRM (рынок/законы/
   *  налоги/ипотека Таджикистана вне данных CRM). Выключен по умолчанию. */
  groundedSearchEnabled: boolean;
  semanticSearchEnabled: boolean;
  /** Улучшение фото объекта ИИ (пункт 7 очереди, 23.08.2026): кнопка «Улучшить»
   *  в галерее объекта. Выключено по умолчанию — рисующая модель может исказить
   *  помещение вопреки промту, поэтому результат всегда идёт через ручное
   *  одобрение (см. PropertyPhotoManager) и никогда не подменяет фото сам. */
  propertyPhotoEnhanceEnabled: boolean;
  sellerMaxQuestions: number;
  sellerNotSelling: string;
  sellerAdvantages: string;
  /** Действующие шаблоны подписи под Reels (свои или зашитые по умолчанию),
   *  разделены строкой `---`. */
  reelsCaptionTemplates: string;
  /** true — шаблоны переопределены директором (не зашитые по умолчанию). */
  reelsCaptionTemplatesIsCustom: boolean;
  /** Соавторы Instagram Reels по умолчанию (26.09.2026) — до 3 ников через запятую/
   *  пробел/перевод строки; null — без соавторов, как раньше. */
  instagramCollaborators: string | null;
  followUpMaxAttempts: number;
  followUpWindowStart: string;
  followUpWindowEnd: string;
  /** Алгоритм назначения нового лида агенту. */
  leadDistributionStrategy: "fair" | "round_robin" | "random" | "manual" | "kpi";
  /** Порог KPI (0-100) для допуска к распределению в режиме "kpi". */
  kpiMinThreshold: number;
  /** Курс USD→TJS. Используется и при публикации на сайт, и везде, где суммы
   * из разных валют складываются в один итог (см. useUsdToTjsRate ниже). */
  usdToTjsRate: string | null;
  usdToTjsRateUpdatedAt: string | null;
  /** "manual" — задан вручную в Настройках; "alif-auto" — с ночного автообновления. */
  usdToTjsRateSource: "manual" | "alif-auto" | null;
  /** Royal Score: цена каждого события ({deal_closed: 10, ...}); null — таблица
   *  владельца по умолчанию. Ключи — виды событий из scoreJournal.ts. */
  royalScoreEventPoints: Record<string, number> | null;
  /** Скользящее окно, за которое считается счёт, дней (по умолчанию 30). */
  royalScoreWindowDays: number;
  /** Стартовый счёт нового агента (по умолчанию 100). */
  royalScoreStartingScore: number;
}

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: () => api<Settings>("/settings"),
    // Настройки читают сразу несколько компонентов одной страницы (курс валют
    // нужен каждому денежному блоку). Без staleTime второй потребитель монтируется
    // уже после ответа первого, считает данные протухшими и запрашивает их заново —
    // на каждой загрузке уходило по два одинаковых GET /settings. Общий поллинг
    // (refetchInterval в queryClient) это не отменяет: свежесть по-прежнему раз в 25с.
    staleTime: 60_000,
  });
}

/**
 * Действующий курс USD→TJS для любых экранных ИТОГОВ по разным валютам.
 * Настройки читает любой авторизованный сотрудник, так что хук работает и у агента.
 * Пока настройки грузятся (или курс не задан) — запасное значение, оно всё равно
 * неизмеримо ближе к правде, чем сложение долларов с сомони один к одному.
 */
export function useUsdToTjsRate(): number {
  const { data } = useSettings();
  const rate = data?.usdToTjsRate ? Number(data.usdToTjsRate) : null;
  return rate && rate > 0 ? rate : FALLBACK_USD_TO_TJS;
}

/**
 * Курс и доли комиссии из Настроек участвуют в расчёте КАЖДОГО денежного экрана
 * (Финансы, Отчёты, Дашборд, Команда, итоги по сделкам). Инвалидировать только
 * ["settings"] мало: после правки курса цифры на экранах оставались посчитанными
 * по старому значению до следующего тика поллинга.
 */
function invalidateAfterSettingsChange(qc: ReturnType<typeof useQueryClient>, options?: { skipSettings?: boolean }) {
  for (const key of [
    ...(options?.skipSettings ? [] : ["settings"]),
    "finance-summary",
    "report-funnel",
    "report-agents",
    "dashboard-summary",
    "dashboard-charts",
    "deals",
    "team",
    "properties",
  ]) {
    void qc.invalidateQueries({ queryKey: [key] });
  }
}

/**
 * Правка настроек с НЕМЕДЛЕННЫМ откликом интерфейса.
 *
 * До 11.08.2026 тумблер оставался в прежнем положении, пока не вернётся ответ и
 * не отработает перезапрос. На проде это полсекунды и больше, и всё это время
 * экран показывает старое состояние — владелец жал второй раз, тем самым
 * возвращая настройку обратно, и делал вывод, что тумблеры «не работают».
 *
 * Поэтому: сразу правим кэш, ответ сервера кладём поверх (он — истина), а при
 * отказе возвращаем прежнее значение. Перезапрашивать сами настройки после
 * ответа незачем — PATCH отдаёт ровно то же, что и GET.
 */
/**
 * `silent` — для вызывающих со своей заметной обратной связью (найдено аудитом
 * 22.08.2026: SecretKeyEditor уже показывает «Ключ сохранён»/ошибку под полем,
 * общий тост поверх дублировал текст). Не общий рубильник на весь хук — им же
 * сохраняются и обычные тумблеры без своего индикатора, которым тост как раз
 * нужен, поэтому silent включают отдельным вызовом хука на конкретном месте
 * использования, а не меняют поведение всех updateSettings.mutate(...) разом.
 */
export function useUpdateSettings(options?: { silent?: boolean }) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Settings>("/settings", { method: "PATCH", body }),
    meta: options?.silent ? { silent: true } : undefined,
    onMutate: async (body) => {
      // Иначе ответ уже летящего GET /settings приземлится поверх нашей правки.
      await qc.cancelQueries({ queryKey: ["settings"] });
      const previous = qc.getQueryData<Settings>(["settings"]);
      if (previous) {
        // Только поля, которые в настройках действительно есть: секреты приходят
        // сюда под другими именами (metaAppSecret, anthropicApiKey) и наружу
        // никогда не отдаются — подставлять их в кэш нечего.
        const patch = Object.fromEntries(Object.entries(body).filter(([key]) => key in previous));
        qc.setQueryData<Settings>(["settings"], { ...previous, ...patch });
      }
      return { previous, epoch: currentSessionEpoch() };
    },
    onError: (_err, _body, context) => {
      const previous = context?.previous;
      if (previous) rollbackInSameSession(context?.epoch, () => qc.setQueryData(["settings"], previous));
    },
    onSuccess: (fresh, _body, context) => {
      // Ответ прежней сессии в чужой кэш не пишем (WEB-01).
      rollbackInSameSession(context?.epoch, () => qc.setQueryData(["settings"], fresh));
      invalidateAfterSettingsChange(qc, { skipSettings: true });
    },
  });
}

export function useRefreshExchangeRate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ rate: number }>("/settings/exchange-rate/refresh", { method: "POST" }),
    onSuccess: () => invalidateAfterSettingsChange(qc),
  });
}

/** Новый ключ фида каталога Meta (28.09.2026) — старый сразу перестаёт работать.
 *  Полная ссылка приходит ОДИН раз в ответе; дальше сервер отдаёт только маску. */
export function useRotateMetaCatalogFeedKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ key: string; url: string | null }>("/settings/meta-catalog-feed/rotate", { method: "POST" }),
    onSuccess: () => invalidateAfterSettingsChange(qc),
  });
}

/** Этап 4 (телефония): проверка сохранённых кредов ARI без сохранения новых —
 *  форма сперва PATCH-ит поля, потом жмут «Проверить». */
/** Живая проверка, видит ли сохранённый маркер Instagram статистику аккаунта
 *  (POST /settings/instagram-insights-test). Ничего не сохраняет, поэтому тоже
 *  silent: результат показывает сама кнопка. */
export function useTestInstagramInsights() {
  return useMutation({
    mutationFn: () =>
      api<{
        ok: boolean;
        stage?: string;
        username?: string | null;
        /** Название аккаунта из списка выше, если маркер берётся оттуда, а не из поля. */
        source?: string | null;
        hours?: number;
        error?: string | null;
      }>(
        "/settings/instagram-insights-test",
        { method: "POST" }
      ),
    meta: { silent: true },
  });
}

export function useTestAsteriskConnection() {
  return useMutation({
    mutationFn: () =>
      api<{ ok: boolean; version?: string; error?: string }>("/settings/asterisk-test", { method: "POST" }),
    // silent: это ПРОВЕРКА связи, ничего не сохраняет — общий тост «Сохранено» врал
    // самим текстом. Кнопка уже показывает свой результат (test.data/test.isError).
    meta: { silent: true },
  });
}

/** Исходящий тестовый звонок живого голоса на указанный номер — за step-up, звонок
 *  реальный и платный, поэтому mutate только по явному нажатию, без авто-повтора. */
export function useLiveVoiceTestCall() {
  return useMutation({
    mutationFn: (phone: string) =>
      api<{ ok: boolean; channelId?: string; error?: string }>("/settings/live-voice-test-call", {
        method: "POST",
        body: { phone },
      }),
    meta: { silent: true },
  });
}

/** Прослушать голос до звонка (13.09.2026) — та же идея, что у предпросмотра
 *  подсказки агенту (CallWhisperSetting): разовый синтез в браузер, ничего не
 *  сохраняет — тост «Сохранено» тут был бы враньём. */
export function useLiveVoicePreviewVoice() {
  return useMutation({
    mutationFn: (input: { voice: string; language: "ru" | "tg" }) =>
      api<{ text: string; audioBase64: string; sampleRateHz: number }>("/settings/live-voice/preview-voice", {
        method: "POST",
        body: input,
      }),
    meta: { silent: true },
  });
}

/** Проверить ключ и агента ElevenLabs и завести у агента наши функции
 *  (POST /settings/live-voice/elevenlabs-check, 02.10.2026). */
export function useElevenLabsCheck() {
  return useMutation({
    mutationFn: () =>
      api<{ ok: boolean; agentName?: string | null; toolsSynced?: number; error?: string }>(
        "/settings/live-voice/elevenlabs-check",
        { method: "POST" }
      ),
    meta: { silent: true },
  });
}

export interface LiveVoiceSessionSummary {
  id: string;
  channelId: string;
  client: { id: string; fullName: string; shortId: number } | null;
  startedAt: string;
  endedAt: string | null;
  endedReason: string | null;
  /** test — проверочный звонок из Настроек, inbound — позвонили нам, outbound — робот
   *  звонил сам; null — старые сессии. */
  direction?: "test" | "inbound" | "outbound" | null;
  /** Кто вёл звонок: Google или ElevenLabs; null/нет — звонки до переключателя. */
  provider?: "google" | "elevenlabs" | null;
  transcriptPreview: string | null;
  hasRecording: boolean;
  /** Стоимость ИИ за звонок (13.09.2026) — null у тех, кому не положено видеть
   *  деньги (finance.view), или пока Google не прислал usageMetadata сессии. */
  costUsd: number | null;
}

/** Последние 30 звонков живого голоса (13.09.2026) — «своей страницы не было
 *  вовсе», расшифровка терялась в общем журнале ошибок. Опрос раз в минуту —
 *  экран Настроек обычно открыт недолго, а звонки идут не поминутно. */
export function useLiveVoiceSessions(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["live-voice-sessions"],
    queryFn: () => api<{ sessions: LiveVoiceSessionSummary[] }>("/settings/live-voice/sessions"),
    refetchInterval: 60_000,
    enabled: options.enabled ?? true,
  });
}

/** Прослушать запись одного звонка — presigned-ссылка запрашивается заново на
 *  каждый клик (не кэшируется: живёт 10 минут на стороне R2, см. r2Client.ts). */
export function useLiveVoiceRecordingUrl() {
  return useMutation({
    mutationFn: (sessionId: string) => api<{ url: string }>(`/settings/live-voice/sessions/${sessionId}/recording`),
    meta: { silent: true },
  });
}

/**
 * Проверка управления станцией (AMI) — и одновременно применение правила «если
 * оператор не ответил»: человек нажимает эту кнопку ровно затем, чтобы убедиться,
 * что настроенное работает, а не только что порт открыт.
 */
export function useTestAsteriskAmi() {
  return useMutation({
    mutationFn: () =>
      api<{ ok: boolean; error?: string; applied?: { action: string; seconds: number; phone: string } }>(
        "/settings/asterisk-ami-test",
        { method: "POST" }
      ),
    // silent: это ПРОВЕРКА связи, ничего не сохраняет — общий тост «Сохранено» врал
    // самим текстом. Кнопка уже показывает свой результат (test.data/test.isError).
    meta: { silent: true },
  });
}

export function useUploadLogo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("logo", file);
      return api<Settings>("/settings/logo", { method: "POST", body: form, isForm: true });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });
}

export type TelephonyAudioStatus = Record<
  "moh" | "greeting" | "queue" | "agentDeclined",
  /** `stale` — файл лежит в старом формате (mp3), станция его не заберёт: она
   *  ходит только за `.wav`. Требуется перезалить, см. routes/settings.ts. */
  { format: string; uploadedAt: string; stale: boolean } | null
>;

/**
 * Что из звуков телефонии сейчас лежит на диске CRM — не только «загрузка прошла»,
 * а «вот что там сейчас и когда положено». До 15.08.2026 конечная точка была на
 * сервере, но экран её не читал: после перезагрузки страницы владелец не мог
 * узнать, лежит ли его файл вообще, — только по факту «музыка всё ещё старая».
 */
export function useTelephonyAudioStatus() {
  return useQuery<TelephonyAudioStatus>({
    queryKey: ["telephony-audio"],
    queryFn: () => api<TelephonyAudioStatus>("/settings/telephony-audio"),
  });
}

/** Трафик платного канала станции за месяц (apps/api/src/lib/telephony/stationTraffic.ts). */
export interface StationTraffic {
  month: string;
  usedMb: number;
  rxMb: number;
  txMb: number;
  limitMb: number;
  pct: number;
  measuredAt: string;
}

/**
 * Сколько станция уже «съела» из месячного лимита платного канала (08.10.2026).
 * `null` — станция не подключена или не ответила: экран честно пишет «нет данных».
 * Сервер кэширует ответ на 10 минут, поэтому и тут нет смысла опрашивать чаще.
 */
export function useStationTraffic() {
  return useQuery<{ stationTraffic: StationTraffic | null }>({
    queryKey: ["telephony-traffic"],
    queryFn: () => api<{ stationTraffic: StationTraffic | null }>("/settings/telephony-traffic"),
    staleTime: 10 * 60_000,
  });
}

/**
 * ТОЧКИ ВОЗВРАТА НАСТРОЕК.
 *
 * Кнопки «сбросить всё на умолчания» здесь нет намеренно: умолчания этой строки
 * ПУСТЫ — без маркеров Instagram, ключей Gemini, паролей АТС и промта бота, — и
 * такой сброс был бы аварией крупнее той, ради которой его жмут. Вместо него
 * история состояний: снимок снимается перед каждым сохранением, вернуться можно
 * к любому, и сам возврат тоже снимает точку (см. routes/settingsRestorePoints.ts).
 */
export interface SettingsFieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface SettingsRestorePoint {
  id: string;
  createdAt: string;
  agentId: string | null;
  agentName: string;
  /** "update" — обычное сохранение, "restore" — состояние перед откатом. */
  reason: string;
  changedFields: string[];
  /** false — снимок зашифрован другим ключом, секреты откат не тронет. */
  secretsRestorable: boolean;
  /** Чем точка отличается от ДЕЙСТВУЮЩИХ настроек. Секреты — без значений. */
  changes: SettingsFieldChange[];
}

export interface SettingsRestorePointsResponse {
  retention: { keepCount: number; keepDays: number };
  items: SettingsRestorePoint[];
}

export function useSettingsRestorePoints() {
  return useQuery<SettingsRestorePointsResponse>({
    queryKey: ["settings-restore-points"],
    queryFn: () => api<SettingsRestorePointsResponse>("/settings/restore-points"),
  });
}

export interface SettingsRestoreResult {
  ok: boolean;
  restoredFields: string[];
  /** Секреты, которые остались действующими: снимок зашифрован другим ключом. */
  skippedSecrets: string[];
  /** Поля «монтажёр/дежурный», не возвращённые: тот сотрудник уволен или заморожен. */
  skippedStaff?: string[];
  backupPointId: string | null;
}

export function useRestoreSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<SettingsRestoreResult>(`/settings/restore-points/${id}/restore`, { method: "POST" }),
    // Откат меняет сразу всё — от курса до правил распределения лидов, поэтому
    // тот же круг перезапросов, что и у обычного сохранения, плюс сам список
    // точек: возврат добавляет в него новую (состояние перед откатом).
    onSuccess: () => {
      invalidateAfterSettingsChange(qc);
      void qc.invalidateQueries({ queryKey: ["settings-restore-points"] });
    },
  });
}


/**
 * ШАБЛОНЫ ОБЛОЖЕК ДЛЯ СОЦСЕТЕЙ (владелец, 23.09.2026).
 * Список отдаёт сервер вместе с режимом выбора — встроенный «Royal Gold» плюс
 * загруженные владельцем пары «SVG + spec.json».
 */
export interface CoverTemplateListItem {
  id: string;
  name: string;
  builtin: boolean;
  formats: ("square" | "story")[];
  previewUrl: string;
  enabled: boolean;
  createdAt?: string;
}

export interface CoverTemplateList {
  mode: "FIXED" | "RANDOM";
  selectedId: string;
  templates: CoverTemplateListItem[];
}

export function useCoverTemplates() {
  return useQuery({
    queryKey: ["settings", "cover-templates"],
    queryFn: () => api<CoverTemplateList>("/settings/cover-templates"),
    staleTime: 60_000,
  });
}

export function useUploadCoverTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; svg: File; spec: File; leaves?: File | null; logo?: File | null }) => {
      const form = new FormData();
      form.append("name", input.name);
      form.append("svg", input.svg);
      form.append("spec", input.spec);
      if (input.leaves) form.append("leaves", input.leaves);
      if (input.logo) form.append("logo", input.logo);
      return api<CoverTemplateListItem>("/settings/cover-templates", { method: "POST", body: form, isForm: true });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings", "cover-templates"] });
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}

export function useDeleteCoverTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/settings/cover-templates/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings", "cover-templates"] });
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}

/** Модели картинок OpenAI для обложек (как OPENAI_IMAGE_MODELS на сервере). */
export const OPENAI_IMAGE_MODEL_OPTIONS = [
  { id: "gpt-image-2.5-sunburst", label: "ChatGPT Images 2.5 Sunburst — точнее правки" },
  { id: "gpt-image-2.5-flare", label: "ChatGPT Images 2.5 Flare — быстрее" },
  { id: "gpt-image-2", label: "gpt-image-2" },
  { id: "gpt-image-1", label: "gpt-image-1 (старая)" },
] as const;
export type OpenAiImageModel = (typeof OPENAI_IMAGE_MODEL_OPTIONS)[number]["id"];

/** Обложки ChatGPT (25.09.2026) — GET/PUT /settings/cover-templates/openai. */
export interface OpenAiCoverSettings {
  keyConfigured: boolean;
  keyMasked: string | null;
  keySource: "settings" | "env" | null;
  enabled: boolean;
  /** Кто рисует: TEMPLATE — наш шаблон, OPENAI — ChatGPT (28.09.2026). */
  provider: CoverProvider;
  /** Свой эталон ChatGPT (29.09.2026); null — встроенный «Royal Green». */
  referenceSquareUrl: string | null;
  referenceStoryUrl: string | null;
  /** Фото под наш шаблон перерисовывает ChatGPT «как для журнала» (29.09.2026). */
  photoRedraw: boolean;
  quality: "low" | "medium" | "high";
  dailyLimit: number;
  /** Кандидаток на картинку: из двух вторая модель выбирает лучшую. */
  candidates: 1 | 2;
  /** OVERLAY — модель рисует пустые панели, текст наш; MODEL — текст пишет модель. */
  textMode: "OVERLAY" | "MODEL";
  /** ORIGINAL — настоящее фото без перерисовки; MODEL — фото перерисовывает ChatGPT. */
  photoSource: "ORIGINAL" | "MODEL";
  imageModel: OpenAiImageModel;
  /** Ширина логотипа из Настроек, px; null — логотипа нет. */
  logoWidth: number | null;
  logoMinWidth: number;
  usedToday: number;
  recent: { id: string; kind: "image" | "check"; model: string | null; ok: boolean; ms: number; costUsd: number | null; createdAt: string }[];
}

export interface OpenAiCoverTest {
  propertyId: string;
  squareDataUrl: string;
  storyDataUrl: string;
  seconds: number;
  /** null — у сотрудника нет finance.view (сервер не отдаёт деньги). */
  costUsd: number | null;
}

const OPENAI_COVERS_KEY = ["settings", "cover-openai"] as const;

export function useOpenAiCovers() {
  return useQuery({
    queryKey: OPENAI_COVERS_KEY,
    queryFn: () => api<OpenAiCoverSettings>("/settings/cover-templates/openai"),
    staleTime: 30_000,
  });
}

export function useUpdateOpenAiCovers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<{ apiKey: string; enabled: boolean; provider: CoverProvider; photoRedraw: boolean; quality: OpenAiCoverSettings["quality"]; dailyLimit: number; candidates: 1 | 2; textMode: "OVERLAY" | "MODEL"; photoSource: "ORIGINAL" | "MODEL"; imageModel: OpenAiImageModel }>) =>
      api<{ ok: true }>("/settings/cover-templates/openai", { method: "PUT", body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: OPENAI_COVERS_KEY }),
  });
}

/** Свой эталон обложки для ChatGPT: загрузить (file) или вернуть встроенный (null). */
export function useCoverReference() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ format, file }: { format: "square" | "story"; file: File | null }) => {
      if (!file) return api<{ ok: true }>(`/settings/cover-templates/openai-reference/${format}`, { method: "DELETE" });
      const form = new FormData();
      form.append("image", file);
      return api<{ ok: true }>(`/settings/cover-templates/openai-reference/${format}`, { method: "POST", body: form, isForm: true });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: OPENAI_COVERS_KEY }),
  });
}

export function useTestOpenAiCover() {
  const qc = useQueryClient();
  return useMutation({
    // Генерация high идёт до двух минут, с повтором по цифрам — до четырёх.
    mutationFn: (propertyId?: string) =>
      api<OpenAiCoverTest>("/settings/cover-templates/openai-test", {
        method: "POST",
        body: propertyId ? { propertyId } : {},
        timeoutMs: 300_000,
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: OPENAI_COVERS_KEY }),
  });
}
