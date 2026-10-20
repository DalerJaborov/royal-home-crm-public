/**
 * ДОСЬЕ СОБЕСЕДНИКА — общий словарь для сервера и экрана «Чаты».
 *
 * Зачем оно вообще (владелец, 18 и 21.09.2026): бот «не помнит» человека. Сегодня
 * всё, что он знает, живёт в черновике ОДНОГО диалога (`leadDraft`) и в переписке,
 * которая уходит в модель обрезанной. Написал тот же человек из другого канала —
 * для бота это новый незнакомец; вернулся через неделю — имя и номер он уже
 * спрашивает заново. Карточка `Client` не спасает: она появляется только когда лид
 * оформлен, то есть после телефона и готовности, а до этого момента человека для
 * CRM не существует вовсе.
 *
 * Досье заводится на ПЕРВОМ входящем сообщении в любом канале, до карточки клиента
 * и независимо от того, станет ли человек лидом (включая спам). Один человек — одна
 * строка; идентификаторы каналов лежат отдельно (`ContactIdentity`) с уникальностью
 * пары «вид + значение»: тот же приём, что `Client.phone @unique`, и именно он
 * гарантирует, что второго досье по тому же идентификатору не бывает.
 *
 * Здесь только СЛОВАРЬ: коды категорий, виды идентификаторов, степень доверия к
 * ним и схема фактов. Логика — в `apps/api/src/lib/contactProfiles.ts`.
 *
 * Разбор и решения: docs/contact-profile-and-bot-roles-20-09.md.
 */

import { z } from "zod";

/**
 * КАТЕГОРИЯ СОБЕСЕДНИКА — кто это в понимании бота.
 *
 * Строковые коды, а не enum базы, НАМЕРЕННО: список расширяется (владелец просил
 * «типы обращений должны расти»), а новый enum в Postgres — это миграция на каждое
 * слово. Тот же приём уже применён к решению маршрутизации и к манерам продажи.
 */
export const CONTACT_CATEGORIES = [
  /** Ещё не понятно — так заводится каждое новое досье. */
  "UNKNOWN",
  /** Покупает или снимает жильё. */
  "BUYER",
  /** Продаёт или сдаёт свой объект. */
  "SELLER",
  /** Ищет работу у нас. */
  "JOB",
  /** Застройщик, агентство, партнёр — разговор про сотрудничество. */
  "PARTNER",
  /** Уже наш клиент по текущей сделке: вопросы по документам, показам, оплате. */
  "CLIENT_CARE",
  /** Предлагает нам услуги или товары (ремонт, реклама, мебель). */
  "VENDOR",
  /** Реклама, рассылка, накрутка — отвечать не нужно. */
  "SPAM",
  /** Ошиблись адресом, личное, не про недвижимость. */
  "OTHER",
] as const;
export type ContactCategory = (typeof CONTACT_CATEGORIES)[number];

/** Подписи для интерфейса. Обычными словами: их читает владелец, а не инженер. */
export const CONTACT_CATEGORY_LABELS: Record<ContactCategory, string> = {
  UNKNOWN: "Пока не понятно",
  BUYER: "Покупатель",
  SELLER: "Продавец",
  JOB: "Ищет работу",
  PARTNER: "Партнёр",
  CLIENT_CARE: "Наш клиент",
  VENDOR: "Предлагает услуги",
  SPAM: "Спам",
  OTHER: "Другое",
};

export function isContactCategory(value: string): value is ContactCategory {
  return (CONTACT_CATEGORIES as readonly string[]).includes(value);
}

/** Неизвестный код из базы не должен ронять экран: показываем как есть. */
export function contactCategoryLabel(value: string): string {
  return isContactCategory(value) ? CONTACT_CATEGORY_LABELS[value] : value;
}

/**
 * ВИД ИДЕНТИФИКАТОРА. `PHONE` хранится хвостом из 9 цифр — тем же, каким CRM уже
 * узнаёт клиента по номеру (`lib/clientPhones.ts`), иначе «+992 90 123-45-67» и
 * «992901234567» были бы двумя разными людьми.
 */
export const CONTACT_IDENTITY_KINDS = [
  "PHONE",
  "WA_ID",
  "IG_ID",
  "FB_PSID",
  "TG_CHAT_ID",
  "TG_DM_TOPIC",
  "TG_USERNAME",
  "IG_USERNAME",
  "EMAIL",
  /**
   * Посетитель чата на сайте. Слабее остальных «транспортных» признаков: это
   * браузер, а не человек — с телефона тот же продавец придёт новым посетителем.
   * Но без него написавший в виджет сайта вообще не получал бы досье, а именно
   * он чаще всего и диктует номер в первом же сообщении.
   */
  "WEB_SESSION",
  /**
   * Автор комментария на YouTube (snippet.authorChannelId.value из Data API v3,
   * messengers/youtubeComments.ts). Добавлено 24.09.2026 (находка ночной проверки,
   * Б8): у YouTube нет личных сообщений вовсе, и без собственного вида
   * идентификатора identitiesForMessengerChannel возвращала для этого канала
   * пустой список — досье комментатору завести было не на чем.
   */
  "YT_CHANNEL_ID",
] as const;
export type ContactIdentityKind = (typeof CONTACT_IDENTITY_KINDS)[number];

/**
 * НАСКОЛЬКО ИДЕНТИФИКАТОРУ МОЖНО ВЕРИТЬ. Отсюда растёт главное правило связывания
 * каналов: автоматически связывать можно ТОЛЬКО то, что подтвердил сам канал.
 *
 *  - `TRANSPORT` — пришло от канала и подделать это человек не может: wa_id,
 *    определившийся номер звонящего, chatId Telegram, IGSID.
 *  - `STATED` — человек назвал сам: напечатал номер в чате, прислал визитку.
 *    Ровно здесь живёт риск перепутать двух людей (продавец диктует номер жены,
 *    агент пересылает чужой контакт), поэтому такое идёт не в связку, а в
 *    предложение «похоже, это тот же человек» для администратора.
 *  - `PROFILE` — имя или ник из профиля канала: слабее всего, только подсказка.
 */
export const CONTACT_IDENTITY_TRUST = ["TRANSPORT", "STATED", "PROFILE"] as const;
export type ContactIdentityTrust = (typeof CONTACT_IDENTITY_TRUST)[number];

/**
 * Откуда взято имя. Важно: обращаться бот может ТОЛЬКО тем, что человек назвал
 * сам (`self`) или прислал визиткой (`vcard`).
 *
 *  - `profile` — имя или ник из профиля канала;
 *  - `crm` — ФИО из карточки клиента, вбитое сотрудником (правка 22.09.2026).
 *    Раньше такое имя записывалось как `self`, и бот здоровался служебной
 *    пометкой из карточки: «Здравствуйте, Далер (брат Умеда, звонить после 18)».
 *    Карточку заполняет агент для СЕБЯ, а не для обращения к человеку.
 */
export const CONTACT_NAME_SOURCES = ["self", "vcard", "profile", "crm"] as const;
export type ContactNameSource = (typeof CONTACT_NAME_SOURCES)[number];

/**
 * ОДИН ФАКТ О ЧЕЛОВЕКЕ вместе с происхождением. Без происхождения досье через
 * месяц превращается в свалку утверждений, которую нельзя ни проверить, ни
 * состарить: непонятно, кто это сказал и когда.
 */
export const contactFactSchema = z.object({
  /** Значение. Строка, число или «да/нет» — больше в факте ничего не бывает. */
  v: z.union([z.string(), z.number(), z.boolean()]),
  /** Когда узнали, ISO. */
  at: z.string(),
  /** Кто узнал: "model" — из ответа модели, "guard" — правилом в коде, "agent" — человек. */
  src: z.enum(["model", "guard", "agent"]),
  /** В каком разговоре — чтобы можно было пойти и перечитать. */
  conv: z.string().optional(),
});
export type ContactFact = z.infer<typeof contactFactSchema>;

/**
 * ФАКТЫ ПО ОБЛАСТЯМ. Область — не то же самое, что категория: человек может
 * сегодня продавать, а через месяц покупать, и прошлое при смене категории НЕ
 * стирается (прямое требование владельца). Поэтому разделы живут рядом, а не
 * сменяют друг друга.
 */
export const contactFactsSchema = z.object({
  /** Версия схемы: досье переживёт не одну правку, и читателю нужно знать формат. */
  version: z.literal(1).default(1),
  buyer: z.record(z.string(), contactFactSchema).default({}),
  seller: z.record(z.string(), contactFactSchema).default({}),
  job: z.record(z.string(), contactFactSchema).default({}),
  misc: z.record(z.string(), contactFactSchema).default({}),
});
export type ContactFacts = z.infer<typeof contactFactsSchema>;

/** Области фактов — перечислением, чтобы читатели не писали строки руками. */
export const CONTACT_FACT_DOMAINS = ["buyer", "seller", "job", "misc"] as const;
export type ContactFactDomain = (typeof CONTACT_FACT_DOMAINS)[number];

/** Пустое досье фактов. */
export function emptyContactFacts(): ContactFacts {
  return { version: 1, buyer: {}, seller: {}, job: {}, misc: {} };
}

/**
 * Прочитать факты из базы, не веря тому, что там лежит. Досье пишут несколько
 * мест и переживут не одну правку схемы: битое или устаревшее значение обязано
 * дать пустое досье, а не уронить ответ клиенту.
 */
export function parseContactFacts(raw: unknown): ContactFacts {
  const parsed = contactFactsSchema.safeParse(raw);
  return parsed.success ? parsed.data : emptyContactFacts();
}

/**
 * То же чтение, но с ответом на вопрос «а было ли там что-нибудь» (22.09.2026).
 *
 * `parseContactFacts` возвращает пустое досье и на пустое поле, и на битое — для
 * ЧТЕНИЯ это правильно: бот не должен падать из-за формата. Но тот, кто потом
 * пишет результат ОБРАТНО целым полем, этими двумя случаями различать обязан:
 * иначе поднятая `version` (или одна кривая запись) означает, что первое же
 * сообщение каждого человека затрёт накопленное за месяцы, молча и безвозвратно.
 *
 * `recognized: false` — в поле лежало что-то непустое, чего мы не понимаем.
 * Писать поверх такого нельзя, это надо разбирать руками.
 */
export function readContactFacts(raw: unknown): { facts: ContactFacts; recognized: boolean } {
  const parsed = contactFactsSchema.safeParse(raw);
  if (parsed.success) return { facts: parsed.data, recognized: true };
  const empty = raw == null || (typeof raw === "object" && Object.keys(raw as object).length === 0);
  return { facts: emptyContactFacts(), recognized: empty };
}

/** Одна запись в истории смен категории. */
export const contactCategoryHistoryEntrySchema = z.object({
  category: z.string(),
  at: z.string(),
  source: z.enum(["model", "guard", "agent"]),
  conv: z.string().optional(),
});
export type ContactCategoryHistoryEntry = z.infer<typeof contactCategoryHistoryEntrySchema>;

export const contactCategoryHistorySchema = z.array(contactCategoryHistoryEntrySchema).default([]);

export function parseContactCategoryHistory(raw: unknown): ContactCategoryHistoryEntry[] {
  const parsed = contactCategoryHistorySchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

/**
 * Намерение, которое вернула модель в этом ходе → категория досье.
 *
 * Категория — то, кем человек является вообще; намерение — о чём он говорит
 * сейчас. Поэтому перевод односторонний: намерение может уточнить категорию, но
 * «other» в этом ходе не делает человека «другим» навсегда — за это отвечает
 * вызывающий код, а не таблица.
 */
export function categoryFromIntent(intent: string): ContactCategory | null {
  switch (intent) {
    case "buy":
    case "rent":
      return "BUYER";
    case "sell":
      return "SELLER";
    case "job":
      return "JOB";
    default:
      return null;
  }
}

/**
 * «Кто пишет» из ответа модели → категория досье.
 *
 * Коды совпадают по построению (см. `WHO_IS_THIS` в `apps/api/src/ai/botContract.ts`):
 * два словаря про одно и то же разъехались бы на первой правке, поэтому перевод —
 * это проверка кода, а не таблица соответствий. Смысл функции в отсечении:
 * `UNKNOWN` — это «модель не поняла», и записывать его в досье нельзя, иначе
 * категория, поставленная раньше или руками агента, стиралась бы каждым невнятным
 * сообщением.
 */
export function categoryFromWhoIsThis(who: string): ContactCategory | null {
  if (who === "UNKNOWN") return null;
  return isContactCategory(who) ? who : null;
}

/** Категория досье → тип карточки CRM. Категорий больше, чем типов карточки. */
export function clientKindFromCategory(category: string): "BUYER" | "SELLER" | "OTHER" {
  switch (category) {
    case "BUYER":
      return "BUYER";
    case "SELLER":
      return "SELLER";
    default:
      return "OTHER";
  }
}

/** Счётчики языка по входящим сообщениям: {tg: n, ru: n, en: n}. */
export const contactLanguageCountsSchema = z.record(z.string(), z.number()).default({});
export type ContactLanguageCounts = z.infer<typeof contactLanguageCountsSchema>;

export function parseContactLanguageCounts(raw: unknown): ContactLanguageCounts {
  const parsed = contactLanguageCountsSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

/**
 * Какой язык считать языком человека. Берём самый частый; при равенстве —
 * молчим (null), потому что «угадал и обратился не на том языке» хуже, чем
 * «спросил на языке последнего сообщения».
 */
export function dominantLanguage(counts: ContactLanguageCounts): string | null {
  let best: string | null = null;
  let bestCount = 0;
  let tie = false;
  for (const [lang, count] of Object.entries(counts)) {
    if (lang === "unknown" || count <= 0) continue;
    if (count > bestCount) {
      best = lang;
      bestCount = count;
      tie = false;
    } else if (count === bestCount) {
      tie = true;
    }
  }
  return tie ? null : best;
}

/**
 * ПОДПИСИ КЛЮЧЕЙ ФАКТОВ — одни на промт бота и на экран.
 *
 * Лежали приватными в `apps/api/src/lib/contactProfileMemory.ts` и годились
 * только промту. Досье теперь читает и человек (панель собеседника в «Чатах»),
 * а вторая копия подписей разъехалась бы с первой на первом же новом ключе:
 * бот говорил бы «бюджет от», экран — «мин. бюджет», и владелец решил бы, что
 * это два разных факта. Формулировки перенесены дословно — промт обязан
 * остаться побайтово прежним.
 */
export const CONTACT_BUYER_FACT_LABELS: Record<string, string> = {
  intent: "обращение",
  budgetMin: "бюджет от",
  budgetMax: "бюджет до",
  budgetUnrealistic: "называл сумму",
  districtName: "район",
  type: "тип жилья",
  rooms: "комнат",
  locationOutsideDushanbe: "объект вне Душанбе",
  locationDifferentCountry: "объект вне Таджикистана",
};

export const CONTACT_INTENT_LABELS: Record<string, string> = {
  buy: "покупка",
  rent: "аренда",
  sell: "продажа",
  job: "работа",
  other: "другое",
};

/** Те же ключи, что у `ai/sellerIntake.ts`, но подписи здесь свои — «уже называл». */
export const CONTACT_SELLER_FACT_LABELS: Record<string, string> = {
  district: "район",
  rooms: "комнаты",
  area: "площадь",
  floor: "этаж",
  condition: "состояние",
  price: "цену",
};

export const CONTACT_JOB_FACT_LABELS: Record<string, string> = {
  name: "имя",
  position: "должность",
  experience: "опыт",
  education: "образование",
  age: "возраст",
  city: "город",
  languages: "языки",
  startWhen: "готов выйти",
  hasCar: "есть машина",
  strongMotivation: "сильно хочет работать",
  achievements: "достижения",
  studyingNow: "сейчас учится",
  studyingUniversity: "учится в вузе",
  employedNow: "сейчас работает",
  phoneGiven: "номер уже дал",
  cvSent: "резюме прислал",
  summary: "рассказ о себе",
};

/** Подписи области фактов. `misc` своих ключей не имеет — показываем ключ как есть. */
export const CONTACT_FACT_LABELS: Record<ContactFactDomain, Record<string, string>> = {
  buyer: CONTACT_BUYER_FACT_LABELS,
  seller: CONTACT_SELLER_FACT_LABELS,
  job: CONTACT_JOB_FACT_LABELS,
  misc: {},
};

/** Заголовки областей на экране. */
export const CONTACT_FACT_DOMAIN_LABELS: Record<ContactFactDomain, string> = {
  buyer: "Покупка и аренда",
  seller: "Свой объект",
  job: "Анкета кандидата",
  misc: "Прочее",
};

/** Кто узнал факт — словами для экрана. */
export const CONTACT_FACT_SOURCE_LABELS: Record<ContactFact["src"], string> = {
  model: "из разговора",
  guard: "правилом",
  agent: "внёс сотрудник",
};

/**
 * ОДИН ФАКТ ДЛЯ ЭКРАНА. Значение форматирует сервер, а не браузер: то же
 * значение печатается в промт бота, и расхождение между «что видит агент» и
 * «что читает бот» — ровно тот разрыв, ради которого панель и делается.
 */
export interface ContactFactView {
  key: string;
  label: string;
  value: string;
  at: string;
  src: ContactFact["src"];
  conv?: string;
}

/** Досье собеседника так, как его отдаёт API и рисует панель в «Чатах». */
export interface ContactProfileView {
  id: string;
  displayName: string | null;
  nameSource: ContactNameSource | null;
  category: ContactCategory;
  categorySetAt: string | null;
  /** Последние пять смен, новые сверху. Прошлое не стирается (решение владельца). */
  categoryHistory: { category: ContactCategory; label: string; at: string; src: ContactFact["src"] }[];
  language: string | null;
  /** Через `clientPhoneFor` — без права `clients.viewPhone` приходит маской. */
  primaryPhone: string | null;
  phonesCount: number;
  /** `channel` — null без права `clients.viewOrigin`. */
  channels: { channel: string | null; conversations: number; lastAt: string }[];
  firstSeenAt: string;
  lastSeenAt: string;
  inboundMessages: number;
  client: { id: string; shortId: number; kind: string; status: string; agentName: string | null } | null;
  facts: Record<ContactFactDomain, ContactFactView[]>;
  /** Все диалоги этого человека; id в формате инбокса (с префиксом `tg_`). */
  conversations: { id: string; channel: string | null; lastMessageAt: string | null; messages: number }[];
  /** Кандидаты на слияние — только с правом `clients.merge`. */
  pendingLinks: {
    id: string;
    otherProfile: { id: string; displayName: string | null; category: ContactCategory };
    reason: string;
  }[];
}
