/**
 * «ПОРТРЕТ ОБЪЕКТА / ГОЛОС РЫНКА» — договор ответа GET /properties/:id/voice
 * (03.10.2026, lib/propertyVoice/ на сервере).
 *
 * Идея владельца: всё, что говорят про конкретный объект — бот-чаты, комментарии,
 * звонки, показы, агенты, — собрано у объекта и годится для цены, рекламы, отчёта
 * собственнику и ответов бота. Здесь только ФОРМА ответа; считает сервер.
 *
 * Правила, которые читатель экрана обязан знать:
 *  • Тексты клиентов приходят с закрытыми телефонами (maskPhones), экрану
 *    маскировать повторно не нужно.
 *  • `showingFeedback` ОТСУТСТВУЕТ в ответе, если у человека нет права директора
 *    (`dashboard.analytics`): итоги звонков-опросов после показа по замыслу скрыты
 *    от агентов целиком. Отсутствие ключа — не «нет данных», а «не положено».
 *  • «Нет данных» — это пустой массив/ноль/null, а не выдуманное число.
 *  • Все окна времени явные: см. `windowDays` и `windowFrom`.
 */

/** Окно по умолчанию для всех разделов, кроме «за всё время» (цена, сделки, реклама). */
export const PROPERTY_VOICE_WINDOW_DAYS = 180;

/** Сколько последних недель отдаёт динамика интереса. */
export const PROPERTY_VOICE_WEEKS = 12;

/** Сколько дней до и после снижения цены сравниваем интерес. */
export const PROPERTY_VOICE_PRICE_REACTION_DAYS = 14;

/** Сколько частотных текстов отдаёт каждый список. */
export const PROPERTY_VOICE_TOP_TEXTS = 10;

export interface PropertyVoiceCount {
  key: string;
  /** Подпись для человека, если у ключа она есть (причины отказа, исходы). */
  label?: string;
  count: number;
}

/** Частотный текст: одинаковые по смыслу реплики сведены в одну строку. */
export interface PropertyVoiceText {
  text: string;
  count: number;
}

/** Откуда в диалоге узнали объект (ConversationProperty.source). */
export const PROPERTY_VOICE_SOURCES = ["SHARED_MEDIA", "NUMBER_IN_TEXT", "LISTING_LINK", "AD_REFERRAL", "EXPOSURE"] as const;
export type PropertyVoiceSource = (typeof PROPERTY_VOICE_SOURCES)[number];

export interface PropertyVoiceInterest {
  /** Всего событий интереса за окно (PropertyInterestEvent). */
  events: number;
  /** Уникальных людей: карточка клиента или автор в канале. */
  people: number;
  byKind: { kind: string; events: number; people: number }[];
  /** Последнее событие за всё время; null — событий не было никогда. */
  lastEventAt: string | null;
  /** Дней с последнего события (по Душанбе); null — событий не было. */
  daysSinceLastEvent: number | null;
  /** Последние PROPERTY_VOICE_WEEKS недель, от старой к новой; weekStart — понедельник по Душанбе. */
  weekly: { weekStart: string; events: number; people: number }[];
  exposures: {
    /** Сколько раз объект показали/отправили людям (PropertyExposure). */
    total: number;
    uniquePeople: number;
    /** Клиент сам прислал объект (CLIENT_SHARED) — самый сильный сигнал спроса. */
    clientShared: number;
    /** Доля CLIENT_SHARED от всех экспозиций, 0..1; null — экспозиций нет. */
    clientSharedShare: number | null;
    byKind: { kind: string; count: number }[];
  };
  /** Диалоги бота, где речь шла об объекте (ConversationProperty). */
  conversations: { total: number; bySource: { source: string; count: number }[] };
}

export interface PropertyVoiceComments {
  total: number;
  byChannel: { channel: string; count: number }[];
  byStatus: { status: string; count: number }[];
  /** Комментарии, которые бот передал человеку (ESCALATED) — реальные вопросы без ответа. */
  escalated: {
    count: number;
    /** Причины передачи (поле note), по убыванию. */
    notes: PropertyVoiceText[];
    /** Частотные тексты таких комментариев. */
    topTexts: PropertyVoiceText[];
  };
}

export interface PropertyVoiceOwnerQuestion {
  question: string;
  answer: string | null;
  askedAt: string;
  answeredAt: string | null;
}

export interface PropertyVoiceQuestions {
  comments: PropertyVoiceComments;
  ownerQuestions: { total: number; answered: number; items: PropertyVoiceOwnerQuestion[] };
  /** Возражения из разбора звонков — ТОЛЬКО звонков, объект которых доказан данными CRM. */
  callObjections: { calls: number; top: PropertyVoiceText[] };
  showings: {
    total: number;
    /** Проведённые (не отменённые, прошедшие или отмеченные) — как в lib/conductedShowing. */
    conducted: number;
    declined: number;
    uniqueClients: number;
  };
  /** Отказы клиентов после показа этого объекта и их причины (Client.refusalReason). */
  refusals: { total: number; byReason: PropertyVoiceCount[] };
}

export interface PropertyVoicePriceCut {
  at: string;
  oldPrice: number;
  newPrice: number;
  oldCurrency: string;
  newCurrency: string;
  /** Изменение в %, отрицательное — снижение; null — валюты разные, сравнивать нельзя. */
  deltaPct: number | null;
  /** События интереса за N дней до/после; null — изменение старше окна, считать нечем. */
  eventsBefore: number | null;
  eventsAfter: number | null;
  /** Дней после изменения прошло на самом деле (если меньше N — «после» ещё копится). */
  daysAfterObserved: number | null;
}

export interface PropertyVoiceBargaining {
  priceChanges: PropertyVoicePriceCut[];
  /**
   * Сделки с фактической ценой; discountPct — отрицательный = продали ниже цены в карточке.
   * Продана только сделка в стадии COMPLETED: PENDING_APPROVAL и раньше — цена ещё не подтверждена.
   * Без права `deals.viewAll` здесь только СВОИ сделки (как на экране «Сделки», scopeDealsToOwnAgent).
   */
  deals: {
    stage: string;
    /** Цена продажи; null — «скрыта правами»: чужая сделка без `finance.view` (сам факт сделки виден). */
    soldPrice: number | null;
    listPrice: number;
    /** Валюта сделки (soldPrice). */
    currency: string;
    /** Валюта цены в карточке (listPrice): может отличаться от валюты сделки, если её сменили позже. */
    listCurrency: string;
    discountPct: number | null;
    closedAt: string | null;
  }[];
  /** true — сделки отфильтрованы до своих (нет права `deals.viewAll`): чужие не показаны, а не «их нет». */
  dealsOwnOnly: boolean;
}

export interface PropertyVoiceAds {
  adsCount: number;
  /**
   * true — у человека нет права на деньги рекламы (`finance.view` или роль MARKETING, как
   * GET /ads/property/:id): суммы (`spendTjs`, `spendOriginal`) скрыты. Это «не положено», а не «реклама не шла».
   * Показы, клики и обращения — не деньги, они остаются.
   */
  moneyHidden: boolean;
  /**
   * Расход за всё время в сомони — ДОЛЯ ЭТОГО ОБЪЕКТА в объявлениях (общее объявление на
   * несколько объектов делится по весам, lib/ads/adAllocation.ts); null — реклама не шла или суммы скрыты.
   */
  spendTjs: number | null;
  /** Расход в валюте кабинета (тоже доля объекта); null, если валюты смешаны, расхода нет или суммы скрыты. */
  spendOriginal: number | null;
  currency: string | null;
  impressions: number;
  clicks: number;
  /** «Начатые переписки» по данным рекламной системы. */
  conversations: number;
  /** Диалоги бота, начатые из нашей рекламы этого объекта (BotConversation.adPropertyId). */
  botConversations: number;
}

/** Только для директора. Источник — звонки-опросы после показа (PostShowingCall) и прежняя таблица ShowingSurveyCall. */
export interface PropertyVoiceShowingFeedback {
  calls: number;
  byOutcome: PropertyVoiceCount[];
  /** Дословные цитаты и сводки покупателей, телефоны закрыты. */
  quotes: string[];
  redFlags: PropertyVoiceText[];
}

/** Серьёзность пункта диагноза: info — наблюдение, warn — стоит заняться, bad — объект теряет людей. */
export const PROPERTY_DIAGNOSIS_SEVERITIES = ["info", "warn", "bad"] as const;
export type PropertyDiagnosisSeverity = (typeof PROPERTY_DIAGNOSIS_SEVERITIES)[number];

/** Код правила диагноза (lib/propertyVoice/diagnosis.ts). Список закрытый: экран подбирает по нему подсказки. */
export const PROPERTY_DIAGNOSIS_CODES = [
  "NOT_ON_SALE",
  "FEW_DATA",
  "NO_INTEREST",
  "STUCK_BEFORE_SHOWING",
  "PRICE_OBJECTIONS",
  "PRICE_CUT_NO_EFFECT",
  "ADS_NO_RESPONSE",
  "STRONG_DEMAND",
] as const;
export type PropertyDiagnosisCode = (typeof PROPERTY_DIAGNOSIS_CODES)[number];

/**
 * Один пункт диагноза «почему объект не продаётся». Считается правилами по данным
 * ответа, без ИИ. Это подсказка, а не приговор: `evidence` — цифры, на которых
 * правило сработало, и показывать их надо всегда.
 */
export interface PropertyDiagnosis {
  code: PropertyDiagnosisCode;
  severity: PropertyDiagnosisSeverity;
  title: string;
  text: string;
  evidence: string[];
}

export interface PropertyVoiceResponse {
  propertyId: string;
  generatedAt: string;
  windowDays: number;
  windowFrom: string;
  interest: PropertyVoiceInterest;
  questions: PropertyVoiceQuestions;
  bargaining: PropertyVoiceBargaining;
  ads: PropertyVoiceAds;
  /** Диагноз по правилам (может быть пустым — тогда сказать нечего). */
  diagnosis: PropertyDiagnosis[];
  /** Ключ отсутствует, если у пользователя нет права директора. */
  showingFeedback?: PropertyVoiceShowingFeedback;
}
