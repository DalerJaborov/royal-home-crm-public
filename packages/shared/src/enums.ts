/** DIRECTOR — владелец компании: проходит любую проверку прав, его учётку может менять только другой директор. */
/**
 * MARKETING, EDITOR и SECURITY добавлены 02.08.2026 по спецификации владельца:
 * у конвейера объекта (см. PROPERTY_STATUSES) и у проверки причин закрытия должны
 * быть свои ответственные, а не «кто-нибудь из менеджеров».
 */
/// SHAREHOLDER — акционер (10.10.2026): совладелец, видит бизнес целиком включая деньги, но ничего не меняет; телефоны клиентов скрыты.
/// HEAD_OF_SALES — РОП (10.10.2026): работает как агент и управляет продажами; без денег компании и настроек.
export const ROLES = ["DIRECTOR", "ADMIN", "MANAGER", "AGENT", "MARKETING", "EDITOR", "SECURITY", "SHAREHOLDER", "HEAD_OF_SALES"] as const;
export type Role = (typeof ROLES)[number];

/** Роли, которые могут вести клиентов и объекты и быть назначены на них вручную. */
export const SALES_AGENT_ROLES = ["AGENT", "HEAD_OF_SALES"] as const;
export type SalesAgentRole = (typeof SALES_AGENT_ROLES)[number];

/** Роли, которые получают лиды по лесенке автоматически (РОП — только вручную). */
export const LEAD_RECEIVING_ROLES = ["AGENT"] as const;
export type LeadReceivingRole = (typeof LEAD_RECEIVING_ROLES)[number];

/** Роли в KPI, Royal Score, рейтинге и доске почёта (РОП с агентами не соревнуется). */
export const RATED_ROLES = ["AGENT"] as const;
export type RatedRole = (typeof RATED_ROLES)[number];

/**
 * Роли «только просмотр» (10.10.2026). Одно правило — одно место: сервер отбивает
 * любую запись в requireAuth (auth/middleware.ts), а ЧТЕНИЕ не должно запускать
 * побочных действий — ИИ-совет по Royal Score, обмен OAuth-кода на маркер,
 * действие по пуш-маркеру, выданному до смены роли.
 */
export const READ_ONLY_ROLES = ["SHAREHOLDER"] as const;
export type ReadOnlyRole = (typeof READ_ONLY_ROLES)[number];
export function isReadOnlyRole(role: string | null | undefined): role is ReadOnlyRole {
  return role != null && (READ_ONLY_ROLES as readonly string[]).includes(role);
}

/**
 * ВИД ОТСУТСТВИЯ СОТРУДНИКА (владелец 09.09.2026). Зеркалит enum AbsenceKind в
 * prisma/schema.prisma.
 *
 * Различать виды понадобилось не ради статистики, а ради судьбы клиента: из
 * ОТПУСКА человек выходит в известный день, и вернувшегося продавца можно
 * подержать в очереди до его возвращения; БОЛЬНИЧНЫЙ кончается неизвестно когда,
 * и ждать нельзя — карточка уходит другому агенту сразу. OTHER — осторожная
 * трактовка по умолчанию (как больничный): не заставлять клиента ждать неизвестно
 * чего.
 */
export const ABSENCE_KINDS = ["VACATION", "SICK", "OTHER"] as const;
export type AbsenceKind = (typeof ABSENCE_KINDS)[number];

/** Облик интерфейса — компоновка главной страницы, независимая от темы (цвета).
 *  Владелец 18.08.2026 решил убрать «Живую панель» и «Живую 2.0»: остаётся только
 *  классический облик, поэтому LOOK_IDS сейчас с одним значением. Поле в схеме
 *  (uiPreferencesSchema) и в БД (Agent.preferences JSON) сохранено — старые записи
 *  со значением "live"/"live2" не ломают валидацию на чтение, просто не проходят
 *  на запись; веб-клиент трактует любое незнакомое значение как classic (см.
 *  store/uiPrefs.ts, hydrateFromServer). */
export const LOOK_IDS = ["classic"] as const;
export type LookId = (typeof LOOK_IDS)[number];

export const LOOK_LABELS: Record<LookId, string> = {
  classic: "Классический",
};

/** Темы оформления веб-клиента. Слой 4 миграции «Royal Home 2026» (08.09.2026,
 *  docs/pult/theme-2026/layer-3-plan.md §4): шесть старых тем убраны из реестра,
 *  остаётся только пара 2026. Старые id ещё встречаются в сохранённых
 *  Agent.preferences — см. LEGACY_THEME_IDS/migrateLegacyTheme ниже, они не проходят
 *  Zod-валидацию как ThemeId и должны быть развёрнуты в одну из двух текущих тем
 *  ДО того, как значение попадёт в схему (backfill-скрипт и рантайм-страховка). */
export const THEME_IDS = ["royal-home-2026-light", "royal-home-2026-night"] as const;
export type ThemeId = (typeof THEME_IDS)[number];

/** Владелец 08.09.2026: светлая тема 2026 — дефолт по умолчанию. */
export const DEFAULT_THEME: ThemeId = "royal-home-2026-light";

/** Шесть тем, удалённых слоем 4. Тёмные — мигрируют в `-night`, остальные — в `-light`. */
export const LEGACY_THEME_IDS = [
  "royal-glass",
  "emerald-noir",
  "emerald-day",
  "midnight",
  "sunset-gold",
  "violet-aurora",
] as const;
export type LegacyThemeId = (typeof LEGACY_THEME_IDS)[number];

const LEGACY_DARK_THEME_IDS: readonly string[] = ["midnight", "emerald-noir", "violet-aurora"];

/**
 * Разворачивает сохранённый id темы (старый или уже новый) в один из двух валидных
 * id 2026. Тёмные старые темы → `-night`, остальные (включая неизвестное значение) →
 * `-light`. Используется и в backfill-скрипте (apps/api/prisma/scripts/migrate-theme-2026.ts),
 * и как рантайм-страховка на клиенте/сервере — читает клиент, ещё не обновившийся
 * до нового bundle в момент деплоя, не должен увидеть undefined-тему.
 */
export function migrateLegacyTheme(id: string | null | undefined): ThemeId {
  if (id === "royal-home-2026-light" || id === "royal-home-2026-night") return id;
  if (id && LEGACY_DARK_THEME_IDS.includes(id)) return "royal-home-2026-night";
  return "royal-home-2026-light";
}

export const PROPERTY_TYPES = ["APARTMENT", "HOUSE", "COMMERCIAL", "LAND"] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export const PROPERTY_CONDITIONS = ["NEEDS_REPAIR", "GOOD", "EXCELLENT", "NEW_BUILDING"] as const;
export type PropertyCondition = (typeof PROPERTY_CONDITIONS)[number];

/**
 * Жизненный путь объекта.
 *
 * Первые четыре — КОНВЕЙЕР ПОДГОТОВКИ (спецификация владельца, Owner Flow): агент
 * завёл карточку, её проверяют, потом снимают фото, потом видео, потом монтируют, и
 * только после этого объект попадает в продажу. Раньше карточка появлялась сразу в
 * состоянии «В продаже», и понять, чего ей не хватает и кто этим занят, можно было
 * только спросив людей.
 *
 * ВАЖНО ДЛЯ ВСЕГО ОСТАЛЬНОГО КОДА: продаётся только AVAILABLE. Все проверки вида
 * `status: "AVAILABLE"` (подбор, показ объекта ботом, публикация на сайт) остаются
 * верными без правок — новые состояния означают «ещё не готов», и попадать в них
 * клиенту нельзя.
 */
export const PROPERTY_STATUSES = [
  "PENDING_REVIEW",
  "AWAITING_PHOTOS",
  "AWAITING_VIDEO",
  "EDITING",
  "AVAILABLE",
  "RESERVED",
  "SOLD",
  "WITHDRAWN",
] as const;
export type PropertyStatus = (typeof PROPERTY_STATUSES)[number];

/** Состояния конвейера подготовки — объект ещё не в продаже. */
export const PROPERTY_PIPELINE_STATUSES = [
  "PENDING_REVIEW",
  "AWAITING_PHOTOS",
  "AWAITING_VIDEO",
  "EDITING",
] as const satisfies readonly PropertyStatus[];

/**
 * Кто отвечает за объект на каждом шаге конвейера — таблица владельца.
 *
 * Роль, а не конкретный человек: сотрудники меняются, а «за фото отвечает
 * маркетинг» не меняется. Пусто у остальных состояний: там объект уже ведёт
 * назначенный агент, и второго ответственного не бывает.
 */
/**
 * Кто отвечает за объект на каждом этапе конвейера.
 *
 * «Ожидание фото» и «Ожидание видео» — это АГЕНТ, а не маркетинг: маркетинг уже
 * посмотрел материалы и вернул их на доработку, дальше мяч на стороне того, кто
 * снимает. Пока эти два этапа числились за маркетингом, просрочка копилась не на
 * том человеке, и напоминание уходило не тому — а таймер в два дня заведён именно
 * для агента (см. спецификацию владельца от 31.07.2026, таблица ответственных).
 */
export const PROPERTY_STAGE_OWNER: Partial<Record<PropertyStatus, "MARKETING" | "EDITOR" | "AGENT">> = {
  PENDING_REVIEW: "MARKETING",
  AWAITING_PHOTOS: "AGENT",
  AWAITING_VIDEO: "AGENT",
  EDITING: "EDITOR",
};

/**
 * ЧТО В КОНВЕЙЕРЕ АГЕНТ ДВИГАЕТ САМ, А ЧТО РЕШАЕТ МАРКЕТИНГ (дыра 16.08.2026).
 *
 * Кнопки «Одобрить»/«Запросить новые» закрыты правом properties.moderate, но
 * обычный PATCH объекта их обходил: агент, заведший объект, ставил ему статус
 * «Монтаж» из выпадающего списка и уводил свою карточку мимо проверки целиком —
 * монтажёру при этом уходил пуш «фото и видео одобрены», которых никто не видел.
 *
 * Таблица — что остаётся агенту БЕЗ права properties.moderate:
 *  • вернуть объект на проверку после доработки (то же, что делает автовозврат
 *    при дозагрузке фото и вставке ссылки на видео);
 *  • закрыть монтаж выходом в продажу (кнопка «Готово», POST /:id/complete-editing,
 *    правом moderate не закрыта и закрываться не должна: в EDITING объект попадает
 *    только через одобрение маркетинга, обойти проверку тут уже нечем);
 *  • снять объект с продажи — собственник передумал, публикацией это не грозит.
 * Всё остальное внутри конвейера — решение маркетинга.
 */
export const PROPERTY_AGENT_TRANSITIONS: Partial<Record<PropertyStatus, readonly PropertyStatus[]>> = {
  PENDING_REVIEW: ["WITHDRAWN"],
  AWAITING_PHOTOS: ["PENDING_REVIEW", "WITHDRAWN"],
  AWAITING_VIDEO: ["PENDING_REVIEW", "WITHDRAWN"],
  EDITING: ["AVAILABLE", "WITHDRAWN"],
};

/**
 * Нужно ли право properties.moderate, чтобы выполнить этот переход статуса.
 * Один источник правды для сервера (PATCH /properties/:id) и для выпадающего
 * списка статусов в карточке — иначе интерфейс показывал бы то, что сервер
 * отвергнет.
 */
export function requiresPropertyModeration(from: PropertyStatus, to: PropertyStatus): boolean {
  if (from === to) return false;
  // В монтаж объект попадает ТОЛЬКО одобрением обоих материалов — откуда бы ни шёл.
  if (to === "EDITING") return true;
  // WITHDRAWN исключён из PROPERTY_PIPELINE_STATUSES (это не этап подготовки), но
  // возврат ИМЕННО в AVAILABLE отсюда — тот же самый выход в продажу из состояния
  // «не в продаже», что и выход из конвейера, а не исключение из-под него (находка
  // 13.09.2026: без этой строки собственник мог вернуть снятый объект в продажу в
  // обход и maркетинга, и проверки готовности ниже в crud.ts). WITHDRAWN как ЦЕЛЬ
  // перехода (снятие с продажи) этим не затронут — правило только про AVAILABLE.
  if (from === "WITHDRAWN" && to === "AVAILABLE") return true;
  // Объект уже вышел из подготовки: продажа, резерв, снятие — не дело маркетинга.
  if (!(PROPERTY_PIPELINE_STATUSES as readonly PropertyStatus[]).includes(from)) return false;
  return !(PROPERTY_AGENT_TRANSITIONS[from] ?? []).includes(to);
}

export const CURRENCIES = ["USD", "TJS"] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Стадия строительства — только для объектов-новостроек, необязательна.
 * Порядок отражает реальный ход стройки: котлован → коробка → строится → построен. */
/* ROUGH_FINISH («черновые работы сделаны») добавлена 23.09.2026 по просьбе
 * владельца: у коробки выбирать было нечего, кроме «без отделки». Как эти
 * значения показываются агенту одним вопросом — packages/shared/src/propertyFinish.ts. */
export const PROPERTY_STAGES = ["FOUNDATION", "SHELL", "UNDER_CONSTRUCTION", "ROUGH_FINISH", "BUILT"] as const;
export type PropertyStage = (typeof PROPERTY_STAGES)[number];

/**
 * Новостройки/Вторичка/Котлован — отдельная ось от PropertyType (категория
 * объекта: квартира/дом/...).
 *
 * Аренды в этой оси нет и не планируется: агентство ею не занимается (решение
 * владельца 11.09.2026). «Котлован» — не стадия стройки, а то, ЧТО покупают:
 * право на квартиру в проекте, который ещё не строится. Ход работ у уже
 * заведённой новостройки описывает отдельная ось PROPERTY_STAGES.
 */
export const MARKET_TYPES = ["NEW_BUILD", "SECONDARY", "FOUNDATION_PIT"] as const;
export type MarketType = (typeof MARKET_TYPES)[number];

/** Опции 13 select-полей «характеристик» объекта — 1:1 со значениями, которые хранит
 * сайт (Property.details на сайте — Record<string,string>, здесь то же самое, в JSON-колонке).
 * Порядок — как на сайте (src/pages/AdminListingForm.tsx), значения копированы дословно. */
export const PROPERTY_DETAIL_OPTIONS = {
  balcony: ["Балкон", "Лоджия", "Лоджия + балкон", "2 лоджии", "Терасса", "Нет"],
  bathroom: ["Раздельный", "Совмещённый", "2+ санузла"],
  ceilingHeight: ["2.5 м", "2.7 м", "2.8 м", "3.0 м", "3.2 м+"],
  windows: ["Пластиковые", "Панорамные", "Витражные", "Деревянные"],
  heating: ["Автономное", "Центральное", "Электрическое", "Нет"],
  elevator: ["1 лифт", "2 лифта", "Грузовой + пассажирский", "Нет"],
  parking: ["Подземный паркинг", "Надземный паркинг", "Открытая парковка", "Уличная парковка", "Нет"],
  security: ["Охрана, видеонаблюдение", "Консьерж", "Домофон", "Закрытый двор", "Нет"],
  yearBuilt: ["2026", "2025", "2024", "2023", "2022", "2020–2021", "2015–2019", "2010–2014", "До 2010"],
  material: ["Монолитный каркас", "Кирпич", "Панель", "Блочный", "Саман"],
  internet: ["Оптоволокно", "DSL", "4G/5G роутер", "Нет"],
  furniture: ["Полностью", "Частично", "Без мебели"],
  appliances: ["Встроенная техника", "Премиум техника", "Smart Home", "Без техники"],
} as const;
export type PropertyDetailKey = keyof typeof PROPERTY_DETAIL_OPTIONS;
export const PROPERTY_DETAIL_KEYS = Object.keys(PROPERTY_DETAIL_OPTIONS) as PropertyDetailKey[];

export const CLIENT_STATUSES = [
  "NEW",
  "CONTACTED",
  "HOT",
  "COLD",
  "UNRESPONSIVE",
  /**
   * ПОТЕРЯННЫЙ — лид прошёл предел передач между агентами (Настройки,
   * leadMaxTransfers) и больше не распределяется. Не «архив» и не «холодный»:
   * архив это ручное решение человека, холодный вернётся сам через месяц, а сюда
   * карточка попадает по счёту — трое агентов уже не смогли, и четвёртому её
   * выдавать бессмысленно. Руководитель по-прежнему может назначить её вручную.
   */
  "LOST",
  "DEAL_CLOSED",
  "ARCHIVED",
] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

/**
 * «Состояние» (то, что было выше — ClientStatus) VS «Статус» (WorkStatus здесь).
 *
 * Переработка 12.08.2026 по ТЗ владельца: агент больше не правит ClientStatus руками
 * (это отдал целиком автоматике, см. lib/clientAutoStatus.ts). Единственное, чем
 * управляет сам агент — WorkStatus:
 *   ACTIVE   — агент продолжает вести клиента сам;
 *   INACTIVE — клиент замолчал/отложил покупку; агент за клиентом остаётся, но
 *              карточка не занимает слот в лимите активных лидов.
 * «Передача» и «Завершить сделку» — не значения этого поля, а действия (см.
 * routes/clients.ts): передача сохраняет ACTIVE, но у нового агента; завершение
 * переводит ClientStatus в DEAL_CLOSED/LOST.
 */
export const WORK_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

/**
 * Причины «Неактивного» (ТЗ владельца 12.08.2026, п. 22) — ВРЕМЕННЫЙ фактор, клиент
 * потенциально вернётся. Не путать с REFUSAL_REASONS (schemas.ts) — та таксономия
 * для «Без сделки», окончательного завершения работы с клиентом.
 */
export const INACTIVE_REASONS = [
  "THINKING",
  "NO_MONEY_YET",
  "POSTPONED",
  "STOPPED_RESPONDING",
  "NOT_READY_YET",
  "ASKED_LATER",
  "FAMILY_CIRCUMSTANCES",
  "OTHER",
] as const;
export type InactiveReason = (typeof INACTIVE_REASONS)[number];

export const CLIENT_SOURCES = [
  "WEBSITE",
  "INSTAGRAM",
  "FACEBOOK",
  "WHATSAPP",
  "TELEGRAM",
  "TIKTOK",
  "GOOGLE_ADS",
  "YANDEX_DIRECT",
  "REFERRAL",
  "PHONE_CALL",
  "WALK_IN",
] as const;
export type ClientSource = (typeof CLIENT_SOURCES)[number];

export const CLIENT_KINDS = ["BUYER", "SELLER", "OTHER"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

export const INTERACTION_TYPES = [
  "CALL",
  "MESSAGE",
  "MEETING",
  "SHOWING",
  "STATUS_CHANGE",
  "SYSTEM",
] as const;
export type InteractionType = (typeof INTERACTION_TYPES)[number];

/// Исходы разговора. Три WAITING_* добавлены по требованию владельца от 30.07
/// («итог звонка»): они не оценка настроения, а состояние ожидания, из которого
/// понятно следующее действие. POSITIVE/NEUTRAL остаются: ими записана вся
/// прошлая история, и переписывать её задним числом нельзя.
export const INTERACTION_OUTCOMES = [
  "POSITIVE",
  "NEUTRAL",
  "NEGATIVE",
  "NO_ANSWER",
  "WAITING_CALL",
  "WAITING_OPTIONS",
  "WAITING_SHOWING",
  /// Только для звонков продавцу (Client.kind === SELLER) — спецификация владельца,
  /// «Путь продавца»: собственник согласился сотрудничать, CRM автоматически
  /// запускает 36-часовой таймер «Итог объекта» (см. requirePropertySummaries).
  "PROPERTY_ACCEPTED",
  /// Только для звонков продавцу (владелец 18.08.2026): договорились о встрече на
  /// объекте — осмотр, видеосъёмка, приём в работу ещё не решён окончательно. В
  /// отличие от WAITING_SHOWING (это показ ОБЪЕКТА покупателю) и PROPERTY_ACCEPTED
  /// (объект уже официально принят в работу) — здесь просто назначена дата визита
  /// к продавцу; создаётся задача-напоминание (nextAction/nextActionDate), а не
  /// показ и не приём. lib/aiCallOutcome.ts заполняет автоматически, как и другие.
  "SELLER_MEETING",
] as const;
export type InteractionOutcome = (typeof INTERACTION_OUTCOMES)[number];

/// Подписи исходов — общие для формы записи разговора и хронологии карточки.
export const INTERACTION_OUTCOME_LABELS: Record<InteractionOutcome, string> = {
  WAITING_CALL: "Ждёт следующий звонок",
  WAITING_OPTIONS: "Ждёт варианты (ссылки на объекты)",
  WAITING_SHOWING: "Ждёт показ",
  NEGATIVE: "Отрицательно",
  NO_ANSWER: "Не ответил",
  POSITIVE: "Положительно",
  NEUTRAL: "Нейтрально",
  PROPERTY_ACCEPTED: "Объект принят в работу",
  SELLER_MEETING: "Встреча с продавцом назначена",
};

/// Исходы, доступные в форме «Итог звонка». POSITIVE/NEUTRAL сюда не входят:
/// владелец заменил их состояниями ожидания, но старые записи их сохраняют.
export const CALL_OUTCOME_CHOICES = [
  "WAITING_CALL",
  "WAITING_OPTIONS",
  "WAITING_SHOWING",
  "NEGATIVE",
  "NO_ANSWER",
] as const;

/**
 * Исходы обязательного окна «Как прошёл звонок» — только те, что есть в ТЗ п. 11.
 *
 * «Отрицательно» сюда не входит. Этот исход стоит под статусом АКТИВНЫЙ, но не
 * означает никакого следующего шага: задачи он не ставит, к завершению работы не
 * ведёт, и окно закрывалось впустую. Разговор, после которого работать с клиентом
 * дальше незачем, — это статус «Неактивный» (или «Передача»/«Завершить сделку»
 * после первого показа), а не итог активного клиента. В форме записи разговора
 * задним числом (AddInteractionModal) «Отрицательно» остаётся: там фиксируют то,
 * что уже случилось, а не выбирают следующий шаг.
 */
export const MANDATORY_CALL_OUTCOME_CHOICES = CALL_OUTCOME_CHOICES.filter((o) => o !== "NEGATIVE");

/// Исходы звонка ПРОДАВЦУ — СВОЙ набор, а не CALL_OUTCOME_CHOICES с довеском
/// (баг, найденный владельцем 28.08.2026: окно после звонка продавцу показывало
/// «Ждёт показ» и «Ждёт объекты» — оба про то, как ПОКУПАТЕЛЬ ждёт объекты
/// показать ЕМУ; для продавца это бессмысленно, у него объект свой). WAITING_CALL
/// и NO_ANSWER — общие для любого клиента, PROPERTY_ACCEPTED и SELLER_MEETING —
/// только для продавца (см. их описание выше).
export const SELLER_CALL_OUTCOME_CHOICES = [
  "WAITING_CALL",
  "NEGATIVE",
  "NO_ANSWER",
  "PROPERTY_ACCEPTED",
  "SELLER_MEETING",
] as const;

export const EXPENSE_CATEGORIES = ["ADVERTISING", "SALARY", "OFFICE", "OTHER"] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const DEAL_STAGES = [
  "NEGOTIATION",
  "AGREEMENT_PENDING",
  "CONTRACT_SIGNED",
  /// Агент указал фактическую цену и комиссию суммой (не процентом) и отправил
  /// сделку на закрытие — ждёт решения руководителя. См. Deal.stage в schema.prisma.
  "PENDING_APPROVAL",
  "COMPLETED",
  "CANCELLED",
] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

/// Виды документов сделки (Пачка 14, 11.09.2026). См. Deal.documents /
/// DealDocument.kind в schema.prisma и Settings.dealRequiredDocuments (чек-лист
/// перед закрытием сделки).
export const DEAL_DOCUMENT_KINDS = ["OWNERSHIP", "CONTRACT", "PASSPORT", "RECEIPT", "OTHER"] as const;
export type DealDocumentKind = (typeof DEAL_DOCUMENT_KINDS)[number];

export const DEAL_DOCUMENT_KIND_LABELS: Record<DealDocumentKind, string> = {
  OWNERSHIP: "Свидетельство собственности",
  CONTRACT: "Договор",
  PASSPORT: "Паспорт",
  RECEIPT: "Квитанция",
  OTHER: "Другое",
};

/// Судьба комментария под публикацией Instagram (InstagramComment.status).
/// Значения задаёт messengers/comments.ts; строкой, а не enum'ом Prisma, — там же.
export const INSTAGRAM_COMMENT_STATUSES = [
  "PENDING",
  "WORKING",
  "REPLIED",
  "HIDDEN",
  "DELETED",
  "ESCALATED",
  "SKIPPED",
  "FAILED",
] as const;
export type InstagramCommentStatus = (typeof INSTAGRAM_COMMENT_STATUSES)[number];

/// Статус из базы — известный? В таблице это обычная строка, и значение,
/// пришедшее из старой записи или снятого с учёта статуса, не должно попадать
/// в ленту как настоящее состояние.
export function isInstagramCommentStatus(value: string): value is InstagramCommentStatus {
  return (INSTAGRAM_COMMENT_STATUSES as readonly string[]).includes(value);
}

/// Подписи статусов для ленты комментариев.
///
/// Владелец читает не «REPLIED», а «что стало с комментарием»: подписи написаны
/// от лица результата, а не от лица кода. HIDDEN намеренно без слова «бот» —
/// скрыть может и сотрудник вручную, а строка одна на оба случая.
export const INSTAGRAM_COMMENT_STATUS_LABELS: Record<InstagramCommentStatus, string> = {
  PENDING: "Ждёт ответа бота",
  WORKING: "Бот отвечает прямо сейчас",
  REPLIED: "Бот ответил",
  HIDDEN: "Скрыт от подписчиков",
  DELETED: "Отмечен удалённым",
  ESCALATED: "Бот не знал ответа",
  SKIPPED: "Бот промолчал",
  FAILED: "Ответить не удалось",
};

/// Площадка, откуда пришёл комментарий, человеческим словом.
///
/// Комментарии под публикациями приходят с трёх площадок: Instagram (с 31.07.2026),
/// страница Facebook (16.08.2026) и YouTube (17.09.2026). В базе это строка канала,
/// и до 23.09.2026 наружу она не выходила НИГДЕ: лента комментариев в CRM площадку
/// не показывала, а отказ сервера называл Instagram при любом канале. Владелец
/// спрашивал ровно это — «или только в инстаграме?» — и ответить ему было нечем.
///
/// Словарь общий для сервера и сайта нарочно (правило «одно правило — одно место»):
/// подпись площадки в тексте ошибки и подпись на карточке комментария обязаны
/// совпадать слово в слово.
export const COMMENT_NETWORK_NAMES: Record<string, string> = {
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  YOUTUBE: "YouTube",
  TELEGRAM: "Telegram",
};

/// Запасной вариант — сам код канала: новая площадка появится раньше, чем подпись
/// к ней, и «WHATSAPP» честнее пустого места.
export function commentNetworkName(channel: string | null | undefined): string {
  if (!channel) return COMMENT_NETWORK_NAMES.INSTAGRAM;
  return COMMENT_NETWORK_NAMES[channel] ?? channel;
}

/// Расшифровка поля note. Коды пишет messengers/comments.ts; при эскалации и
/// части пропусков туда попадает свободная фраза модели по-русски — её показываем
/// как есть, поэтому список именно словарь с запасным вариантом, а не Record по
/// закрытому объединению.
export const INSTAGRAM_COMMENT_NOTE_LABELS: Record<string, string> = {
  bot_off: "Бот был выключен, комментарий остался без ответа",
  own: "Наш собственный комментарий",
  loop_guard: "Бот уже отвечал этому человеку под этим постом дважды за сутки",
  spam: "Спам, мат или оскорбление",
  nothing_to_say: "Отвечать было не на что",
  empty_reply: "Бот решил ответить, но текста не составил",
  no_answer: "Бот не смог ответить после трёх попыток",
  dm_thread: "Личное не отправить: комментарий внутри ветки",
  dm_window: "Личное не отправить: с комментария прошло больше 7 суток",
  dm_limit: "Личное не отправлено: этому человеку уже писали сегодня",
  dm_failed: "Личное сообщение не ушло",
  manual_hide: "Скрыл сотрудник вручную",
  manual_unhide: "Вернул сотрудник вручную",
  // Ручной ответ сотрудника через CRM (POST /instagram-comments/:id/reply) —
  // отличаем от ответа бота тем же полем note, что и остальные исходы, чтобы
  // в ленте не заводить отдельный визуальный признак под один случай.
  manual_reply: "Ответил сотрудник вручную",
  // Воронка лид-магнита (apps/api/src/lib/leadMagnet.ts): комментарий разобрал
  // автомат, а не модель, и по нему ушло приглашение в директ.
  lead_magnet: "Воронка: приглашение с кнопкой ушло в директ",
  lm_no_button: "Воронка: кнопку Instagram не принял, приглашение ушло текстом",
  lm_repeat: "Воронка: этому человеку уже писали по этой кампании",
  lm_window: "Воронка: с комментария прошло больше 7 суток, писать в директ поздно",
  lm_dm_failed: "Воронка: приглашение в директ не ушло",
  // Коды, которые до 15.09.2026 показывались сотруднику сырыми (ai_down, gone
  // и прочие): экран печатает note как есть, если его нет в этом словаре,
  // поэтому владелец видел в «Почему» латинский код вместо причины.
  ai_budget: "Этот человек исчерпал суточный запас ответов бота",
  ai_down: "Бот не смог ответить: искусственный интеллект был недоступен",
  gone: "Комментарий недоступен на площадке — отвечать некуда",
  competitor_ad: "Реклама конкурента",
  youtube_rejected: "YouTube подтвердил отклонение комментария",
  moderation_deleted: "Площадка подтвердила удаление",
  moderation_hidden: "Площадка подтвердила изменение видимости",
  moderation_unknown: "Площадка не подтвердила результат; проверьте комментарий на площадке",
  cant_delete: "Площадка отказала в удалении",
  cant_hide: "Площадка отказала в изменении видимости",
  lm_author_nudged: "Воронка: человеку напомнили про отправленный файл",
  lm_author_pending: "Воронка: напоминание этому человеку уже отправляли",
};

/// Как показать note человеку: известный код — расшифровкой, всё прочее — как есть
/// (там лежит фраза модели «чего не хватило, чтобы ответить»).
export function instagramCommentNoteLabel(note: string | null | undefined): string | null {
  if (!note) return null;
  return note.split(";").map((part) => {
    const key = part.trim();
    return INSTAGRAM_COMMENT_NOTE_LABELS[key] ?? key;
  }).join("; ");
}
/**
 * Шаг разговора, на котором человек ушёл и не вернулся (недельный разбор
 * оборванных переписок, apps/api/src/lib/lostConversations.ts).
 *
 * Порядок — это порядок самого разговора, от «поздоровались» до «попросили номер».
 * Он важен: экран строит по нему воронку, и переставлять элементы местами нельзя.
 */
export const LOST_STAGES = [
  "greeting",
  "needs",
  "budget",
  "district",
  "properties",
  "phone",
  "other",
] as const;
export type LostStage = (typeof LOST_STAGES)[number];

/** Объективный признак, по которому переписка признана оборвавшейся. */
export const LOST_REASONS = ["opted_out", "follow_ups_exhausted", "silent"] as const;
export type LostReason = (typeof LOST_REASONS)[number];
