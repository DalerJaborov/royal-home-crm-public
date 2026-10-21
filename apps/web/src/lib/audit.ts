/**
 * Подписи и разбор записей журнала действий (audit log).
 *
 * Жили внутри pages/Archive.tsx; вынесены при появлении мобильного «Архива»
 * (17.08.2026): телефонный экран читает те же записи, а импорт из страницы в
 * мобильный компонент дал бы цикл (страница сама импортирует мобильную ветку).
 */

/**
 * ПОДПИСЬ ЕСТЬ У КАЖДОГО ДЕЙСТВИЯ (22.09.2026). До этого дня подписи были у 21
 * действия из 104, а остальные 83 «Архив» показывал служебным кодом в нижнем
 * регистре — «property_tiktok_published», «reactivation_auto_accept_call».
 * Читать журнал в таком виде нельзя, а заметить это по коду невозможно:
 * подстановка молча падает на `?? entry.action`, ничего не ломая.
 * Полноту сторожит `npm run audit:audit-labels` (scripts/audit-log-labels.mjs,
 * в прогоне перед пушем и в CI): новое действие без подписи заворачивается.
 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  INSTAGRAM_SIGNER_OWNER_CONFIGURED: "Instagram: администратор настроил подписанта входящих сообщений",
  SETTINGS_MAINTENANCE_ACCESS: "Доступ к настройкам в период обслуживания",
  CONVERSATION_CLIENT_LINK: "Переписка связана с клиентом",
  // Общие (совершаются над разными сущностями).
  CREATE: "Создание",
  UPDATE: "Изменение",
  DELETE: "Удаление",
  RESTORE: "Восстановление",
  TRASH: "Удаление (в корзину)",
  PERMANENT_DELETE: "Удаление навсегда",
  PUBLISH: "Публикация",
  UNPUBLISH: "Снятие с публикации",
  SYNC: "Синхронизация",
  CONNECT_START: "Подключение кабинета",
  DISCONNECT: "Отключение кабинета",

  // Сотрудники и доступ.
  AGENT_CREATE: "Создание",
  AGENT_UPDATE: "Изменение сотрудника",
  AGENT_FREEZE: "Сотрудник заморожен",
  AGENT_UNFREEZE: "Сотрудник разморожен",
  AGENT_HANDOVER: "Передача дел сотрудника",
  AGENT_DEACTIVATE_RELEASE: "Отключение сотрудника: лиды сняты",
  AGENT_PERMISSIONS_UPDATE: "Права сотрудника изменены",
  AGENT_PERMISSIONS_RESET_ON_ROLE_CHANGE: "Личные права сброшены при смене роли",
  AGENT_LEAD_PAUSE: "Приостановка приёма лидов",
  AGENT_LEAD_RESUME: "Возврат в приём лидов",
  AGENT_LEAD_PAUSE_BY_SUPERVISOR: "Пауза лидов сотруднику от руководителя",
  AGENT_LEAD_RESUME_BY_SUPERVISOR: "Руководитель вернул сотрудника в приём лидов",
  AGENT_FROZEN_REMOVED_FROM_SETTINGS: "Замороженный сотрудник снят с ролей в настройках",
  AGENT_DEACTIVATED_REMOVED_FROM_SETTINGS: "Отключённый сотрудник снят с ролей в настройках",
  OPERATOR_QUEUE_PAUSE: "Пауза в очереди оператора",
  PASSKEY_ADD: "Привязал вход по отпечатку",
  PASSKEY_REMOVE: "Отвязал вход по отпечатку",
  PASSWORD_CHANGED_SESSIONS_REVOKED: "Смена пароля, сеансы завершены",
  TOTP_DISABLE: "Код подтверждения отключён",
  TOTP_ENABLE: "Код подтверждения включён",
  PASSWORD_CHANGED: "Смена пароля",
  PHONE_CHANGED: "Смена номера для входа",
  SESSION_REVOKED: "Устройство отключено от учётки",
  TELEGRAM_UNLINKED: "Telegram отвязан",
  TOTP_RESET_BY_DIRECTOR: "Код подтверждения сброшен директором",
  SITE_ADMIN_PASSWORD_RESET: "Сброс пароля администратора сайта",

  // Клиенты.
  CLIENT_CREATE: "Создание",
  CLIENT_DELETE: "Удаление",
  CLIENT_ACTIVATE: "Клиент возвращён в активные",
  CLIENT_DEFER: "Клиент отложен",
  CLIENT_DEFERRED_RETURN: "Отложенный клиент вернулся",
  CLIENT_REFUSE: "Отказ клиента",
  CLIENT_REFUSAL_SUSPECTED: "Похоже на отказ клиента",
  CLIENT_TO_CANDIDATE: "Клиент переведён в кандидаты",
  CLIENT_AGENT_CHANGE: "Смена агента клиента",
  CLIENT_TRANSFER: "Передача клиента",
  CLIENT_MERGE: "Слияние дублей клиента",
  CLIENT_AI_UPDATED: "Карточка дополнена помощником",
  CLIENT_SECURITY_REVIEW: "Разбор подозрения по клиенту",
  DUPLICATE_REVIEW_CONFIRM: "Дубль подтверждён",
  DUPLICATE_REVIEW_DENY: "Дубль отклонён",
  EXPORT_CONVERSATION: "Выгрузка переписки",
  PROPERTY_COUNT_DISPUTE: "Спор о числе объектов клиента",
  PROPERTY_COUNT_DISPUTE_APPROVE: "Спор о числе объектов принят",
  PROPERTY_COUNT_DISPUTE_REJECT: "Спор о числе объектов отклонён",

  // Лиды и реактивация.
  LEAD_ACCEPT: "Лид принят",
  LEAD_ASSIGN: "Лид назначен",
  LEAD_DECLINE: "Лид отклонён",
  REACTIVATION_ACCEPT: "Предложение реактивации принято",
  REACTIVATION_DECLINE: "Предложение реактивации отклонено",
  REACTIVATION_AUTO_ACCEPT_CALL: "Реактивация принята звонком",
  REACTIVATION_RELEASE: "Предложение реактивации снято",
  CALLBACK_DONE: "Обратный звонок выполнен",
  CUSTOMER_REQUEST_TRANSITION: "Изменение обработки запроса клиента",
  CALLER_BLACKLIST: "Номер в чёрном списке",
  OWNER_QUESTION_ANSWER: "Ответ на вопрос собственника",

  // Объекты.
  PROPERTY_CREATED: "Создание",
  PROPERTY_HANDOVER: "Передача объекта другому агенту",
  PROPERTY_TRANSFER: "Ручная передача объекта",
  PROPERTY_HANDOVER_ACCEPT: "Объект принят новым агентом",
  PROPERTY_HANDOVER_ACCEPTED: "Объект принят новым агентом",
  PROPERTY_HANDOVER_REVERT: "Объект возвращён прежнему агенту",
  AGENT_HANDOVER_REVERT: "Возврат переданных дел",
  PROPERTY_STATUS_CHANGED: "Смена статуса объекта",
  PROPERTY_INTAKE_CHANGED: "Изменение условий приёма объекта",
  PROPERTY_SELLER_RELINKED: "Объект привязан к продавцу с новым номером",
  PROPERTY_ASSIGNED_AGENT_CHANGED: "Смена агента объекта",
  PROPERTY_FIELDS_CHANGED: "Правка объекта",
  PROPERTY_EDIT_FINISHED: "Правка завершена, подписи обновлены",
  PROPERTY_CHANGE_REQUEST: "Заявка на изменение опубликованного объекта",
  PROPERTY_CHANGE_REQUEST_DECIDED: "Заявка на изменение объекта: решение",
  PROPERTY_CHANGE_REQUEST_CANCELLED: "Заявка на изменение объекта отозвана",
  PROPERTY_VIDEO_CLEANUP: "Исходные видео объекта удалены ночной уборкой",
  PROPERTY_DRAFT_MEDIA_LOST: "Файлы из мастера не дошли до карточки",
  PROPERTY_PHOTOS_ADDED: "Фото добавлены",
  PROPERTY_PHOTO_DELETED: "Фото удалено",
  PROPERTY_PHOTOS_REORDERED: "Порядок фото изменён",
  PROPERTY_VIDEOS_ADDED: "Видео добавлено",
  PROPERTY_VIDEO_DELETED: "Видео удалено",
  PROPERTIES_EXPORT: "Выгрузка объектов",
  DELETE_REQUEST: "Заявка на удаление",
  DELETE_REQUEST_REJECT: "Заявка на удаление отклонена",
  PROPERTY_PHOTOS_APPROVED: "Фото одобрены",
  PROPERTY_PHOTOS_REJECTED: "Фото возвращены на доработку",
  PROPERTY_VIDEO_APPROVED: "Видео одобрено",
  PROPERTY_VIDEO_REJECTED: "Видео возвращено на доработку",
  PROPERTY_PHOTO_ENHANCE_REQUESTED: "Улучшение фото запрошено",
  PROPERTY_PHOTO_ENHANCE_APPROVED: "Улучшение фото принято",
  PROPERTY_PHOTO_ENHANCE_REJECTED: "Улучшение фото отклонено",

  // Монтаж и публикации.
  PROPERTY_EDITING_DONE: "Монтаж завершён",
  MONTAGE_COPIES_TOGGLE: "Копии монтажа в Telegram включены или выключены",
  PROPERTY_PUBLISHED_NOW: "Опубликовано сейчас, не дожидаясь слота",
  PROPERTY_PUBLISH_RESCHEDULED: "Время выхода ролика перенесено вручную",
  PROPERTY_VIDEO_HANDOFF_CANCELLED: "Передача на монтаж отменена",
  PROPERTY_VIDEO_HANDOFF_MOVED: "Объект передвинут в очереди монтажа",
  PROPERTY_VIDEO_HANDOFF_HELD: "Объект отложен в очереди монтажа",
  PROPERTY_VIDEO_HANDOFF_RELEASED: "Объект возвращён в очередь монтажа",
  PROPERTY_VIDEO_HANDOFF_RESENT: "Исходники отправлены монтажёру повторно",
  VIDEO_HANDOFF_QUEUE_PAUSED: "Очередь монтажёра на паузе",
  VIDEO_HANDOFF_QUEUE_RESUMED: "Очередь монтажёра возобновлена",
  PROPERTY_VIDEO_HANDOFF_REQUEUED: "Снова отправлен на монтаж",
  PROPERTY_SENT_BACK_TO_MONTAJER: "Ролик отправлен монтажёру заново",
  PROPERTY_CLIP_APPROVED: "Готовый ролик одобрен",
  PROPERTY_CLIP_REJECTED: "Готовый ролик возвращён монтажёру",
  CLIP_REVIEW_TELEGRAM_TOGGLE: "Ролики на проверку в Telegram: вкл/выкл",
  PROPERTY_FINAL_VIDEO_MANUAL: "Готовый ролик загружен вручную",
  PROPERTY_CAPTIONS_REFRESHED: "Подписи пересобраны",
  PROPERTY_TIKTOK_PUBLISHED: "Публикация в TikTok",
  SOCIAL_VIDEO_CREATED: "Загружен свободный ролик",
  SOCIAL_VIDEO_PUBLISH: "Запущена публикация свободного ролика",
  SOCIAL_VIDEO_RETRY: "Повтор публикации свободного ролика",
  SOCIAL_VIDEO_COVER_UPLOADED: "Загружена обложка свободного ролика",
  SOCIAL_VIDEO_COVER_AI: "ИИ нарисовал обложку свободного ролика",
  SOCIAL_VIDEO_DELETED: "Удалён свободный ролик",
  SOCIAL_VIDEO_ADD_DESTINATIONS: "Добавлены сети или аккаунты к вышедшему ролику",
  SOCIAL_VIDEO_REMOVE: "Ролик снят из соцсетей",
  SOCIAL_VIDEO_MARK_REMOVED: "Ролик отмечен убранным вручную",
  SOCIAL_VIDEO_COPIED: "Свободный ролик скопирован черновиком",
  PROPERTY_INSTAGRAM_STORIES_PUBLISHED: "Публикация в истории Instagram",
  PROPERTY_INSTAGRAM_STORY_CARD_PUBLISHED: "Карточка объекта в истории Instagram",
  PROPERTY_INSTAGRAM_STORY_SOLD_PUBLISHED: "Печать «Продано» в истории Instagram",
  PROPERTY_SOCIAL_UNPUBLISHED: "Пост снят из соцсетей",
  PROPERTY_SOCIAL_REMOVED_BY_HAND: "Пост удалён в приложении — отмечено вручную",
  PROPERTY_FINAL_VIDEO_DISCARDED: "Готовый ролик удалён с карточки как принятый по ошибке",
  PROPERTY_PHOTO_POST_PUBLISHED: "Фото-пост опубликован вручную",
  PROPERTY_SOCIAL_EXTRAS_REMOVED: "Карусели и истории сняты вручную",
  PROPERTY_REPOST_PUBLISHED: "Объект показан в соцсетях ещё раз",
  PROPERTY_GROUP_SHARE_DONE: "Объект разослан в группу — отмечено",
  PROPERTY_GROUP_SHARE_UNDONE: "Отметка о рассылке в группу снята",
  SOCIAL_DIGEST_RUN: "Подборка объектов запущена вручную",
  IG_COMMENT_REPLY: "Ответ на комментарий Instagram",
  IG_COMMENT_HIDE: "Комментарий Instagram скрыт",
  IG_COMMENT_UNHIDE: "Комментарий Instagram возвращён",

  // Сделки и деньги.
  DEAL_CREATE: "Создание сделки",
  DEAL_CANCEL: "Отмена сделки",
  DEAL_COMPLETE: "Сделка завершена",
  DEAL_REJECT: "Сделка отклонена",
  DEAL_STAGE_CHANGE: "Смена этапа сделки",
  DEAL_PAYOUT: "Выплата по сделке",
  DEAL_ANNUL: "Сделка аннулирована",
  DEAL_COMMISSION_CHANGE: "Изменение комиссии",
  DEAL_SOLD_PRICE_CHANGE: "Изменение цены продажи",
  DEAL_REPRICE_CLOSED: "Пересчёт закрытой сделки",
  DEAL_SKIP_DOCUMENTS: "Сделка без документов",
  DEAL_DOCUMENT_UPLOAD: "Документ сделки загружен",
  DEAL_DOCUMENT_DELETE: "Документ сделки удалён",
  EXPENSE_CREATE: "Создание расхода",
  FINANCE_EXPORT: "Выгрузка финансов",
  ROYAL_SCORE_EVENT_OVERRIDE: "Правка события рейтинга",

  // Бот и обучение.
  BOT_LESSON_UPDATE: "Правка урока бота",
  BOT_LESSON_UPDATE_GROUP: "Правка группы уроков бота",
  BOT_LESSON_DELETE: "Урок бота удалён",
  BOT_LESSON_BUMP: "Урок бота поднят",
  BOT_AUDIT_RESOLVE: "Находка по боту разобрана",
  BOT_AUDIT_RESOLVE_GROUP: "Группа находок по боту разобрана",
  LOST_REVIEW_RESOLVE: "Потерянный разговор разобран",
  BOT_REPLY_FEEDBACK_GOOD: "Ответ бота отмечен удачным",
  BOT_REPLY_FEEDBACK_BAD: "Ответ бота отмечен неудачным",
  STYLE_EXAMPLE_UPDATE: "Правка примера стиля",
  STYLE_EXAMPLE_DELETE: "Пример стиля удалён",

  // Настройки и служебное.
  SETTINGS_UPDATE: "Изменение настроек",
  LIVE_VOICE_TEST_CALL: "Проверочный звонок роботом",
  LIVE_VOICE_CALL_CLIENT: "Звонок роботом клиенту",
  LIVE_VOICE_RECORDING_LISTEN: "Прослушана запись разговора робота",
  LIVE_VOICE_LISTEN: "Слушал живой разговор робота",
  COVER_TEMPLATE_CREATE: "Добавлен шаблон обложки",
  COVER_TEMPLATE_DELETE: "Удалён шаблон обложки",
  COVER_OPENAI_SETTINGS: "Изменены настройки обложек ChatGPT",
  PROPERTY_COVER_REGENERATED: "Обложка объекта перерисована ChatGPT",
  SETTINGS_RESTORE: "Откат настроек",
  PULT_MODULE_TOGGLE: "Модуль пульта включён или выключен",
  // Пишется при любой правке анкеты кандидата (стадия, дата собеседования,
  // заметка), а не «вакансии»: вакансия у нас одна, меняется кандидат.
  VACANCY_STATUS: "Кандидат: смена этапа",
  VACANCY_UPDATE: "Кандидат: правка анкеты",
  RECRUITMENT_CONTACT_QUEUED: "Кандидат: подготовлена связь по SMS или звонком ассистента",

  // Итоги звонков робота (02.10.2026). Сервер пишет их кодом в НИЖНЕМ регистре,
  // и сторож scripts/audit-log-labels.mjs до этого дня такие коды не видел —
  // «Архив» показывал «interview_invite_call_outcome» как есть.
  interview_invite_call_outcome: "Робот позвонил кандидату: итог приглашения",
  post_showing_call_outcome: "Робот позвонил после показа: итог",
  seller_probe_call_outcome: "Робот позвонил продавцу: итог",
  post_showing_call_wrong_person: "Робот после показа: трубку взял не тот",
  seller_probe_call_wrong_person: "Робот продавцу: трубку взял не собственник",

  // Справочник ориентиров ведут агенты (блок J, docs/geo-match-plan-12-09.md).
  LANDMARK_CREATE: "Ориентир добавлен",
  LANDMARK_UPDATE: "Ориентир изменён",
  LANDMARK_HIDE: "Ориентир скрыт",
  LANDMARK_SHOW: "Ориентир возвращён из скрытых",
  LANDMARK_DELETE: "Ориентир удалён",
  LANDMARK_ALIAS_ADD: "Синоним ориентира добавлен",
  LANDMARK_ALIAS_REMOVE: "Синоним ориентира убран",
};

export const AUDIT_ENTITY_LABELS: Record<string, string> = {
  Expense: "Расход",
  ExpenseCategoryDefinition: "Категория расходов",
  ExpenseReceipt: "Чек расхода",
  LiveVoiceSession: "Разговор робота",
  RecurringExpense: "Постоянный расход",
  Agent: "Сотрудник",
  Property: "Объект",
  SocialVideoPost: "Свободный ролик",
  PropertyPhoto: "Фото объекта",
  Client: "Клиент",
  Deal: "Сделка",
  Settings: "Настройки",
  Landmark: "Ориентир",
  Ad: "Реклама",
  BotAuditFinding: "Находка по боту",
  BotLesson: "Урок бота",
  StyleExample: "Пример стиля",
  CallbackRequest: "Обратный звонок",
  IncomingCall: "Входящий звонок",
  InstagramComment: "Комментарий Instagram",
  JobApplication: "Анкета кандидата",
  SocialDigestPost: "Подборка в соцсетях",
  LeadMagnetCampaign: "Лид-магнит",
  LostConversation: "Потерянный разговор",
  MessengerAccount: "Аккаунт мессенджера",
  CoverTemplate: "Шаблон обложки",
  OwnerQuestion: "Вопрос собственника",
  BotConversation: "Разговор с ботом",
  TelegramConversation: "Разговор в Telegram",
  PostShowingCall: "Звонок после показа",
  SellerProbeCall: "Звонок продавцу",
  InterviewInviteCall: "Звонок-приглашение кандидату",
  PultModule: "Модуль пульта",
  RoyalScoreEvent: "Событие рейтинга",
};

/** Ссылка на сущность записи аудита — только если для типа есть страница и
 * известен короткий numeric id; удалённые объекты/клиенты дадут «не найден» —
 * это ожидаемо (запись существует, но сам объект удалён), не баг. */
export function auditEntityLink(entityType: string, meta: unknown): string | null {
  const m = meta && typeof meta === "object" ? (meta as Record<string, unknown>) : null;
  const shortId = m && typeof m.shortId === "number" ? m.shortId : null;
  if (shortId == null) return null;
  if (entityType === "Property") return `/properties/${shortId}`;
  if (entityType === "Client") return `/clients/${shortId}`;
  return null;
}

/** Человекочитаемое имя записи из meta — разные экшены кладут его под разными
 * ключами (title у объектов, fullName у клиентов/сотрудников, targetName и т.д.). */
export function auditEntityName(meta: unknown): string | null {
  const m = meta && typeof meta === "object" ? (meta as Record<string, unknown>) : null;
  if (!m) return null;
  for (const key of ["title", "name", "fullName", "targetName", "toAgentName", "category"]) {
    const v = m[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  if (Array.isArray(m.ids)) return `${m.ids.length} шт.`;
  return null;
}
