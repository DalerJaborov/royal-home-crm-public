import { PROPERTY_STAGE_LABELS, propertyHasCondition, visiblePropertyFacts, type MarketType, type PropertyStage } from "@royal-home/shared";
import { callAiText } from "./client.js";

export interface SeoSourceParams {
  type: string;
  rooms?: number | null;
  areaSqm: number;
  floor?: number | null;
  totalFloors?: number | null;
  price: number;
  currency: string;
  districtName: string;
  address: string;
  condition: string;
  amenities: string[];
  stage?: string | null;
  marketType?: string | null;
  urgent: boolean;
}

export interface SeoFields {
  description: string;
  metaTitle: string;
  metaDescription: string;
  h1: string;
  seoDesc: string;
}

export const TYPE_RU: Record<string, string> = {
  APARTMENT: "квартира",
  HOUSE: "дом",
  COMMERCIAL: "коммерческая недвижимость",
  LAND: "земельный участок",
};

export const CONDITION_RU: Record<string, string> = {
  NEEDS_REPAIR: "требует ремонта",
  GOOD: "хорошее состояние",
  EXCELLENT: "отличное состояние",
  NEW_BUILDING: "новостройка",
};

/**
 * Ось рынка словами для подсказки модели. Отдельной таблицей, а не тернарным
 * «NEW_BUILD ? новостройка : вторичное жильё», как было до 11.09.2026: с
 * появлением третьего значения («Котлован») тернарник молча назвал бы котлован
 * вторичным жильём, и ошибка уехала бы прямо в описание объявления. Record по
 * MarketType заставляет tsc потребовать строку для каждого нового значения.
 */
const MARKET_TYPE_RU: Record<MarketType, string> = {
  NEW_BUILD: "новостройка",
  SECONDARY: "вторичное жильё",
  FOUNDATION_PIT: "котлован (дом ещё не строится)",
};

/**
 * Длинное тире — самая заметная примета машинного текста: живые люди в объявлениях
 * его почти не ставят, а модели любят. Запрета в промте мало, модель всё равно
 * изредка его проставит, поэтому текст ещё и чистится здесь.
 *
 * Замена по контексту, а не вслепую. Точку ставим, только когда тире правда
 * разделяло два предложения: слева законченное слово, справа заглавная буква.
 * Одной заглавной справа мало — в «Дом, 120 м² — Рудаки» дальше идёт название
 * района, и точка разорвала бы фразу. Во всех прочих случаях это пояснение,
 * его роль берёт запятая. В конце строки тире просто отбрасываем, чтобы не
 * оставить висящий знак. Обычный дефис не трогаем: «3-комнатная» это не тире.
 */
const DASH_RE = /\s*[–—―]\s*/g;

export function stripDashes(text: string): string {
  return text
    .replace(DASH_RE, (match, offset: number, full: string) => {
      const after = full.slice(offset + match.length).trimStart();
      if (!after) return "";
      const before = full.slice(0, offset).trimEnd().slice(-1);
      const isSentenceBreak = /[А-Яа-яЁёA-Za-z]/.test(before) && /^[А-ЯЁA-Z]/.test(after);
      return isSentenceBreak ? ". " : ", ";
    })
    .replace(/\s+([,.])/g, "$1")
    .replace(/,\s*,/g, ",")
    .trim();
}

const SEO_PROPERTIES = {
  description: {
    type: "string",
    description:
      "Описание объекта для карточки, 3-5 предложений живым человеческим языком, " +
      "только по переданным фактам. Без длинного тире.",
  },
  metaTitle: { type: "string", description: "SEO title, до 70 символов, без длинного тире" },
  metaDescription: { type: "string", description: "SEO description, до 160 символов, без длинного тире" },
  h1: { type: "string", description: "Заголовок H1 страницы объекта, без длинного тире" },
  seoDesc: {
    type: "string",
    description: "Развёрнутое SEO-описание для поисковых систем, 2-3 предложения, без длинного тире",
  },
};
const SEO_SCHEMA = {
  type: "object",
  properties: SEO_PROPERTIES,
  required: ["description", "metaTitle", "metaDescription", "h1", "seoDesc"],
};
// На PATCH, если description и так игнорируется вызывающим кодом (см. properties.ts —
// ручной выбор варианта через "Сгенерировать описание (ИИ)" не должен затираться
// обычным изменением цены/площади), не просим модель его писать — экономим токены.
const SEO_SCHEMA_NO_DESCRIPTION = {
  type: "object",
  properties: { metaTitle: SEO_PROPERTIES.metaTitle, metaDescription: SEO_PROPERTIES.metaDescription, h1: SEO_PROPERTIES.h1, seoDesc: SEO_PROPERTIES.seoDesc },
  required: ["metaTitle", "metaDescription", "h1", "seoDesc"],
};

/**
 * Промт написан от обратного: перечислять «пиши живо» бесполезно, модель и так
 * считает, что пишет живо. Работают только конкретные запреты на обороты, по
 * которым читатель узнаёт машинный текст, и требование опираться на факты вместо
 * прилагательных. Примеры «плохо/хорошо» дают больше, чем любые общие указания.
 */
function buildSystemPrompt(includeDescription: boolean): string {
  const lines = [
    "Ты риелтор агентства Royal Home в Душанбе. Пишешь объявления о продаже недвижимости.",
    "",
    "ГЛАВНОЕ ПРАВИЛО ОФОРМЛЕНИЯ. Никогда не используй длинное тире (—) и среднее тире (–).",
    "Ни в описании, ни в заголовках, ни в SEO-полях. Вместо них ставь запятую, точку или",
    "двоеточие. Обычный дефис внутри слов («3-комнатная», «юго-запад») разрешён.",
    "",
    "Тон. Деловой и уверенный, как у профессионального агента, который знает объект и уважает",
    "покупателя. Грамотный литературный русский. Не панибратство и не разговорная речь:",
    "никакого «однушка», «квартирка», «шикарный», «супер», никаких восклицательных знаков",
    "и эмодзи. Но и не канцелярит: не пиши «данный объект», «осуществляется продажа»,",
    "«вышеуказанный», «является». Это объявление солидного агентства, а не протокол и не пост",
    "в социальных сетях.",
    "",
    "Содержание. Опирайся на цифры и факты, а не на прилагательные: площадь, этаж, район,",
    "состояние, цена. Предложения разной длины, среди них хотя бы одно короткое. Каждое",
    "предложение должно сообщать что-то новое: если фраза не добавляет факта, вычеркни её.",
    "",
    "Цена. Пиши ровно в том виде, в каком она передана в параметрах: «340 000 с.» для сомони",
    "и «$40 000» для долларов. Никогда не пиши коды валют (TJS, USD) и слово «сомони» словом.",
    "",
    "Так писать НЕЛЬЗЯ (типовые обороты, по которым текст читается как сгенерированный):",
    "«уютное гнёздышко», «изюминка», «идеально подойдёт как для..., так и для...»,",
    "«не упустите свой шанс», «мечта каждого», «ждёт своего хозяина», «свет и простор»,",
    "«не просто квартира, а образ жизни», «здесь каждый найдёт», «звоните прямо сейчас»,",
    "«представьте, как вы...», «добро пожаловать в...». Не начинай с вопроса к читателю.",
    "Не заканчивай призывом к действию: контакты агентства и так на странице.",
    "",
    "Факты. Пиши только то, что есть в параметрах. Не добавляй удобства, ремонт, вид из окна,",
    "инфраструктуру и соседей, если их не передали. Если в параметрах нет пометки о срочности,",
    "слова «срочно» быть не должно ни в каком виде.",
    "",
    "SEO. В metaTitle и h1 естественно вынеси тип объекта, район и город Душанбе, так, как это",
    "набирают в поиске: «купить 3-комнатную квартиру в районе Сино, Душанбе». Без перечисления",
    "ключевых слов через запятую и без повторов одного и того же слова. metaDescription по делу,",
    "с конкретикой (площадь, цена, район), без кликбейта и без обещаний, которых нет в фактах.",
    "",
    "Ориентир из адреса. В адресе часто стоит узнаваемое место: номер микрорайона («91 мкр»),",
    "улица, посёлок. Люди ищут именно так: «квартира 91 мкр Душанбе». Обязательно упомяни этот",
    "ориентир в описании, и вынеси его в h1 и metaTitle, если он туда помещается по длине.",
    "Номер дома и квартиры в заголовки не выноси: он не помогает поиску и не нужен в объявлении.",
  ];

  if (includeDescription) {
    lines.push(
      "",
      "Пример плохого описания: «Уютная 3-комнатная квартира ждёт своего хозяина! Просторные",
      "комнаты и удобная планировка идеально подойдут как для семьи, так и для сдачи в аренду.",
      "Не упустите свой шанс, звоните прямо сейчас!»",
      "",
      "Пример хорошего описания: «Трёхкомнатная квартира площадью 82 м² на пятом этаже",
      "девятиэтажного дома в районе Сино. Состояние хорошее, ремонт свежий, заезжать можно сразу.",
      "Планировка раздельная. Цена 340 000 с.»",
      "",
      "Второй пример короче и полезнее первого потому, что в нём одни факты и ровный деловой тон.",
    );
  }

  return lines.join("\n");
}

/** Цена так, как её пишут на сайте и в карточке: «340 000 с.» и «$40 000».
 *  В промт нельзя отдавать сырой код валюты (TJS) — модель переписывает его в текст
 *  дословно, и на сайте появлялось «340 000 TJS», чего там нет больше нигде. */
export function formatPrice(price: number, currency: string): string {
  const amount = price.toLocaleString("ru-RU");
  return currency === "USD" ? `$${amount}` : `${amount} с.`;
}

/** «Продажа <чего>» — родительный падеж типа (О7, 02.10.2026: было «Продажа дом»). */
const TYPE_RU_GENITIVE: Record<string, string> = {
  APARTMENT: "квартиры",
  HOUSE: "дома",
  COMMERCIAL: "коммерческой недвижимости",
  LAND: "земельного участка",
};

/** «N-комнатная квартира», «N-комнатный дом»; у участка и коммерции комнат в
 *  заголовке нет вовсе (О7, 02.10.2026: было «3-комнатная дом», «1-комнатная
 *  земельный участок»). */
function roomsWord(type: string, rooms: number | null | undefined): string {
  if (!rooms) return "";
  if (type === "APARTMENT") return `${rooms}-комнатная`;
  if (type === "HOUSE") return `${rooms}-комнатный`;
  return "";
}

function fallbackTemplate(raw: SeoSourceParams): SeoFields {
  // Поля, которых у типа нет, в текст сайта не попадают (propertyTypeFields.ts).
  const p = visiblePropertyFacts(raw);
  const typeRu = TYPE_RU[p.type] ?? "объект";
  const typeGenitive = TYPE_RU_GENITIVE[p.type] ?? "объекта";
  const roomsPart = roomsWord(p.type, p.rooms);
  const title = [roomsPart, typeRu, `${p.areaSqm} м²`, `в районе ${p.districtName}`].filter(Boolean).join(" ");
  const priceStr = formatPrice(p.price, p.currency);
  const conditionRu = propertyHasCondition(p.type) ? (CONDITION_RU[p.condition] ?? "") : "";
  const floorPart = p.floor && p.totalFloors ? `${p.floor}/${p.totalFloors} этаж` : p.type === "HOUSE" && p.totalFloors ? `этажей: ${p.totalFloors}` : "";
  const parts = [
    `Продаётся ${title}.`,
    [floorPart, conditionRu].filter(Boolean).join(", ") + ".",
    `Адрес: ${p.address}.`,
    `Цена: ${priceStr}.`,
    p.urgent ? "Срочная продажа." : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Шаблон тоже пишем без длинного тире: он подставляется при сбое ИИ и попадает
  // на сайт наравне с сгенерированным текстом.
  return {
    description: parts,
    metaTitle: `${title}, ${priceStr}`.slice(0, 70),
    metaDescription: `Продажа: ${title}. ${conditionRu}. Цена ${priceStr}. Агентство недвижимости Royal Home, Душанбе.`.slice(0, 160),
    h1: `${title} на продажу`,
    seoDesc: `Продажа ${typeGenitive} ${p.areaSqm} м² в районе ${p.districtName}, ${p.address}. ${conditionRu}. Актуальная цена и фото на сайте Royal Home.`,
  };
}

/** Генерирует продающее описание и SEO-метаданные объекта по его параметрам —
 *  через Claude Haiku (дёшево, быстро). При сбое ИИ отдаёт детерминированный
 *  шаблон, чтобы поля никогда не оставались пустыми (см. "External calls fail gracefully").
 *  options.includeDescription=false — не просить у модели description (используется на
 *  PATCH, где description всё равно отбрасывается вызывающим кодом, см. properties.ts);
 *  description в ответе тогда всегда из бесплатного шаблона, без лишнего токен-расхода. */
export async function generateSeoFields(
  raw: SeoSourceParams,
  options?: { includeDescription?: boolean }
): Promise<SeoFields> {
  // Этаж у дома, «новостройка» у дома и участка, комнаты у участка модели не
  // уходят даже у старых карточек (propertyTypeFields.ts, владелец 08.10.2026).
  const p = visiblePropertyFacts(raw);
  const includeDescription = options?.includeDescription ?? true;
  const typeRu = TYPE_RU[p.type] ?? p.type;
  const conditionRu = CONDITION_RU[p.condition] ?? p.condition;
  const facts = [
    `Тип: ${typeRu}`,
    p.rooms ? `Комнат: ${p.rooms}` : "",
    `Площадь: ${p.areaSqm} м²`,
    p.floor && p.totalFloors ? `Этаж: ${p.floor} из ${p.totalFloors}` : "",
    p.floor == null && p.totalFloors ? `Этажей в доме: ${p.totalFloors}` : "",
    `Цена: ${formatPrice(p.price, p.currency)}`,
    `Район: ${p.districtName}`,
    `Адрес: ${p.address}`,
    propertyHasCondition(p.type) ? `Состояние: ${conditionRu}` : "",
    p.amenities.length ? `Удобства: ${p.amenities.join(", ")}` : "",
    // Подпись, а не ключ базы: модели уходило «Стадия строительства: SHELL».
    p.stage ? `Стадия строительства: ${PROPERTY_STAGE_LABELS[p.stage as PropertyStage] ?? p.stage}` : "",
    p.marketType && p.marketType in MARKET_TYPE_RU
      ? `Рынок: ${MARKET_TYPE_RU[p.marketType as MarketType]}`
      : "",
    p.urgent ? "Срочная продажа" : "",
  ]
    .filter(Boolean)
    .join("\n");

  const result = await callAiText<Partial<SeoFields>>({
    endpoint: "seo-generate",
    // Генерация описания по параметрам — простая задача: у Claude это Haiku.
    simple: true,
    system: buildSystemPrompt(includeDescription),
    user: `Параметры объекта:\n${facts}`,
    maxTokens: includeDescription ? 700 : 500,
    schema: includeDescription ? SEO_SCHEMA : SEO_SCHEMA_NO_DESCRIPTION,
  });

  const fallback = fallbackTemplate(p);
  if (!result) return fallback;

  // Чистим тире уже после выбора значения: подстраховка должна работать и на
  // ответе модели, и на шаблоне, чтобы на сайт ни при каком пути не попал текст
  // с машинной пунктуацией. Обрезаем по длине после чистки: замена тире меняет
  // число символов, иначе можно вылезти за лимит metaTitle.
  return {
    description: stripDashes(
      includeDescription ? result.description?.trim() || fallback.description : fallback.description
    ),
    metaTitle: stripDashes(result.metaTitle?.trim() || fallback.metaTitle).slice(0, 70),
    metaDescription: stripDashes(result.metaDescription?.trim() || fallback.metaDescription).slice(0, 160),
    h1: stripDashes(result.h1?.trim() || fallback.h1),
    seoDesc: stripDashes(result.seoDesc?.trim() || fallback.seoDesc),
  };
}
