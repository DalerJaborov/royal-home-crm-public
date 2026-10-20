import type { ClientKind, ClientSource, Currency } from "./enums.js";
import { CLIENT_SOURCE_LABELS } from "./labels.js";

/**
 * ОТОБРАЖАЕМОЕ ИМЯ КЛИЕНТА — «Имя · Якорь», ОДНА ФУНКЦИЯ НА ВЕСЬ ПРОЕКТ.
 *
 * Владелец 21.09.2026, дословно по смыслу: агенты не запоминают клиентов ни по имени,
 * ни по коду карточки (живой пример — ПК-330). Агент Ноза САМА, вручную, дописывает
 * ориентир прямо в поле имени: «Джахонгир Маяковский», «Зоир стадион Спартак»,
 * «Дильноза 112микр» — то есть уже решала ту же задачу, которую эта функция решает
 * автоматически.
 *
 * ЧТО ДЕЛАЕТ:
 *  1. Если fullName — заглушка, которую сама CRM и придумала («Продавец ПР-000388»,
 *     «Покупатель №0155», «Клиент Instagram», голое «Продавец», пусто, один телефон…),
 *     заглушка заменяется на «Роль из Канала» («Продавец из WhatsApp») — канал первого
 *     обращения (Client.source), если он известен, иначе просто роль.
 *  2. Иначе fullName остаётся КАК ЕСТЬ. Здесь намеренно нет попытки угадать, что в
 *     имени — настоящее имя, а что дописанный агентом ориентир («Джахонгир
 *     Маяковский» — два слова, второе не похоже на фамилию… но это ненадёжная
 *     эвристика: у половины клиентов фамилия и правда второе слово). Имя в БД НЕ
 *     МЕНЯЕТСЯ этой функцией и нигде вообще — бот, поиск и шаблоны обращаются к
 *     Client.fullName напрямую (см. grep в отчёте о переносе).
 *  3. Якорь считается ОТДЕЛЬНО, из настоящих полей карточки, а не из текста имени:
 *     продавцу — ориентир/адрес объекта, покупателю — короткое «ищет …». Он
 *     приклеивается через " · ", но только если его текста ЕЩЁ НЕТ в имени
 *     (сравнение без регистра) — иначе «Зоир стадион Спартак · стадион Спартак»
 *     задваивало бы то, что агент уже дописал сам.
 *
 * Живёт в shared, потому что ОДНА функция должна работать и на api (тексты пушей,
 * если понадобятся), и на web (списки, карточка) — раздельные копии неизбежно
 * разошлись бы в трактовке заглушек при первой же правке одной из них.
 */

/** Эмодзи и другие пиктограммы — не текст имени, а разметка, случайно попавшая в него
 *  из мессенджера. Диапазон Extended_Pictographic покрывает подавляющее большинство
 *  практических случаев одним классом, без длинного списка кодов. */
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

function stripEmoji(name: string): string {
  return name.replace(EMOJI_RE, "").replace(/\s{2,}/g, " ").trim();
}

/**
 * ЗАГЛУШКИ ИМЕНИ — то, что сама CRM подставляет вместо настоящего имени, когда его
 * не назвали: «Продавец ПР-000388», «Покупатель ПК-000353», «Продавец №0155»,
 * «Клиент Instagram», голые «Продавец»/«Покупатель»/«Тел», пусто, один телефон.
 *
 * Список короче, чем STUB_NAME_HEAD в format.ts (там задача другая — отрезать роль
 * И ПОКАЗАТЬ остаток), здесь задача «это вообще имя или нет» — весь текст обязан
 * укладываться в шаблон, а не только начинаться с похожего слова, иначе «Продавец
 * приёмки» (настоящее имя из тестовых данных, см. format.ts) тоже стало бы заглушкой.
 */
const STUB_WHOLE_RE =
  /^(прочее обращение|обращение|покупатель|продавец|клиент|тел|телефон|входящий|входящая|входящее|неизвестный|неизвестно)\s*([\s.,:;—–-]*(№\s?\d+|[a-zа-я]{2,3}[-\s]?\d{2,}|instagram|whatsapp|telegram|facebook|tiktok|инстаграм|вотсап|ватсап|телеграм|тикток|сайта?))?\s*$/iu;

/** Только цифры/телефонные символы — «+992 90 000 00 01», «900000001» и т.п. */
const PHONE_ONLY_RE = /^[+\d][\d\s()-]*$/;

function isStubName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (PHONE_ONLY_RE.test(trimmed)) return true;
  return STUB_WHOLE_RE.test(trimmed);
}

/** Роль для замены заглушки — нейтральное «Клиент» для OTHER: не покупатель и не
 *  продавец, но человек, тот же выбор, что уже сделан в CLIENT_NAME_ROLE (format.ts). */
const STUB_ROLE: Record<ClientKind, string> = {
  BUYER: "Покупатель",
  SELLER: "Продавец",
  OTHER: "Клиент",
};

/**
 * «Из <канала>» — короткая фраза для замены заглушки, а НЕ подпись канала саму по
 * себе (та подпись — CLIENT_SOURCE_LABELS, там «Сайт», «Звонок» без предлога).
 * Иностранные названия (Instagram, WhatsApp…) по-русски не склоняются, поэтому «из»
 * подходит им всем без исключения; у остальных источников — своя устойчивая фраза.
 */
const STUB_CHANNEL_PHRASE: Record<ClientSource, string> = {
  WEBSITE: "с сайта",
  INSTAGRAM: "из Instagram",
  FACEBOOK: "из Facebook",
  WHATSAPP: "из WhatsApp",
  TELEGRAM: "из Telegram",
  TIKTOK: "из TikTok",
  GOOGLE_ADS: "из рекламы",
  YANDEX_DIRECT: "из рекламы",
  REFERRAL: "по рекомендации",
  PHONE_CALL: "со звонка",
  WALK_IN: "из офиса",
};

/** Обрезка якоря по СЛОВУ, не по символу — «Маяковского 45 корпус 2, кв…» не должна
 *  обрываться серединой слова. Если после обрезки ничего не осталось (первое же слово
 *  длиннее лимита), режем по символам как крайний случай — лучше кривой якорь, чем
 *  никакого. */
function truncateAnchor(text: string, maxLen = 28): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  const cut = trimmed.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  const byWord = lastSpace > 8 ? cut.slice(0, lastSpace) : cut;
  return `${byWord.trim()}…`;
}

/** Деньги коротко — «800к», «1,2млн» — якорю ~28 символов, полный formatMoney не
 *  влезает. Не претендует на бухгалтерскую точность, это ориентир, не сумма сделки. */
function formatBudgetShort(value: number, currency: Currency): string {
  let amount: string;
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    amount = `${millions % 1 === 0 ? millions : millions.toFixed(1)}млн`;
  } else if (value >= 1_000) {
    amount = `${Math.round(value / 1000)}к`;
  } else {
    amount = String(Math.round(value));
  }
  return currency === "USD" ? `$${amount}` : `${amount} с.`;
}

/** Дополнительные факты для расчёта якоря — то, что caller обязан подобрать САМ
 *  (обычно одним доп. запросом на весь список, см. ниже), потому что Property не
 *  связан с Client прямой Prisma-связью (Property.sellerClientId — просто строка). */
export interface ClientDisplayNameFacts {
  /**
   * Ориентир/адрес объекта ПРОДАВЦА — уже выбранный вызывающим кодом
   * (первый/последний Property.address среди объектов с sellerClientId = client.id).
   * Для одного клиента с несколькими объектами выбор «какой именно» — на совести
   * вызывающего кода; здесь только форматирование.
   */
  propertyAddress?: string | null;
}

export interface ClientDisplayNameInput {
  kind?: ClientKind | null;
  fullName?: string | null;
  source?: ClientSource | null;
  /** Адрес клиента (у покупателя — где живёт, у продавца — запасной вариант якоря). */
  address?: string | null;
  desiredDistrict?: { name?: string | null } | null;
  desiredRooms?: number | null;
  /** Decimal из Prisma сериализуется по-разному — принимаем как есть, здесь только Number(). */
  budgetMax?: unknown;
  currency?: Currency | null;
}

/** Роль + имя без заглушки — общая часть перед приклейкой якоря. */
function resolveNamePart(input: ClientDisplayNameInput): string {
  const raw = stripEmoji((input.fullName ?? "").trim());
  if (!isStubName(raw)) return raw;

  const role = input.kind ? STUB_ROLE[input.kind] : "Клиент";
  const channel = input.source ? STUB_CHANNEL_PHRASE[input.source] : null;
  return channel ? `${role} ${channel}` : role;
}

/** Якорь продавца: ориентир объекта → адрес клиента → район. */
function resolveSellerAnchor(input: ClientDisplayNameInput, facts?: ClientDisplayNameFacts): string | null {
  const raw = facts?.propertyAddress?.trim() || input.address?.trim() || input.desiredDistrict?.name?.trim();
  return raw || null;
}

/** Якорь покупателя: «ищет 2к Сино до 800к с.» — из того, что реально заполнено. */
function resolveBuyerAnchor(input: ClientDisplayNameInput): string | null {
  const words: string[] = ["ищет"];
  if (input.desiredRooms) words.push(`${input.desiredRooms}к`);
  const district = input.desiredDistrict?.name?.trim();
  if (district) words.push(district);
  const budget = Number(input.budgetMax);
  if (Number.isFinite(budget) && budget > 0) {
    words.push(`до ${formatBudgetShort(budget, input.currency ?? "TJS")}`);
  }
  return words.length > 1 ? words.join(" ") : null;
}

function resolveAnchor(input: ClientDisplayNameInput, facts?: ClientDisplayNameFacts): string | null {
  if (input.kind === "SELLER") return resolveSellerAnchor(input, facts);
  if (input.kind === "BUYER") return resolveBuyerAnchor(input);
  return null;
}

/**
 * Отображаемое имя клиента — «Имя · Якорь» (якорь может отсутствовать).
 *
 * `facts` необязателен: без него функция всё ещё честно отрабатывает заглушки и
 * покупательский якорь (он целиком из полей client), просто у продавца якорь будет
 * не из Property.address, а сразу из Client.address/района — тот же порядок
 * приоритета, только без первого шага.
 */
export function clientDisplayName(input: ClientDisplayNameInput, facts?: ClientDisplayNameFacts): string {
  const namePart = resolveNamePart(input) || (input.kind ? STUB_ROLE[input.kind] : "Клиент без имени");
  const anchor = resolveAnchor(input, facts);
  if (!anchor) return namePart;

  // Якорь агент мог уже дописать в само имя («Зоир стадион Спартак») — угадывать,
  // какая часть имени это дописка, мы не пытаемся (см. шапку файла), но хотя бы не
  // дублируем, если текст якоря буквально уже есть в имени.
  if (namePart.toLowerCase().includes(anchor.toLowerCase())) return namePart;

  return `${namePart} · ${truncateAnchor(anchor)}`;
}
