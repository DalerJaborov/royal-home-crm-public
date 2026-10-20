import { z } from "zod";

/**
 * Воронка «комментарий → чек-лист в директ»: общий словарь сервера и экрана.
 *
 * Схема одна на обе стороны нарочно. Половина полей здесь — тексты, которые
 * уходят в Instagram, и ограничения на них ставит не наш вкус, а Meta: подпись
 * кнопки длиннее двадцати знаков она просто отвергает, а узнать об этом на живой
 * рекламе — значит потерять лидов молча. Пусть форма не даёт сохранить то, что
 * всё равно не отправится.
 */

/** Подпись быстрой кнопки в Instagram — жёсткий предел Meta, не наш выбор. */
export const QUICK_REPLY_TITLE_MAX = 20;

/** Предел длины сообщения в Instagram Direct. */
export const IG_MESSAGE_MAX = 1000;

/**
 * ТЕКСТ ПОД КНОПКОЙ — НЕ ДЛИННЕЕ 80 ЗНАКОВ (владелец 17.08.2026).
 *
 * Сообщения с кнопкой Meta шлёт карточкой, а у карточки жёсткие рамки: 80 знаков
 * заголовку и 80 подзаголовку. Длинный текст приходится резать пополам, и хвост
 * повисает над кнопкой отдельной серой строкой — владелец увидел это на живом
 * клиенте: «...ба тугмаи зерин» / «пахш кунед». Некрасиво и непонятно.
 *
 * Поэтому шаги воронки, у которых ЕСТЬ кнопка (приглашение и просьба
 * подписаться), ограничены одной строкой карточки. Остальные тексты — обычные
 * сообщения без кнопок, и их предел прежний.
 */
export const IG_CARD_TEXT_MAX = 80;

/** PDF в личное сообщение Instagram — до 25 МБ. */
export const LEAD_MAGNET_FILE_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Название кампании. Видит только владелец, в Instagram оно не уходит — предел
 * наш, чтобы список кампаний оставался читаемым.
 *
 * Экспортировано ради дублирования кампании (POST /lead-magnets/:id/duplicate):
 * оно дописывает к названию « (копия)» и обязано обрезать результат ровно по
 * той же мерке, иначе копия сохранялась бы в обход формы и переставала
 * проходить её же проверку при первом «Сохранить».
 */
export const LEAD_MAGNET_NAME_MAX = 80;

/** Где человек сейчас в воронке. */
export const LEAD_MAGNET_STATES = ["INVITED", "AWAITING_FOLLOW", "DELIVERED", "FAILED"] as const;
export type LeadMagnetState = (typeof LEAD_MAGNET_STATES)[number];

export const LEAD_MAGNET_STATE_LABELS: Record<LeadMagnetState, string> = {
  INVITED: "Написали в директ",
  AWAITING_FOLLOW: "Просим подписаться",
  DELIVERED: "Файл отдан",
  FAILED: "Не дошло",
};

const text = (max: number) => z.string().trim().min(1).max(max);

/**
 * Ключевое слово. Пробелы по краям срезаем, пустые строки не принимаем: пустое
 * слово совпало бы с любым комментарием и превратило бы кампанию с ключевым
 * словом в кампанию «на всё подряд» — молча и незаметно для владельца.
 */
const keyword = z.string().trim().min(2).max(60);

export const leadMagnetCampaignInputSchema = z
  .object({
    name: text(LEAD_MAGNET_NAME_MAX),
    enabled: z.boolean().default(false),
    /**
     * Аккаунт Instagram, чьи комментарии ловит кампания (17.08.2026).
     *
     * Пусто — «любой аккаунт», прежнее поведение: кампании, заведённые до
     * появления поля, обязаны работать без правки руками. Заполнено — комментарии
     * остальных аккаунтов эта кампания не видит, и соавторский пост, доставленный
     * в вебхуки обоих аккаунтов, перестаёт рассылать по два приглашения.
     */
    accountId: z.guid().nullish(),
    /** Адрес публикации в Instagram; пусто — ловим под любой нашей публикацией. */
    postUrl: z.string().trim().max(500).nullish(),
    /**
     * ЕЩЁ публикации той же кампании (просьба владельца 30.08.2026: «хочу в одну
     * кампанию добавлять несколько ссылок»). Раньше на каждый ролик заводили копию
     * кампании — и копии расходились настройками, а человек, написавший под двумя
     * роликами, получал два приглашения.
     */
    postUrls: z.array(z.string().trim().max(500)).max(20).default([]),
    keywords: z.array(keyword).max(20).default([]),
    anyComment: z.boolean().default(false),
    publicReplies: z.array(text(280)).max(10).default([]),
    // С кнопкой — карточка, у неё своя короткая рамка (см. IG_CARD_TEXT_MAX).
    inviteText: text(IG_CARD_TEXT_MAX),
    inviteButton: text(QUICK_REPLY_TITLE_MAX),
    requireFollow: z.boolean().default(true),
    /** Требовать подписку на ВСЕ наши аккаунты Instagram, а не только на «свой». */
    requireFollowAll: z.boolean().default(false),
    followText: text(IG_CARD_TEXT_MAX),
    followButton: text(QUICK_REPLY_TITLE_MAX),
    notFollowingText: text(IG_CARD_TEXT_MAX),
    maxFollowChecks: z.number().int().min(1).max(10).default(3),
    deliverIfUnsure: z.boolean().default(true),
    /** Второе «я подписался» открывает выдачу, даже если Instagram подписки не видит. */
    deliverOnSecondClaim: z.boolean().default(false),
    deliveredText: text(IG_MESSAGE_MAX),
    /** Запасная ссылка на файл — уходит, если файла нет или Meta его не приняла. */
    link: z.string().trim().url().max(500).nullish(),
    handoffToBot: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    // Кампания без единого ключевого слова и без «любого комментария» не
    // сработает НИ РАЗУ. Молча включённая пустая кампания — худший исход:
    // владелец запускает рекламу и ждёт лидов, которых не будет.
    if (!v.anyComment && v.keywords.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keywords"],
        message: "Добавьте ключевое слово или включите ответ на любой комментарий",
      });
    }
    // Ловить любой комментарий под ВСЕМИ публикациями сразу — это писать в директ
    // каждому, кто вообще что-то написал под любым нашим постом. Так теряют аккаунт.
    if (v.anyComment && !v.postUrl?.trim() && v.postUrls.every((u) => !u.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["postUrl"],
        message: "Для ответа на любой комментарий укажите публикацию — иначе воронка сработает под всеми постами",
      });
    }
  });

export type LeadMagnetCampaignInput = z.input<typeof leadMagnetCampaignInputSchema>;

/** Кампания в том виде, в каком её отдаёт сервер. */
export interface LeadMagnetCampaign {
  id: string;
  name: string;
  enabled: boolean;
  /** Аккаунт Instagram, чьи комментарии ловит кампания. null — любой (прежнее
   *  поведение; так выглядят все кампании, заведённые до 17.08.2026). */
  accountId: string | null;
  postUrl: string | null;
  mediaId: string | null;
  postUrls: string[];
  mediaIds: string[];
  requireFollowAll: boolean;
  deliverOnSecondClaim: boolean;
  keywords: string[];
  anyComment: boolean;
  publicReplies: string[];
  inviteText: string;
  inviteButton: string;
  requireFollow: boolean;
  followText: string;
  followButton: string;
  notFollowingText: string;
  maxFollowChecks: number;
  deliverIfUnsure: boolean;
  deliveredText: string;
  filePath: string | null;
  fileName: string | null;
  fileSize: number | null;
  link: string | null;
  handoffToBot: boolean;
  createdAt: string;
  updatedAt: string;
  /** Счётчики воронки: сколько человек дошло до каждой ступени. */
  stats: LeadMagnetStats;
}

export interface LeadMagnetStats {
  /** Всего людей, которым ушло приглашение. */
  invited: number;
  /** Из них сейчас ждут подписки. */
  awaitingFollow: number;
  /** Получили файл или ссылку. */
  delivered: number;
  /** Не дошло — записан отказ. */
  failed: number;
  /**
   * Сколько из получивших дошли до карточки клиента: бот довёл разговор до
   * телефона. Главное число кампании — остальные меряют работу воронки, это
   * меряет её пользу.
   */
  leads: number;
}

/** Строка журнала выдач. */
export interface LeadMagnetDelivery {
  id: string;
  campaignId: string;
  campaignName: string;
  igUserId: string;
  username: string | null;
  commentText: string | null;
  state: LeadMagnetState;
  followChecks: number;
  wasFollowing: boolean | null;
  deliveredAsFile: boolean | null;
  /** Карточка клиента, если разговор дошёл до телефона (берётся из диалога). */
  clientId: string | null;
  clientShortId: number | null;
  invitedAt: string;
  deliveredAt: string | null;
  lastError: string | null;
}

/**
 * Тексты по умолчанию — то, что подставляется в форму новой кампании.
 *
 * Здесь, а не в компоненте: ровно те же строки нужны серверу, когда кампания
 * заводится не из формы (сид, перенос), и разъехавшиеся копии текста, который
 * читает клиент, — это две разные воронки под одним названием.
 */
export const LEAD_MAGNET_DEFAULTS = {
  /**
   * ТЕКСТЫ С КНОПКОЙ — В ОДНУ СТРОКУ КАРТОЧКИ (владелец 17.08.2026).
   *
   * Прежние были вдвое длиннее, и Meta резала их пополам: хвост «пахш кунед»
   * повисал над кнопкой отдельной серой строкой. Смысл при сокращении не потерян
   * — сама кнопка и говорит, что делать, а повторять это словами незачем.
   */
  inviteText: "Здравствуйте! Чек-лист готов — заберите его по кнопке ниже.",
  inviteButton: "Хочу чек-лист",
  // Прямо и без упрёка: человек не сделал ничего плохого, он просто ещё не
  // подписан. «Мы дарим подписчикам» звучало как условие сделки, а не как
  // понятный шаг, и на этом месте люди отваливаются чаще всего.
  followText: "Чек-лист отправляем подписчикам. Подпишитесь — и заберите по кнопке.",
  followButton: "Я подписался",
  notFollowingText: "Подписки пока не вижу. Проверьте, пожалуйста, и нажмите ещё раз.",
  deliveredText: "Готово! Вот ваш чек-лист. Если появятся вопросы по квартирам — пишите сюда, помогу.",
} as const;

/**
 * Совпало ли ключевое слово с комментарием.
 *
 * По ВХОЖДЕНИЮ и без учёта регистра: человек под рекламой пишет не «ЧЕКЛИСТ», а
 * «хочу чеклист пожалуйста» или «Чек-лист!». Точное совпадение отсекало бы почти
 * всех, а именно они и есть оплаченные рекламой лиды.
 *
 * Дефисы, пробелы и подчёркивания внутри слова убираются с обеих сторон: «чек-лист»,
 * «чек лист» и «чеклист» для человека одно и то же слово, и владелец не обязан
 * перечислять все три написания.
 *
 * Чистая функция и экспортирована ради теста: правило отбора решает, кому уйдёт
 * личное сообщение, а проверять это на живых подписчиках нельзя.
 */
export function matchesKeyword(commentText: string, keywords: readonly string[]): boolean {
  const haystack = normalizeForMatch(commentText);
  if (!haystack) return false;
  return keywords.some((k) => {
    const needle = normalizeForMatch(k);
    return needle.length > 0 && haystack.includes(needle);
  });
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[\s\-_.]+/g, "");
}
