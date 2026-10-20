/**
 * Подпись под Reels — по шаблону, а не через ИИ.
 *
 * РЕШЕНИЕ ВЛАДЕЛЬЦА 04.08.2026: подписи под видео-обзоры довольно однотипны
 * (крючок → характеристики → призыв позвонить), и платить за вызов модели на
 * каждый объект незачем — три-четыре шаблона с плейсхолдерами и случайным
 * выбором дают тот же результат бесплатно и мгновенно. Шаблоны живут в
 * `Settings.reelsCaptionTemplates` (текст, шаблоны разделены строкой `---`) —
 * директор редактирует без программиста, тот же принцип, что и у остальных
 * текстов бота.
 *
 * Плейсхолдер, для которого нет данных (например, `{{rooms}}` у участка —
 * комнат не бывает), не оставляет дыру в тексте: строка с ним целиком убирается,
 * а не превращается в «Комнат: ,» — ту же строчную фильтрацию уже применяет
 * generateReelsCaption (ai/reelsCaption.ts) для необязательных фактов.
 */

import { TYPE_RU, CONDITION_RU, formatPrice } from "../ai/seoGenerator.js";
// MARKET_TYPE_LABELS — тот же словарь, что подписывает объект на карточке:
// второго перевода «NEW_BUILD → Новостройка» в проекте быть не должно.
import { MARKET_TYPE_LABELS, propertyHasCondition, visiblePropertyFacts } from "@royal-home/shared";
import { toTjs, type MoneyContext } from "./money.js";
import { PUBLIC_AGENCY_CONTACT } from "./publicAgencyContact.js";
import {
  NEW_BUILD_PHASES,
  marketSideOf,
  newBuildPhaseOf,
  type MarketType,
  type PropertyCondition,
  type PropertyStage,
} from "@royal-home/shared";

/** ОДИН публичный номер агентства в подписях — `6501414` (маршрут АТС, см.
 *  docs/telephony-sip-numbering.md). Публикуется как есть, без подписей вроде
 *  «колл-центр» — просто номер.
 *
 *  ВТОРОЙ НОМЕР (WhatsApp Business, `777776001`) УБРАН ИЗ ПОДПИСЕЙ 20.09.2026
 *  по решению владельца: «удали его, чтобы нигде больше не было под постами».
 *  С 14.10.2026 он также не публикуется ботами: этот адрес недоступен.
 *  Канонический публичный контакт — только звонки, не WhatsApp для файлов.
 *
 *  Личный номер интейкера в подписях под Reels не публикуется с 17.08.2026 —
 *  номер фиксирован текстом, а не через {{phone}}: это не факт объекта, а
 *  реквизит агентства, который не должен зависеть от того, кто принял заявку. */
export const CONTACT_NUMBERS = formatTjPhone(PUBLIC_AGENCY_CONTACT.phone);

/**
 * КОНЦОВКА С АГЕНТОМ ПО ОБЪЕКТУ — РЕШЕНИЕ ВЛАДЕЛЬЦА 25.09.2026 (временно):
 * «укажем настоящие номера наших агентов из их профиля в CRM, потом имя типа
 * Агент Ноза, а потом наш номер компании, без фамилии». Отменяет запрет
 * 17.08/23.09 на телефоны агентов под постами — до следующего решения.
 *
 * Концовка ставится ОДНОЙ функцией поверх любого текста — шаблона (номер в
 * шаблонах директора в Настройках вписан текстом), ответа ИИ и уже
 * сохранённой подписи вышедшего поста. Агент — интейкер, иначе риелтор,
 * иначе автор карточки: тот же порядок, что у «Перегенерировать».
 */
const CONTACT_FOOTER_HEAD = "📲 Звоните или пишите в директ:";
const COMPANY_CONTACT_LINE = `${CONTACT_NUMBERS} Royal Home`;

export interface CaptionAgent {
  fullName: string | null;
  phone: string | null;
}

/** +992XXXXXXXXX → «+992 77 707-01-00», в том же виде, что номер агентства.
 *  Номер другой длины не угадываем — печатаем как в профиле. */
export function formatTjPhone(raw: string): string {
  const m = raw.replace(/[^\d+]/g, "").match(/^\+?992(\d{2})(\d{3})(\d{2})(\d{2})$/);
  return m ? `+992 ${m[1]} ${m[2]}-${m[3]}-${m[4]}` : raw.trim();
}

/** Только имя — первое слово fullName («Сурайё Каримова» → «Сурайё»). */
function agentFirstName(fullName: string | null): string | null {
  const first = fullName?.trim().split(/\s+/)[0];
  return first ? first : null;
}

/** РЕШЕНИЕ ВЛАДЕЛЬЦА 05.10.2026: у агента Маруфа в подписи Reels — другой номер
 *  и имя «Махди». Подмена ТОЛЬКО в концовке подписи: профиль агента в CRM, лиды
 *  и звонки не трогаем. Узнаём по имени из профиля (Маруф / Маъруф). Убрать —
 *  удалить константу и ветку в buildContactFooter. */
const MARUF_NAME_RE = /^ма[ъ'’`]?руф$/i;
const MARUF_CAPTION_OVERRIDE: CaptionAgent = { fullName: "Махди", phone: process.env.MARUF_CAPTION_PHONE?.trim() || PUBLIC_AGENCY_CONTACT.phone };

export function buildContactFooter(rawAgent: CaptionAgent | null): string {
  const agent =
    rawAgent && MARUF_NAME_RE.test(agentFirstName(rawAgent.fullName) ?? "") ? MARUF_CAPTION_OVERRIDE : rawAgent;
  const lines = [CONTACT_FOOTER_HEAD];
  if (agent?.phone) {
    const name = agentFirstName(agent.fullName);
    lines.push(name ? `${formatTjPhone(agent.phone)} Агент ${name}` : formatTjPhone(agent.phone));
  }
  lines.push(COMPANY_CONTACT_LINE);
  return lines.join("\n");
}

/**
 * Ставит концовку вместо строки с номером — последней строки, где есть +992.
 * От неё остаётся только текст ДО призыва/номера («Все сделки в национальной
 * валюте.»). Номера в тексте нет (подпись правили руками) — концовка встаёт
 * перед подвалом «Объект №…», если он есть, иначе в конец.
 *
 * ИДЕМПОТЕНТНО: своя прошлая концовка узнаётся целиком (от заголовка до строки
 * агентства) и заменяется — так смена агента или его номера в профиле
 * доезжает до уже сохранённой подписи кнопкой «Обновить подписи».
 */
export function applyContactFooter(caption: string, agent: CaptionAgent | null): string {
  const footer = buildContactFooter(agent);
  const lines = caption.replace(/\r\n/g, "\n").split("\n");
  const end = lines.lastIndexOf(COMPANY_CONTACT_LINE);
  const start = end >= 0 ? lines.lastIndexOf(CONTACT_FOOTER_HEAD, end) : -1;
  if (start >= 0) {
    lines.splice(start, end - start + 1, footer);
    return lines.join("\n").trim();
  }
  let idx = -1;
  lines.forEach((l, i) => {
    if (/\+\s?992/.test(l)) idx = i;
  });
  if (idx < 0) {
    const objectLine = lines.findIndex((l) => /^Объект №\d+/.test(l));
    if (objectLine < 0) return `${caption.trim()}\n\n${footer}`;
    lines.splice(objectLine, 0, footer, "");
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  const prefix = lines[idx]!.replace(/(📲\s*|📞\s*)?((Звоните|Пишите)[^:+]*:)?\s*📞?\s*\+\s?992.*$/u, "").trim();
  lines.splice(idx, 1, ...(prefix ? [prefix, footer] : [footer]));
  return lines.join("\n").trim();
}

/**
 * ХЕШТЕГИ РАЙОНА В ПОДПИСИ (26.09.2026, владелец: «в Душанбе ищут по району»,
 * #Сино #Шохмансур #Фирдавси #Сомони). Только районы, где реально есть Property
 * — TYPE_HASHTAG ниже, а не полный справочник District, чтобы не тащить сюда
 * зависимость от базы (файл остаётся чистыми функциями, без обращения к prisma).
 */
const TYPE_HASHTAG: Partial<Record<string, string>> = {
  APARTMENT: "квартира",
  HOUSE: "дом",
  LAND: "участок",
};

/** «Исмоили Сомони» → «ИсмоилиСомони», «Сино» → «Сино» — хештег не терпит
 *  пробелов и дефисов, площадка режет строку на первом же таком символе. */
function districtHashtag(districtName: string | null | undefined): string | null {
  if (!districtName) return null;
  const clean = districtName.replace(/[\s-]+/g, "");
  return clean ? `#${clean}` : null;
}

/**
 * Строка хештегов для плейсхолдера `{{hashtags}}`: район (если известен) +
 * три постоянных тега + тег типа объекта (если тип из TYPE_HASHTAG). Пустой
 * район не оставляет дыру — тег просто не ставится первым, остальные три
 * постоянных тега гарантируют, что строка никогда не пуста целиком (правило
 * «пустой плейсхолдер убирает строку», см. fillReelsCaptionTemplate, здесь
 * не срабатывает и срабатывать не должно).
 */
export function buildReelsHashtags(districtName: string | null | undefined, type: string | null | undefined): string {
  const tags: string[] = [];
  const district = districtHashtag(districtName);
  if (district) tags.push(district);
  tags.push("#Душанбе", "#недвижимость", "#RoyalHome");
  const typeTag = type ? TYPE_HASHTAG[type] : undefined;
  if (typeTag) tags.push(`#${typeTag}`);
  return tags.join(" ");
}

export const DEFAULT_REELS_CAPTION_TEMPLATES = [
  `🔥 {{type}} в районе {{district}} — то, что вы искали!
Комнат: {{rooms}}
Площадь: {{areaSqm}} м²
Этаж: {{floor}} из {{totalFloors}}
Состояние: {{condition}}
Цена: {{price}}
📲 Пишите в директ или звоните: ${CONTACT_NUMBERS}
{{hashtags}}`,
  `✨ Смотрите: {{type}}, {{district}}
{{areaSqm}} м² · {{rooms}} комн. · этаж {{floor}}/{{totalFloors}}
{{condition}}
💰 {{price}}
📞 Звоните: ${CONTACT_NUMBERS}
{{hashtags}}`,
  `🏠 Новый объект в {{district}}!
{{type}}, {{rooms}} комнат, {{areaSqm}} м²
Этаж {{floor}} из {{totalFloors}}, {{condition}}
Цена — {{price}}
📞 Пишите в директ или звоните: ${CONTACT_NUMBERS}
{{hashtags}}`,
  `👀 {{district}}: {{type}} на продажу
{{rooms}}-комнатная, {{areaSqm}} м², {{floor}}/{{totalFloors}} эт.
{{condition}} · {{price}}
📞 Звоните прямо сейчас: ${CONTACT_NUMBERS}
{{hashtags}}`,
  `🏛 Продаётся {{type}}:

✅Район: {{district}}
✅Адрес: {{address}}
✅Тип недвижимости: {{type}}
✅Рынок: {{marketType}}
✅Участок: {{landAreaSotka}} соток
✅Документ: {{documents}}
✅Ремонт: {{condition}}
✅Количество комнат: {{rooms}}
✅Санузел: {{bathroom}}
✅Количество окон: {{windowCount}}
✅Площадь: {{areaSqm}}м²
✅Этажность: {{totalFloors}}
✅Этаж: {{floor}}
✅Удобства: {{amenities}}
✅Цена: {{price}}

Покупка недвижимости с агентством Royal Home - это надёжность на каждом этапе!

Только реальные объекты и настоящие владельцы. Все сделки проводятся строго в национальной валюте.
📲 Звоните или пишите в директ: ${CONTACT_NUMBERS}
{{hashtags}}`,
  `🏙 Продаётся {{type}}:

✅Район: {{district}}
✅Адрес: {{address}}
✅Документ: {{documents}}
✅Ремонт: {{condition}}
✅Количество комнат: {{rooms}}
✅Санузел: {{bathroom}}
✅Количество окон: {{windowCount}}
✅Площадь: {{areaSqm}}м²
✅Этаж: {{floor}} из {{totalFloors}}
✅Удобства: {{amenities}}
✅Цена: {{price}}

📲 Звоните или пишите в директ: ${CONTACT_NUMBERS}
Royal Home — только проверенные объекты и реальные владельцы!
{{hashtags}}`,
  `🔑 Новый объект от Royal Home:

✅Район: {{district}}
✅Адрес: {{address}}
✅Тип недвижимости: {{type}}
✅Рынок: {{marketType}}
✅Участок: {{landAreaSotka}} соток
✅Документ: {{documents}}
✅Ремонт: {{condition}}
✅Количество комнат: {{rooms}}
✅Санузел: {{bathroom}}
✅Количество окон: {{windowCount}}
✅Площадь: {{areaSqm}}м²
✅Этажность: {{totalFloors}}
✅Этаж: {{floor}}
✅Удобства: {{amenities}}
✅Цена: {{price}}

Все сделки — строго в национальной валюте.
📞 Пишите в директ или звоните: ${CONTACT_NUMBERS}
{{hashtags}}`,
].join("\n---\n");

/** Те же 7 шаблонов ДО 26.09.2026, без хештегов — подписи, вышедшие раньше,
 *  узнаются по ним при «Обновить подписи» (rewriteCaptionFacts), иначе
 *  правка объекта их больше не находит: тот же приём, что и у
 *  REELS_FACTS_TEMPLATE_BEFORE_23_09 ниже. */
const DEFAULT_REELS_CAPTION_TEMPLATES_BEFORE_HASHTAGS = DEFAULT_REELS_CAPTION_TEMPLATES.split("\n---\n").map((t) =>
  t.replace(/\n\{\{hashtags\}\}$/, "")
);

/** Шаблон №5 до 02.10.2026 называл тип словом «квартира» у любого объекта
 *  (находка О8) — подписи, вышедшие с ним, узнаются при «Обновить подписи»
 *  целиком, с заголовком, а не только блоком фактов. */
const REELS_TEMPLATE_5_BEFORE_02_10 = DEFAULT_REELS_CAPTION_TEMPLATES_BEFORE_HASHTAGS.filter((t) =>
  t.startsWith("🏛 Продаётся {{type}}:")
).map((t) => t.replace("🏛 Продаётся {{type}}:", "🏛 Продаётся квартира:"));

function splitTemplates(source: string): string[] {
  return source
    .split(/\n-{3,}\n/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Шаблоны разделены строкой из трёх и более дефисов на отдельной строке —
 *  человек различает границу с первого взгляда, править можно в одном textarea.
 *
 *  Если после разбора не осталось ни одного шаблона (например, директор сохранил
 *  в настройках один голый разделитель без текста вокруг) — откатываемся на
 *  зашитые по умолчанию, а не отдаём пустой список: генерация подписи иначе
 *  берёт templates[0] от пустого массива и падает на .split(undefined). */
export function parseReelsCaptionTemplates(raw: string | null | undefined): string[] {
  const source = raw && raw.trim() ? raw : DEFAULT_REELS_CAPTION_TEMPLATES;
  const parsed = splitTemplates(source);
  return parsed.length > 0 ? parsed : splitTemplates(DEFAULT_REELS_CAPTION_TEMPLATES);
}

export interface ReelsCaptionValues {
  type: string;
  district: string;
  rooms: string | null;
  areaSqm: string;
  floor: string | null;
  totalFloors: string | null;
  condition: string;
  price: string;
  phone: string | null;
  /** fullName агента по объекту — для концовки «Агент <имя>», см. applyContactFooter. */
  agentName: string | null;
  address: string | null;
  documents: string | null;
  windowCount: string | null;
  bathroom: string | null;
  /** Участок в сотках — у дома и земли площадь в м² не отвечает на главный вопрос. */
  landAreaSotka: string | null;
  /** Новостройка или вторичка — первый вопрос покупателя после цены. */
  marketType: string | null;
  /** Удобства одной строкой, как на карточке объекта. */
  amenities: string | null;
  /** Хештеги района/типа для {{hashtags}} (26.09.2026) — см. buildReelsHashtags.
   *  Необязательное поле (а не обязательное, как остальные) — существующие
   *  вызовы fillReelsCaptionTemplate с объектом ReelsCaptionValues без него
   *  (например, факты для ИИ-подписи, ai/reelsCaptionAi.ts) не обязаны знать
   *  про хештеги вовсе; {{hashtags}} есть только в DEFAULT_REELS_CAPTION_TEMPLATES. */
  hashtags?: string | null;
}

/** `details.bathroom` — тот же select-справочник, что и на карточке объекта
 *  (PROPERTY_DETAIL_OPTIONS.bathroom в @royal-home/shared), уже по-русски и
 *  без отдельного поля-количества: значения вида «Раздельный» или «2+ санузла»
 *  сами отвечают и на «сколько», и на «какой». */
function bathroomFromDetails(details: unknown): string | null {
  if (details && typeof details === "object" && "bathroom" in details) {
    const v = (details as Record<string, unknown>).bathroom;
    return typeof v === "string" && v ? v : null;
  }
  return null;
}

export function fillReelsCaptionTemplate(template: string, values: ReelsCaptionValues): string {
  const record = values as unknown as Record<string, string | null>;
  const lines = template.split("\n").map((line) => {
    let missing = false;
    const replaced = line.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      const v = record[key];
      if (v === null || v === undefined || v === "") {
        missing = true;
        return "";
      }
      return v;
    });
    return missing ? null : replaced;
  });
  return lines.filter((l): l is string => l !== null).join("\n").trim();
}

/** Цена в тексте для соцсетей — владелец, 17.09.2026: сделки всё равно только
 *  в сомони, значит цена в сомони обязана стоять первой строкой даже у
 *  объекта, заведённого в долларах, а сумма в долларах — рядом в скобках,
 *  а не единственным числом. Объект и так в сомони — ничего не меняется,
 *  добавлять скобки не с чем и незачем. `money` не передан (внутренние
 *  тексты вроде подписи монтажёру, где курс ни к чему) — прежнее поведение,
 *  одна валюта как есть. */
export function buildPriceDisplay(price: number | string | { toString(): string }, currency: string, money?: MoneyContext): string {
  const amount = Number(price.toString());
  const primary = formatPrice(amount, currency);
  if (currency !== "USD" || !money) return primary;
  return `${priceInTjsOnly(price, currency, money)} (${primary})`;
}

/**
 * ТОЛЬКО СОМОНИ, БЕЗ СКОБОК (владелец 23.09.2026: «монтажёру пусть цена идёт
 * только в сомони, а в автопостинге и в сомони, и в $»).
 *
 * Отдельная функция, а не флаг у `buildPriceDisplay`, ровно затем, чтобы
 * пересчёт остался в ОДНОМ месте: `buildPriceDisplay` теперь зовёт её же.
 * Второй копии `toTjs` в проекте быть не должно — на этом уже расходились
 * (правка #752, «одно правило написано дважды»).
 *
 * Курса нет — отдаём цену как есть: соврать «сомони», показав доллары, хуже,
 * чем показать доллары долларами.
 */
export function priceInTjsOnly(
  price: number | string | { toString(): string },
  currency: string,
  money?: MoneyContext
): string {
  const amount = Number(price.toString());
  if (currency !== "USD" || !money) return formatPrice(amount, currency);
  return formatPrice(toTjs(amount, "USD", money), "TJS");
}

/** Фаза новостройки словами для подписи; null — вторичка или фаза не выбрана. */
function newBuildConditionRu(p: { condition: string; stage?: string | null; marketType?: string | null }): string | null {
  const f = { condition: p.condition as PropertyCondition, stage: (p.stage ?? null) as PropertyStage | null, marketType: (p.marketType ?? null) as MarketType | null };
  if (marketSideOf(f) !== "NEW") return null;
  const phase = newBuildPhaseOf(f);
  const label = phase ? NEW_BUILD_PHASES.find((x) => x.key === phase)?.label : null;
  return label ? label.charAt(0).toLowerCase() + label.slice(1) : null;
}

/** Значения плейсхолдеров из полей объекта — общая точка сборки для создания
 *  объекта и для кнопки «Перегенерировать», чтобы формат не разъезжался. */
export function reelsCaptionValuesFromProperty(p: {
  landAreaSotka?: number | string | { toString(): string } | null;
  amenities?: string[] | null;
  type: string;
  rooms: number | null;
  // areaSqm/price приходят из Prisma как Decimal при чтении объекта из базы и как
  // number при создании (из тела запроса, ещё не сохранённого) — String()/Number()
  // одинаково работают на обоих, поэтому тип нарочно широкий.
  areaSqm: number | string | { toString(): string };
  floor: number | null;
  totalFloors: number | null;
  price: number | string | { toString(): string };
  currency: string;
  condition: string;
  /** Стадия и рынок — у новостройки вместо «Ремонт: новостройка» пишется фаза
   *  («черновые работы сделаны»), см. packages/shared/src/propertyFinish.ts. */
  stage?: string | null;
  marketType?: string | null;
  districtName: string;
  phone: string | null;
  agentName?: string | null;
  address?: string | null;
  documents?: string | null;
  windowCount?: number | null;
  details?: unknown;
  /** Курс USD→TJS — задайте для публичных текстов (соцсети), см. buildPriceDisplay. */
  money?: MoneyContext;
}): ReelsCaptionValues {
  // Поля, которых у типа нет (этаж у дома, «новостройка» у дома и участка,
  // комнаты у участка), в подпись не попадают даже у старых карточек, где они
  // заполнены (propertyTypeFields.ts, владелец 08.10.2026). Строка шаблона с
  // пустым значением выпадает целиком (fillReelsCaptionTemplate).
  p = visiblePropertyFacts(p);
  return {
    type: TYPE_RU[p.type] ?? p.type,
    district: p.districtName,
    rooms: p.rooms != null ? String(p.rooms) : null,
    areaSqm: p.areaSqm.toString(),
    floor: p.floor != null ? String(p.floor) : null,
    totalFloors: p.totalFloors != null ? String(p.totalFloors) : null,
    // У участка состояния ремонта нет — пустая строка убирает строку «Ремонт:».
    condition: propertyHasCondition(p.type) ? (newBuildConditionRu(p) ?? CONDITION_RU[p.condition] ?? p.condition) : "",
    price: buildPriceDisplay(p.price, p.currency, p.money),
    phone: p.phone,
    agentName: p.agentName ?? null,
    address: p.address ?? null,
    documents: p.documents ?? null,
    windowCount: p.windowCount != null ? String(p.windowCount) : null,
    bathroom: bathroomFromDetails(p.details),
    landAreaSotka: p.landAreaSotka != null ? p.landAreaSotka.toString() : null,
    marketType: p.marketType ? (MARKET_TYPE_LABELS[p.marketType as MarketType] ?? p.marketType) : null,
    amenities: p.amenities && p.amenities.length > 0 ? p.amenities.join(", ") : null,
    hashtags: buildReelsHashtags(p.districtName, p.type),
  };
}

/**
 * ПОДВАЛ ПОД КАЖДЫМ ПОСТОМ: НОМЕР ОБЪЕКТА, И БОЛЬШЕ НИЧЕГО.
 *
 * Владелец 23.09.2026: «код агента не надо, код объекта ставить номер типа
 * объект номер 112, а не 00112» — и отдельно, в тот же час: «телефоны агентов
 * не надо под объектами ставить». Поэтому под постом стоит ровно одна строка
 * «Объект №112»: клиент называет этот номер в переписке или по телефону, и
 * заявка привязывается к объекту, а не теряется в общей очереди.
 *
 * НЕ `formatPropertyCode` (тот даёт «ОБ-000112»). Тот формат остаётся внутри
 * CRM, где номер читают глазами в списках; под постом его видит клиент, и
 * произносить он должен «сто двенадцать». Разные читатели — разные формы, это
 * не двойник правила.
 *
 * ПОДВАЛ, А НЕ ПЛЕЙСХОЛДЕР В ШАБЛОНЕ, по двум причинам, обе практические.
 * Первая: подпись собирают ДВА генератора — шаблонный и тот, что просит у
 * Gemini крючок и концовку (ai/reelsCaptionAi.ts). Плейсхолдер пришлось бы
 * заводить в обоих, и в семи шаблонах руками. Вторая, решающая: номер объекта
 * присваивает база в момент создания, а подпись собирается ДО него — в момент
 * генерации кода объекта ещё не существует. Подвал дописывается после, когда
 * номер уже есть.
 *
 * ИДЕМПОТЕНТНО. Подпись пересобирают и правят (кнопка «Обновить подписи»,
 * повторная модерация), и подвал обязан ЗАМЕНЯТЬСЯ, а не копиться в шесть
 * строк. Старый узнаётся по началу строки — поэтому начало менять нельзя, как
 * у любого маркера, по которому что-то ищут.
 */
const POST_FOOTER_RE = /\n*Объект №\d+[^\n]*\n?/g;

/** «Объект №112» — так номер стоит под постом и так его называет клиент. */
export function postFooterLine(shortId: number): string {
  return `Объект №${shortId}`;
}

export function withPostFooter(caption: string, shortId: number): string {
  const clean = caption.replace(POST_FOOTER_RE, "\n").trim();
  return `${clean}\n\n${postFooterLine(shortId)}`;
}

/**
 * Шаблон из пула, заполненный текущими данными объекта. Без seed — случайный
 * (живое разнообразие ленты при первой публикации). С seed (id объекта) —
 * всегда один и тот же для этого объекта: кнопка «Обновить подписи» раньше
 * каждый раз брала новый случайный шаблон, и пост в сети менял весь текст,
 * хотя поменялся один этаж (аудит 23.09.2026).
 */
export function generateReelsCaptionFromTemplates(
  values: ReelsCaptionValues,
  templatesRaw: string | null | undefined,
  seed?: string
): string {
  const templates = parseReelsCaptionTemplates(templatesRaw);
  const index = seed ? stableIndex(seed, templates.length) : Math.floor(Math.random() * templates.length);
  return applyContactFooter(fillReelsCaptionTemplate(templates[index]!, values), {
    fullName: values.agentName,
    phone: values.phone,
  });
}

function stableIndex(seed: string, length: number): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return length > 0 ? h % length : 0;
}

/**
 * Блок фактов «✅Район: …» — общий для подписи от ИИ (ai/reelsCaptionAi.ts
 * зовёт его отсюда) и для поиска этого блока при правке объекта ниже. Строка с
 * пустым значением выпадает целиком, как и в шаблонах.
 */
export const REELS_FACTS_TEMPLATE = [
  "✅Район: {{district}}",
  "✅Адрес: {{address}}",
  "✅Тип недвижимости: {{type}}",
  "✅Рынок: {{marketType}}",
  "✅Участок: {{landAreaSotka}} соток",
  "✅Документ: {{documents}}",
  "✅Ремонт: {{condition}}",
  "✅Количество комнат: {{rooms}}",
  "✅Санузел: {{bathroom}}",
  "✅Количество окон: {{windowCount}}",
  "✅Площадь: {{areaSqm}}м²",
  "✅Этажность: {{totalFloors}}",
  "✅Этаж: {{floor}}",
  "✅Удобства: {{amenities}}",
  "✅Цена: {{price}}",
].join("\n");

/** Блок фактов до 23.09.2026, без рынка, участка и удобств: подписи, вышедшие
 *  раньше, узнаются по нему, иначе правка объекта их уже не нашла бы. */
const REELS_FACTS_TEMPLATE_BEFORE_23_09 = REELS_FACTS_TEMPLATE.split("\n")
  .filter((line) => !/\{\{(marketType|landAreaSotka|amenities)\}\}/.test(line))
  .join("\n");

const PRICE_MARK = "\u0000PRICE\u0000";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * ПЕРЕПИСАТЬ ФАКТЫ В УЖЕ ВЫШЕДШЕЙ ПОДПИСИ (владелец 23.09.2026: «после
 * „Готово“ подписи обновляются везде автоматически»).
 *
 * Подпись не пересобирается заново: у подписи от ИИ живые первая и последняя
 * фразы, у шаблонной — выбранный при публикации шаблон. Ищем в тексте блок,
 * который дал бы шаблон (или блок фактов ИИ) со СТАРЫМИ значениями объекта, и
 * заменяем ровно его тем же шаблоном с НОВЫМИ. Цена в поиске — любая строка:
 * её сумма в сомони зависит от курса на день публикации, и её переписывает
 * отдельный механизм (lib/publishedListingSync.ts) — здесь цена остаётся той,
 * что стоит в тексте.
 *
 * null — блок не найден (подпись правили руками): лучше не трогать чужую
 * правку вслепую, чем испортить текст.
 */
export function rewriteCaptionFacts(
  caption: string,
  oldValues: ReelsCaptionValues,
  newValues: ReelsCaptionValues,
  templatesRaw: string | null | undefined
): string | null {
  const candidates = [
    ...parseReelsCaptionTemplates(templatesRaw),
    // Хештеги (26.09.2026) добавлены последней строкой во все 7 дефолтных
    // шаблонов — посты, вышедшие раньше, узнаются по версии без неё.
    ...DEFAULT_REELS_CAPTION_TEMPLATES_BEFORE_HASHTAGS,
    ...REELS_TEMPLATE_5_BEFORE_02_10,
    ...REELS_TEMPLATE_5_BEFORE_02_10.map((t) => `${t}\n{{hashtags}}`),
    REELS_FACTS_TEMPLATE,
    REELS_FACTS_TEMPLATE_BEFORE_23_09,
  ];
  let best: { template: string; index: number; length: number; price: string | null } | null = null;
  for (const template of candidates) {
    const oldBlock = fillReelsCaptionTemplate(template, { ...oldValues, price: PRICE_MARK });
    if (!oldBlock) continue;
    const hasPrice = oldBlock.includes(PRICE_MARK);
    // Цена в конце блока — жадно до конца строки, иначе ленивое «+?» съело бы
    // один символ; в середине — лениво до следующего куска шаблона.
    const priceGroup = oldBlock.endsWith(PRICE_MARK) ? "([^\\n]+)" : "([^\\n]+?)";
    const re = new RegExp(escapeRegExp(oldBlock).split(escapeRegExp(PRICE_MARK)).join(priceGroup));
    const m = re.exec(caption);
    if (m && (!best || m[0].length > best.length)) {
      best = { template, index: m.index, length: m[0].length, price: hasPrice ? m[1] ?? null : null };
    }
  }
  if (!best) return null;
  const newBlock = fillReelsCaptionTemplate(best.template, { ...newValues, price: best.price ?? newValues.price });
  return caption.slice(0, best.index) + newBlock + caption.slice(best.index + best.length);
}
