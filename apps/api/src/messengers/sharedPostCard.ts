import { prisma } from "../db.js";
import { describeMedia } from "../ai/geminiMedia.js";
import { fetchAttachments, type AttachmentSource } from "./attachments.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { BW, EW, TAIL } from "../ai/wordBoundary.js";

/**
 * НАШ ПОСТ БЕЗ ССЫЛКИ: УЗНАТЬ ОБЪЕКТ ПО ТОМУ, ЧТО НА НЁМ НАПИСАНО (02.10.2026).
 *
 * Жалоба владельца 02.10: клиент переслал в директ наш же пост «7 хонага,
 * 1 221 000 TJS, 163,2 м²», а бот ответил «видео у меня не открылось». Всё
 * узнавание стояло на коде поста из адреса, а Meta всё чаще присылает вместо
 * адреса поста ссылку на свой CDN, где кода нет.
 *
 * Здесь три запасных пути, от точного к общему, и все три отвечают «один объект
 * или ничего» — гадать нельзя, ошибка означает чужую цену в ответе клиенту и лид
 * не тому агенту:
 *  1. подпись под постом совпала с подписью, которую CRM сама опубликовала
 *     (Property.reelsCaption);
 *  2. в подписи названы цена и площадь (или комнаты) — ровно один объект с ними;
 *  3. подписи нет вовсе — читаем надписи с самой карточки на картинке (Gemini) и
 *     ищем так же, как в п. 2.
 */

export interface PropertyFacts {
  price?: number;
  currency?: "USD" | "TJS";
  areaSqm?: number;
  rooms?: number;
}

const WITH_DISTRICT = { district: { select: { name: true } } } as const;

/** Число вида «1 221 000», «1.221.000», «62,000» или «420000» → 1221000. */
function parseBigNumber(raw: string): number | null {
  const digits = raw.replace(/[\s  .,']/g, "");
  if (!/^\d+$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

const NUM = String.raw`(\d{1,3}(?:[\s  .,']\d{3})+|\d{4,})`;
const TJS_WORD = String.raw`(?:TJS|сомон\p{L}*|сомони|смн|сом\.|с\.)`;
const USD_WORD = String.raw`(?:USD|\$|долл\p{L}*|у\.?\s?е\.?)`;
const PRICE_AFTER = new RegExp(`${NUM}\\s*(${TJS_WORD}|${USD_WORD})`, "giu");
const PRICE_BEFORE = new RegExp(`(\\$|USD)\\s*${NUM}`, "giu");
const AREA_RE = /(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:м²|м2|m²|m2|кв\.?\s*м|метр\p{L}*\s*квадрат)/iu;
/** «7 хонага», «3-комнатная», «2 ҳуҷрагӣ». `\b` по кириллице молчит — поэтому без него. */
const ROOMS_RE = /(?:^|[^\d])(\d{1,2})\s*[-–]?\s*(?:хонаг\p{L}*|хонаги|ҳуҷраг\p{L}*|хучраг\p{L}*|комн\p{L}*|xonag\p{L}*)/iu;

/**
 * Цена, валюта, площадь и комнаты из свободного текста — подписи под постом или
 * надписей с карточки. Цена — САМОЕ БОЛЬШОЕ число с валютой: рядом бывают «от
 * 5 000 в месяц» и телефон, а цена квартиры всегда крупнее.
 */
export function parsePropertyFacts(text: string | undefined | null): PropertyFacts {
  if (!text) return {};
  const facts: PropertyFacts = {};
  let best: { value: number; currency: "USD" | "TJS" } | null = null;
  for (const m of text.matchAll(PRICE_AFTER)) {
    const value = parseBigNumber(m[1]!);
    if (value == null || value < 1000) continue;
    const currency = new RegExp(`^${USD_WORD}$`, "iu").test(m[2]!.trim()) ? "USD" : "TJS";
    if (!best || value > best.value) best = { value, currency };
  }
  for (const m of text.matchAll(PRICE_BEFORE)) {
    const value = parseBigNumber(m[2]!);
    if (value == null || value < 1000) continue;
    if (!best || value > best.value) best = { value, currency: "USD" };
  }
  if (best) {
    facts.price = best.value;
    facts.currency = best.currency;
  }
  const area = text.match(AREA_RE);
  if (area) {
    const value = Number(area[1]!.replace(",", "."));
    if (Number.isFinite(value) && value >= 10 && value <= 5000) facts.areaSqm = value;
  }
  const rooms = text.match(ROOMS_RE);
  if (rooms) {
    const value = Number(rooms[1]);
    if (value >= 1 && value <= 20) facts.rooms = value;
  }
  return facts;
}

/** Ровно один объект с этими ценой и площадью (или комнатами), иначе null. */
export async function matchPropertyByFacts(facts: PropertyFacts) {
  if (facts.price == null || (facts.areaSqm == null && facts.rooms == null)) return null;
  const candidates = await prisma.property.findMany({
    where: {
      deletedAt: null,
      // Полпроцента допуска: на карточке цену иногда округляют («1 221 000» при
      // 1 220 500 в карточке), а больше нельзя — соседний объект того же дома.
      price: { gte: facts.price * 0.995, lte: facts.price * 1.005 },
      ...(facts.currency ? { currency: facts.currency } : {}),
    },
    include: WITH_DISTRICT,
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const fit = candidates.filter((p) => {
    if (facts.areaSqm != null) {
      const area = Number(p.areaSqm);
      if (Math.abs(area - facts.areaSqm) > Math.max(1, facts.areaSqm * 0.01)) return false;
    }
    if (facts.rooms != null && p.rooms != null && p.rooms !== facts.rooms) return false;
    return true;
  });
  if (fit.length === 1) return fit[0]!;
  // Два одинаковых по цене и площади — бывает у проданного и его двойника в
  // продаже. Тогда побеждает тот, что в продаже, но только если он один.
  const selling = fit.filter((p) => p.status === "AVAILABLE" || p.status === "RESERVED");
  return selling.length === 1 ? selling[0]! : null;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Подпись пересланного поста совпала с подписью, которую опубликовала сама CRM.
 *
 * Ищем по первой содержательной строке (дешёвый запрос по базе), а решаем по всей
 * подписи: первые строки у шаблонов подписей общие («🏢 Просторная резиденция…»),
 * и совпадение одной строки ещё ничего не значит.
 */
export async function matchPropertyByCaption(caption: string | undefined | null) {
  const full = caption?.trim();
  if (!full || full.length < 40) return null;
  const firstLine = full
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length >= 15);
  if (!firstLine) return null;
  const candidates = await prisma.property.findMany({
    where: { deletedAt: null, reelsCaption: { contains: firstLine.slice(0, 120) } },
    include: WITH_DISTRICT,
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const want = collapse(full);
  const same = candidates.filter((p) => {
    const have = collapse(p.reelsCaption ?? "");
    // Meta иногда обрезает длинную подпись — тогда наша начинается с присланной.
    return have === want || (want.length >= 80 && have.startsWith(want));
  });
  return same.length === 1 ? same[0]! : null;
}

/** Номер «Объект №N» — та строка, которую CRM ставит последней в каждую свою
 *  подпись (postFooterLine в lib/reelsCaptionTemplate.ts). Строже, чем «№N»
 *  где угодно: подпись пересланного поста может быть и чужой. */
export function captionFooterShortId(caption: string | undefined | null): number | null {
  // «Объект №557», а в подписях, набранных руками, и «Объекти № 557», «обьект #557»,
  // «Объект 557» (02.10.2026: в тексте рекламы номер пишут по-разному).
  // Без «№» — только от трёх цифр: «Объект 3 хонагӣ» в чужой подписи — это комнаты.
  const m = caption?.match(/(?:Объект|Обьект|Объекти|Обьекти)\s*(?:[№#]\s*(\d{1,6})|(\d{3,6}))(?![\d.,])/iu);
  return m ? Number(m[1] ?? m[2]) : null;
}

/** CDN самой Meta: только оттуда пересланное имеет смысл скачивать и читать. */
export function isMetaCdnUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "lookaside.fbsbx.com" ||
      host.endsWith(".fbcdn.net") ||
      host.endsWith(".cdninstagram.com") ||
      host === "lookaside.instagram.com"
    );
  } catch {
    return false;
  }
}

/**
 * ПОДПИСЬ ИЛИ КАРТОЧКА ПОХОЖИ НА ОБЪЯВЛЕНИЕ О ЖИЛЬЕ (02.10.2026). Нужно вебхуку,
 * чтобы отличить чужое объявление (на него отвечаем) от игры, клипа, айфона и
 * «заработка 500$ в день» (на них без слов клиента молчим).
 *
 * Сильные слова — жильё сами по себе. Слабые («дом», «комната», «аренда», голое
 * «хона») — только рядом со словом сделки или числом комнат: «сидим дома 😂» и
 * «мама зашла в комнату» — мемы, а не объявления (QA 02.10.2026). Цена, «$»,
 * «продам», «ремонт» сами жильём не считаются. Целыми словами: «хонед» (читайте),
 * «бинед» (смотрите), «хонанда» — не жильё. Без `\b` (CLAUDE.md, ловушки).
 */
const HOUSING_STRONG = new RegExp(
  `${BW}(?:хона(?:и|ҳо|хо|ҳои|хои|гӣ|ги)|ҳавлӣ|ҳавли|хавли|квартир${TAIL}|кварт\\.|участ(?:ок|ка|ки)|` +
    `замин(?:и|ҳо)?|ипотек${TAIL}|новострой${TAIL}|бино(?:и|ҳо)?|иҷора${TAIL}|ичора${TAIL}|ҳуҷра${TAIL}|хучра${TAIL}|` +
    `элитк${TAIL}|жк|сотих|сотка|сотки|соток|\\d+\\s*-?\\s*(?:хонаг|ҳуҷраг|хучраг|комн|к\\.)${TAIL})${EW}|` +
    `\\d\\s*(?:м²|м2|кв\\.?\\s*м)`,
  "iu"
);
const HOUSING_WEAK = new RegExp(`${BW}(?:хона|дом(?:а|е|у|ов|ик)?|комнат${TAIL}|аренд${TAIL})${EW}`, "iu");
const DEAL_WORD = new RegExp(
  `${BW}(?:прода${TAIL}|сда${TAIL}|сниму|куплю|фурӯш${TAIL}|фурўш${TAIL}|фурухта|харид${TAIL}|ба\\s+иҷора)${EW}`,
  "iu"
);

export function looksLikeHousing(text: string | undefined | null): boolean {
  if (!text) return false;
  return HOUSING_STRONG.test(text) || (HOUSING_WEAK.test(text) && DEAL_WORD.test(text));
}

/** Сколько ждём чтение карточки. Клиент ждёт ответа: лучше переспросить, чем молчать минуту. */
const CARD_READ_TIMEOUT_MS = 25_000;

/**
 * Последний путь: скачать пересланное с CDN Meta и прочитать надписи с карточки.
 * Зовётся только когда все пути по базе промахнулись — то есть редко, и лишняя
 * загрузка того же файла (разговор скачает его ещё раз) здесь допустима.
 */
export async function propertyFromSharedCard(url: string | undefined | null, declaredKind?: string) {
  return (await readSharedCard(url, declaredKind))?.property ?? null;
}

/** Что прочитано с карточки: объект (единственное совпадение) и было ли на ней
 *  объявление вообще — цена или площадь. Второе нужно вебхуку, чтобы отличить
 *  чужое объявление о жилье (отвечаем) от игры и клипа (молчим), 02.10.2026. */
export interface CardRead {
  property: Awaited<ReturnType<typeof matchPropertyByFacts>>;
  listingSeen: boolean;
}

export async function readSharedCard(url: string | undefined | null, declaredKind?: string): Promise<CardRead | null> {
  if (!url || !isMetaCdnUrl(url)) return null;
  return readCardSource({ url, declaredKind });
}

/**
 * СКРИНШОТ НАШЕГО ОБЪЯВЛЕНИЯ ОБЫЧНЫМ ФОТО (02.10.2026, Dan: «любой пересланный
 * пост или скриншот… своему агенту»). Тот же разбор надписей, но источник —
 * уже найденное вебхуком вложение (у WhatsApp это адрес с маркером, не CDN).
 */
export async function propertyFromCardSource(source: AttachmentSource) {
  return (await readCardSource(source))?.property ?? null;
}

/** null — прочитать не удалось (не скачалось, Gemini молчит, вышло время). */
export async function readCardSource(source: AttachmentSource): Promise<CardRead | null> {
  try {
    const read = async (): Promise<string | null> => {
      const fetched = await fetchAttachments([source]);
      const image = fetched.images[0];
      if (image) return describeMedia(Buffer.from(image.data, "base64"), image.mediaType, "card", "пересланный пост");
      const video = fetched.medias.find((m) => m.media === "video");
      if (video) return describeMedia(video.buffer, video.mediaType, "card", video.filename);
      return null;
    };
    const text = await Promise.race([
      read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), CARD_READ_TIMEOUT_MS).unref?.()),
    ]);
    if (!text) return null;
    const facts = parsePropertyFacts(text);
    // Цена сама по себе — не объявление о жилье: «iPhone 1200$», «доход 3000$».
    const listingSeen = facts.areaSqm != null || facts.rooms != null || looksLikeHousing(text);
    return { property: await matchPropertyByFacts(facts), listingSeen };
  } catch (err) {
    void logSystemError("meta", `Карточку пересланного поста прочитать не удалось: ${describeError(err)}`);
    return null;
  }
}
