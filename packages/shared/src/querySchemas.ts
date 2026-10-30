import { z } from "zod";
import {
  PROPERTY_TYPES,
  PROPERTY_STATUSES,
  CLIENT_SOURCES,
  CLIENT_STATUSES,
  CLIENT_KINDS,
  DEAL_STAGES,
  INSTAGRAM_COMMENT_STATUSES,
  CURRENCIES,
  INTERACTION_TYPES,
  WORK_STATUSES,
} from "./enums.js";
import { SECURITY_REVIEW_STATES } from "./schemas.js";

/** Цвет светофора неактивных (см. apps/api/src/lib/inactiveTrafficLight.ts —
 *  InactiveLevel там же). Отдельный список, а не переэкспорт: тот модуль
 *  вычисляет цвет и не заводит на него zod-схему, здесь нужна только
 *  валидация query-параметра списка клиентов. */
const INACTIVE_LEVELS = ["GREEN", "YELLOW", "RED"] as const;

const uuid = z.guid();
/**
 * Номер страницы — с ПОТОЛКОМ, а не только с минимумом.
 *
 * Без верхней границы `?page=1000000` доходил до выборок вида `take: page * PAGE_SIZE`
 * (инбокс «Сообщения» собирает объединённый список из двух таблиц именно так) —
 * то есть один адрес в строке браузера просил у базы миллионы строк с JSON-колонками
 * переписки. Тысяча страниц — заведомо больше, чем кто-либо листает руками; всё, что
 * дальше, ищут фильтром, а не перелистыванием.
 */
const page = z.coerce.number().int().min(1).max(1000).default(1);

/** Тот же номер страницы для маршрутов, у которых нет собственной схемы запроса
 *  (журнал действий, звонки, центр безопасности, маркетинг). Раньше каждый из них
 *  разбирал `page` руками (`Math.max(Number(req.query.page) || 1, 1)`) — минимум был,
 *  потолка не было, и `?page=100000000` уходил в базу как `OFFSET 4e9`. */
export const pageQuerySchema = z.object({ page });
export type PageQuery = z.infer<typeof pageQuerySchema>;

export const propertyQuerySchema = z.object({
  type: z.enum(PROPERTY_TYPES).optional(),
  districtId: uuid.optional(),
  /** Несколько районов сразу (требование владельца от 30.07, пункт 7) — id через
   *  запятую: `districtIds=a,b`. Одиночный districtId остаётся: им пользуются
   *  ссылки с дашборда, карты и окна подбора. Указаны оба — районы объединяются. */
  districtIds: z
    .string()
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(uuid).max(20))
    .optional(),
  priceMin: z.coerce.number().nonnegative().optional(),
  priceMax: z.coerce.number().nonnegative().optional(),
  /** В какой валюте заданы priceMin/priceMax. Цены объектов лежат каждая в своей,
   *  поэтому границы без валюты сравнивать не с чем. По умолчанию сомони — валюта
   *  отчётности компании. */
  priceCurrency: z.enum(CURRENCIES).default("TJS"),
  rooms: z.coerce.number().int().positive().optional(),
  /**
   * Площадь, квадратные метры — граница снизу и сверху.
   *
   * Появилось 10.08.2026 по жалобе владельца: «ввожу квадратные метры — поиск не
   * работает». Он вводил число в строку поиска, а та ищет по названию и адресу;
   * фильтра площади не существовало вовсе — ни здесь, ни в интерфейсе. Площадь —
   * второе, о чём спрашивает клиент после цены, поэтому это отдельные поля, а не
   * догадка по строке поиска: «120» в тексте с равным успехом означает и метры,
   * и номер дома.
   *
   * Потолок в 100 000 м² — защита от `areaMax=1e9` в адресной строке, а не оценка
   * рынка: самый большой объект в базе меньше на три порядка.
   */
  areaMin: z.coerce.number().nonnegative().max(100_000).optional(),
  areaMax: z.coerce.number().nonnegative().max(100_000).optional(),
  status: z.enum(PROPERTY_STATUSES).optional(),
  /**
   * «1» — объекты В ПОДГОТОВКЕ: все четыре этапа конвейера сразу (на проверке,
   * ждём фото, ждём видео, на монтаже).
   *
   * Владелец 21.09.2026: «удали лишние разделы — на проверке, ждём фото, ждём
   * видео и так далее». В ленте срезов каталога четыре этапа занимали половину
   * ряда и относятся к работе маркетинга, а не к поиску объекта. Одной пилюлей
   * они и сворачиваются — но сворачиваются, а не исчезают: очередь подготовки
   * маркетингу нужна, а `status` принимает ровно одно состояние.
   *
   * Строка «1», а не boolean, по той же причине, что noVideo и overdue ниже.
   */
  inPrep: z.literal("1").optional(),
  q: z.string().trim().max(200).optional(),
  /**
   * «1» — только объекты БЕЗ ссылки на видео-обзор в Instagram.
   *
   * Это рабочая очередь монтажёра и одновременно ответ на давний вопрос «почему
   * бот не узнаёт пересланный рилс»: узнавание ищет код поста среди
   * Property.instagramUrl, и ломается оно не на слепоте модели, а на пустом поле
   * в карточке. Пока такого списка не было, найти эти объекты можно было только
   * пролистав каталог глазами.
   *
   * Не boolean-коэрция: z.coerce.boolean("false") даёт true — та же ловушка, из-за
   * которой соседний фильтр «горячие» сделан строкой «1».
   */
  noVideo: z.literal("1").optional(),
  /**
   * «Просрочено на этапе конвейера» — для пульта директора и админов: от красной
   * плитки «Из них просрочено» должен открываться список ИМЕННО просроченных
   * объектов (требование владельца 15.09.2026: «быстро нажать и перейти к виновнику»).
   *
   * Считается на сервере, а не на клиенте: список отдаётся страницами по 20, и
   * фильтр по загруженной странице врал бы ровно там, где очередь монтажа длинная,
   * то есть в единственном случае, когда этот список вообще нужен.
   *
   * Строка «1», а не boolean, по той же причине, что и noVideo выше.
   */
  overdue: z.literal("1").optional(),
  sort: z.enum(["price_asc", "price_desc"]).optional(),
  /**
   * «Мои объекты» / «Все объекты» (владелец 21.08.2026) — фильтр по интейк-агенту
   * (кто принял объект у продавца и завёл карточку), а не по assignedAgentId:
   * риелтор сделки появляется только в момент сделки, а переключатель нужен сразу
   * на каталоге. Это УДОБСТВО, а не ограничение доступа — каталог общий по
   * замыслу (см. hint у properties.viewAll в permissions.ts), параметр просто
   * сужает уже доступную агенту выдачу тем же способом, что agentId у /clients.
   */
  agentId: uuid.optional(),
  /** Объекты конкретного продавца (Property.sellerClientId — строка без внешнего
   *  ключа, см. schemas.ts). Нужен карточке продавца — предупредить агента, что у
   *  этого продавца уже есть объект(ы) в CRM, прежде чем «Создать объект из заявки»
   *  откроет ещё одну пустую форму (владелец 15.09.2026). */
  sellerClientId: uuid.optional(),
  page,
});
export type PropertyQuery = z.infer<typeof propertyQuerySchema>;

/**
 * Сортировка списка клиентов — `<поле>_<направление>`.
 *
 * Одним словарём на сервер и на интерфейс: заголовок таблицы собирает это же
 * значение из имени колонки и стрелки, и разъехаться им нельзя — незнакомую
 * строку сервер отвергнет как неверный запрос, а не отсортирует «как-нибудь».
 *
 * `budget_*` считается НЕ базой: бюджеты лежат каждый в своей валюте, и голая
 * колонка поставила бы $40 000 перед 100 000 сомони (та же ловушка, что у цен
 * объектов, см. routes/properties.ts). Пересчёт по курсу живёт в routes/clients.ts.
 */
export const CLIENT_SORTS = [
  "name_asc",
  "name_desc",
  "status_asc",
  "status_desc",
  "score_asc",
  "score_desc",
  "budget_asc",
  "budget_desc",
  "source_asc",
  "source_desc",
  "created_asc",
  "created_desc",
  "contact_asc",
  "contact_desc",
  "agent_asc",
  "agent_desc",
  /** «Мой вид» экрана «Клиенты» артефакта: сначала те, кому нужен ответ —
   *  непринятые карточки, затем по давности последнего контакта. */
  "attention_desc",
] as const;
export type ClientSort = (typeof CLIENT_SORTS)[number];

export const clientQuerySchema = z.object({
  status: z.enum(CLIENT_STATUSES).optional(),
  kind: z.enum(CLIENT_KINDS).optional(),
  /** «1» — только горячие клиенты (hotSince задан): отказные с заполненной карточкой
   *  или после показа, переданные сильному агенту. Не boolean-коэрция намеренно:
   *  z.coerce.boolean("false") даёт true, а enum не оставляет двусмысленности. */
  hot: z.enum(["1"]).optional(),
  /** Срез «Ждут принятия» (карточка/дашборд агента, сроки docs/TASKS.md
   *  «дашборд агента против ТЗ» 07.09.2026): честный серверный фильтр
   *  acceptedAt IS NULL вместо клиентской фильтрации первой страницы обычной
   *  сортировки, где старый переназначенный лид с дедлайном в минутах мог не
   *  попасть в первые 20 карточек. Не boolean-коэрция намеренно, как у `hot`. */
  pendingAcceptance: z.enum(["1"]).optional(),
  /**
   * Срез «Вчера остались без ответа» — плитка директора на мобильной главной
   * (MobileDirectorHome). Условие ровно то же, каким считается само число в
   * утренней сводке (lib/morningNumbers.ts, firstTouchNoneCount): карточка
   * заведена вчерашними календарными сутками Душанбе И первого касания не было
   * (`firstContactAt IS NULL`).
   *
   * Почему на сервере. Сначала срез отбирал уже загруженную страницу, и число на
   * плитке со списком могли разойтись: вчерашние карточки за пределами первых
   * двадцати в список не попадали. Директор сверяет одно с другим глазами —
   * расхождение здесь дороже лишнего параметра. Не boolean-коэрция, как у `hot`.
   */
  noFirstContactYesterday: z.enum(["1"]).optional(),
  districtId: uuid.optional(),
  agentId: uuid.optional(),
  /** Источник — фильтр шторки «Фильтры» экрана «Клиенты» (артефакт). */
  source: z.enum(CLIENT_SOURCES).optional(),
  /** Раздел «Контроль руководителя» → «Светофор неактивных»: клик по числу
   *  матрицы агент×цвет переходит сюда с этими двумя фильтрами (аудит
   *  03.09.2026 ночь, п.7 — «весь светофор одним взглядом»). workStatus без
   *  inactiveLevel — тоже валиден (все неактивные клиента/агента). */
  workStatus: z.enum(WORK_STATUSES).optional(),
  inactiveLevel: z.enum(INACTIVE_LEVELS).optional(),
  q: z.string().trim().max(200).optional(),
  /** «name» — прежнее значение до появления сортировки по всем колонкам; оставлено
   *  ради ссылок и кэша PWA со старой версией интерфейса (равно «name_asc»). */
  sort: z.enum([...CLIENT_SORTS, "name"]).optional(),
  page,
  /** Для селектов-справочников: одной страницей до 200 записей вместо обычных 20. */
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  /**
   * Вкладка «Все мои клиенты» (18.09.2026, задание В, §f п.1) — при своём
   * агенте (`ownAgentId`) снимает ВСЕ срезы, которые обычно прячут карточку:
   * Корзину, kind=OTHER, статус/workStatus. Показывает буквально всё, где
   * агент сейчас или когда-то был держателем — единственное место, где
   * потерянную «молча» карточку можно найти без обращения к руководителю.
   * Без прав руководства (archive.view/clients.assign) не расширяется:
   * граница прав та же, что у обычного списка.
   */
  scope: z.enum(["allMine", "inWork"]).optional(),
});
export type ClientQuery = z.infer<typeof clientQuerySchema>;

/** Инбокс «Сообщения»: q ищет по имени клиента/диалога и по тексту сообщений
 *  (последнее делается на сервере в приложении — messages это JSON-колонка). */
export const conversationQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  /** Фильтр по каналу мессенджера («только Instagram» и т.п.); нет = все каналы.
   *  Не enum, а произвольная строка: список каналов строится из данных (новый
   *  подключённый канал появляется в фильтре сам, без правок кода). */
  channel: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .transform((s) => s.toUpperCase())
    .optional(),
  /** Фильтр по НАШЕМУ аккаунту: в какой Instagram написали (Royal Home или
   *  Royal Home Info). Нет — показываем все. */
  accountId: z.string().trim().min(1).max(64).optional(),
  /** Срез «Ждут человека» (шаг 5 переноса, 10.09.2026, эталон messages.html) —
   *  последняя реплика от клиента, бот/агент ещё не ответил. Не boolean-коэрция
   *  (см. noVideo выше): z.coerce.boolean("false") даёт true. */
  needsHuman: z.literal("1").optional(),
  /** Срез «Бот на паузе» — pausedUntil ещё не истёк. */
  paused: z.literal("1").optional(),
  /** Срез «Мои» — диалоги клиентов, закреплённых за текущим сотрудником. */
  mine: z.literal("1").optional(),
  /** Opt-in inbox rows grouped by exact linked CRM client. */
  grouped: z.literal("1").optional(),
  page,
});
export type ConversationQuery = z.infer<typeof conversationQuerySchema>;

/**
 * Лента комментариев под публикациями Instagram.
 *
 * pageSize задан здесь, а не только на сервере: предел выборки — свойство самого
 * запроса, и без него ссылка «?pageSize=100000» превратила бы ленту в выгрузку
 * всей таблицы одним ответом. Потолок 100 — столько строк ещё имеет смысл читать
 * глазами, а больше нужно только машине.
 */
export const instagramCommentQuerySchema = z.object({
  status: z.enum(INSTAGRAM_COMMENT_STATUSES).optional(),
  page,
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});
export type InstagramCommentQuery = z.infer<typeof instagramCommentQuerySchema>;

export const dealQuerySchema = z.object({
  stage: z.enum(DEAL_STAGES).optional(),
  agentId: uuid.optional(),
  /** Поиск командной палитры (CommandPalette): по имени/телефону клиента или
   *  названию/адресу объекта сделки. Необязателен — обычный список сделок им не пользуется. */
  q: z.string().trim().max(200).optional(),
});
export type DealQuery = z.infer<typeof dealQuerySchema>;

/** "to" передаётся как YYYY-MM-DD (начало дня) — маршруты сами сдвигают её на конец дня. */
export const dateRangeQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type DateRangeQuery = z.infer<typeof dateRangeQuerySchema>;

/**
 * Лента активности команды: период, страница и фильтр по сотруднику.
 *
 * Собрана из тех же кирпичей, что календарь и отчёты, — иначе один и тот же
 * «период» ведёт себя в разделах по-разному. Рядовому агенту `agentId` всё равно
 * не поможет увидеть чужие записи: маршрут сужает выборку до него самого.
 */
export const interactionFeedQuerySchema = dateRangeQuerySchema.extend({
  page,
  agentId: uuid.optional(),
  /** Фильтр по типу действия (звонок/сообщение/показ/встреча/...) — шторка
   *  фильтров экрана «Активность». Нет = все типы, как раньше. */
  type: z.enum(INTERACTION_TYPES).optional(),
});
export type InteractionFeedQuery = z.infer<typeof interactionFeedQuerySchema>;

/**
 * Сводка «Активности» за период — те же параметры, что и у ленты, без страницы.
 *
 * Выведена из схемы ленты, а не написана заново: плитки обязаны считаться ровно
 * по тому же периоду и тому же фильтру по агенту, что и список под ними. Стоило
 * бы завести второй разбор «периода» — и два числа на одном экране начали бы
 * расходиться на границе суток, причём молча.
 */
export const activitySummaryQuerySchema = interactionFeedQuerySchema.omit({ page: true });
export type ActivitySummaryQuery = z.infer<typeof activitySummaryQuerySchema>;

/**
 * Журнал обращений к ИИ-ассистенту CRM (GET /ai/assistant-audit, модель
 * AiAssistantAuditLog, lib/aiAssistantAudit.ts) — те же кирпичи, что и у ленты
 * активности: `page` с потолком, `dateRangeQuerySchema` для периода. Без
 * `type`: инструментов ассистента десятки и они не образуют закрытый список,
 * как INTERACTION_TYPES — фильтр по инструменту, если понадобится, лучше
 * сделать простой строкой без enum.
 */
export const assistantAuditQuerySchema = dateRangeQuerySchema.extend({
  page,
  agentId: uuid.optional(),
});
export type AssistantAuditQuery = z.infer<typeof assistantAuditQuerySchema>;

/**
 * Кабинет службы безопасности (GET /security/lost-clients, /security/lost-properties,
 * шаг 5 переноса): страница, вердикт и «вина агента» — та же строка «1», что и у
 * фильтра «горячие» в clientQuerySchema (не boolean-коэрция намеренно: z.coerce.boolean
 * даёт true даже на "false"). Раньше verdict разбирался руками в routes/security.ts —
 * здесь тот же список состояний, но через схему, как у всех остальных списков.
 */
/**
 * Список ориентиров (Настройки → Агентство → «Ориентиры», блок J). Поиск ищет
 * по названию И по синонимам (GeoAlias.normalized) — сервер сам решает, как
 * объединить два источника, схема только валидирует вход.
 */
export const landmarkQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  category: z.string().trim().max(80).optional(),
  /** «1» — включить скрытые (enabled=false) в выдачу; без параметра видны
   *  только включённые. Не boolean-коэрция намеренно, как и у `hot` в clientQuerySchema. */
  showHidden: z.enum(["1"]).optional(),
  page,
  /** Справочник может разрастись за счёт агентов — тот же потолок, что у
   *  инстаграм-ленты, для одной страницы списка в Настройках. */
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});
export type LandmarkQuery = z.infer<typeof landmarkQuerySchema>;

export const securityListQuerySchema = z.object({
  page,
  verdict: z.enum(SECURITY_REVIEW_STATES).optional(),
  /** Фильтр «вина агента, агент на момент потери» (шторка «Фильтры» кабинета СБ):
   *  «1» — только просроченные окна/задачи на момент потери клиента (см.
   *  lib/clientLossFault.ts), «0» — только без вины, нет параметра — все. */
  agentFault: z.enum(["1", "0"]).optional(),
});
export type SecurityListQuery = z.infer<typeof securityListQuerySchema>;
