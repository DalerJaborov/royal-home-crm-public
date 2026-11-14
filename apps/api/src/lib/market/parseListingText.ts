/**
 * РАЗБОР ОБЪЯВЛЕНИЯ, НАПИСАННОГО ЧЕЛОВЕКОМ.
 *
 * Отличие от somonParser/arzonParser принципиальное: там разбирается разметка
 * сайта, где поля заполнены формой и формат один на все объявления. Здесь — пост
 * из группы Facebook или чата: «3хонагӣ, Фирдавси, 97 квадрат, 950 000 сомонӣ,
 * шахси худам». Регулярным выражением такое не берётся — русский и таджикский
 * идут вперемешку, цена пишется шестью способами, а порядок полей произвольный.
 * Поэтому разбирает модель, а код отвечает за то, чтобы её ответ был проверяем.
 *
 * ГЛАВНОЕ ПРАВИЛО — ПУСТОЕ ПОЛЕ ЧЕСТНЕЕ ВЫДУМАННОГО. Придуманный моделью район
 * попадёт в медиану района и испортит рыночную оценку, а пустой район просто
 * оставит объявление вне разреза по районам. Отсюда закрытый список районов в
 * промте и `null` везде, где текст молчит.
 */

import { callAiText } from "../../ai/client.js";
import { logSystemError } from "../systemError.js";
import { phoneTail, PHONE_TAIL_LEN } from "../clientPhones.js";

/**
 * Районы Душанбе — ЗАКРЫТЫМ СПИСКОМ, а не свободной строкой.
 *
 * Их ровно четыре, и совпадать они обязаны с тем, что пишут парсеры сайтов
 * (см. DISTRICT_ALIASES в somonParser.ts): «И. Сомони» и «Исмоили Сомони» —
 * это один район, но для выборки по districtName это два разных значения, и
 * медиана посчиталась бы по половине рынка.
 */
export const DUSHANBE_DISTRICTS = ["Сино", "Исмоили Сомони", "Фирдавси", "Шохмансур"] as const;

export interface ParsedListingText {
  rooms: number | null;
  areaSqm: number | null;
  floor: number | null;
  totalFloors: number | null;
  districtName: string | null;
  landmark: string | null;
  price: number | null;
  currency: "TJS" | "USD";
  /** Объявление об аренде: каталог аренду не ведёт, такой текст вызывающий код отбрасывает. */
  isRental: boolean;
  propertyType: "APARTMENT" | "HOUSE" | "COMMERCIAL" | "LAND";
  /** Номер продавца из текста, приведённый к +992XXXXXXXXX. */
  sellerPhone: string | null;
  /** Пишет собственник, а не посредник. Собственник — кандидат на эксклюзив. */
  isOwnerPost: boolean;
}

const SYSTEM = `Ты разбираешь объявление о недвижимости в Душанбе, написанное живым человеком.
Текст бывает на русском, на таджикском и вперемешку, часто с опечатками и без знаков препинания.

Верни ТОЛЬКО те поля, которые в тексте действительно есть. Ничего не додумывай:
пустое поле честнее выдуманного. Не уверен — null.

РАЙОН. Разрешены строго четыре значения: "Сино", "Исмоили Сомони", "Фирдавси", "Шохмансур".
Пишут их по-разному ("И. Сомони", "Сомони", "Шомансур", "Firdavsi", "Сино р-н") — приводи к
этим четырём. Всё остальное (микрорайон, улица, "Зарафшон", "Славянский", "82 мкр") — это НЕ
район: клади в landmark, а districtName оставляй null.

ЦЕНА И ВАЛЮТА. "сомонӣ", "сомони", "сом", "с.", "TJS" → TJS. "у.е.", "$", "доллар", "USD" → USD.
Валюта не названа вовсе — считай TJS (здесь так пишут цены в сомони по умолчанию).
Цена — число без пробелов и разрядов. Цена за квадратный метр ценой объявления НЕ является:
если названа только она, price оставь null.

ПЛОЩАДЬ. "97 квадрат", "97 кв", "97 м2", "97 metr", "97 масохат" — это 97 в areaSqm.

ЭТАЖ. "5/9" значит floor=5, totalFloors=9.

АРЕНДА. isRental=true, если это аренда ("иҷора", "ижора", "сдаётся", "в месяц", "моҳона"), иначе false.

ТИП. Квартира → APARTMENT, дом/участок с домом → HOUSE, земля/участок → LAND,
магазин/офис/склад → COMMERCIAL.

ТЕЛЕФОН. Как написан в тексте, цифрами. Нет — null.

СОБСТВЕННИК. isOwnerPost=true, если пишет сам хозяин ("шахси худам", "от хозяина",
"собственник", "без посредников"). Если видно, что это агентство/риелтор, или неясно — false.`;

/**
 * Gemini понимает урезанный OpenAPI-диалект JSON Schema, а не полный стандарт:
 * `type` — всегда ОДНА строка ("integer"/"string"/…), массив `["integer","null"]`
 * роняет весь вызов ошибкой 400 ("Proto field is not repeating") ещё ДО того,
 * как модель увидит текст. Нулевого значения в `enum` тоже нет — за null
 * отвечает то, что поле не входит в `required`: не смогла определить — просто
 * не включает поле в ответ, а не пишет туда null. Убеждались на всех остальных
 * функциях ассистента (ai/assistant.ts) — там тот же паттерн.
 */
const SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    rooms: { type: "integer" },
    areaSqm: { type: "number" },
    floor: { type: "integer" },
    totalFloors: { type: "integer" },
    districtName: { type: "string", enum: DUSHANBE_DISTRICTS },
    landmark: { type: "string", description: "Микрорайон, улица, ориентир — как назван в тексте" },
    price: { type: "number" },
    currency: { type: "string", enum: ["TJS", "USD"] },
    isRental: { type: "boolean" },
    propertyType: { type: "string", enum: ["APARTMENT", "HOUSE", "COMMERCIAL", "LAND"] },
    sellerPhone: { type: "string" },
    isOwnerPost: { type: "boolean" },
  },
  required: ["currency", "isRental", "propertyType", "isOwnerPost"],
};

/**
 * Сколько ждём модель.
 *
 * Свой таймаут поверх клиентского нужен потому, что человек стоит и смотрит в
 * чат: `callAiText` при отказе делает второй заход, и вместе с ним ожидание
 * доходит до минуты — за это время сотрудник решит, что бот умер, и пришлёт
 * объявление ещё раз. Лучше честное «не разобрал» через сорок секунд.
 */
const PARSE_TIMEOUT_MS = 40_000;

/** Длинный пост режем: объявление живёт в первых строках, дальше идут хэштеги и репосты. */
const MAX_TEXT_CHARS = 4000;

/**
 * Разбирает текст поста. `null` — разобрать не удалось (модель молчит или в тексте
 * нет ни цены, ни площади). Именно `null`, а не полупустая структура: объявление
 * без цены и площади не годится ни для сравнения с рынком, ни для поиска дублей,
 * и складывать такое в базу значит засорять её тем, чем нельзя пользоваться.
 */
export async function parseListingText(text: string): Promise<ParsedListingText | null> {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;

  let raw: Partial<ParsedListingText> | null = null;
  try {
    raw = await withTimeout(
      callAiText<Partial<ParsedListingText>>({
        endpoint: "market-listing-parse",
        system: SYSTEM,
        user: trimmed.slice(0, MAX_TEXT_CHARS),
        maxTokens: 500,
        schema: SCHEMA,
        simple: true,
      }),
      PARSE_TIMEOUT_MS
    );
  } catch (err) {
    // Отказ внешнего вызова обязан оставить след: без записи в журнал сломанный
    // разбор выглядит для владельца как «сотрудники перестали присылать объявления».
    void logSystemError("ai", `Разбор объявления из Telegram не удался: ${err instanceof Error ? err.message : err}`);
    return null;
  }
  if (!raw) return null;

  const parsed = sanitize(raw);
  // Ни цены, ни площади — по такому объявлению нельзя ни посчитать TJS/м², ни
  // отличить дубль от нового. Это не «частичный разбор», это его отсутствие.
  if (parsed.price == null && parsed.areaSqm == null) return null;
  return parsed;
}

/**
 * Приводит ответ модели к нашей форме и отсекает то, чему верить нельзя.
 *
 * Схема ответа — просьба, а не гарантия (правило проекта): модель способна
 * вернуть район не из списка, площадь «0» или этаж «1500». Проверяем здесь, а
 * не надеемся на промт.
 */
function sanitize(raw: Partial<ParsedListingText>): ParsedListingText {
  const district =
    typeof raw.districtName === "string" && (DUSHANBE_DISTRICTS as readonly string[]).includes(raw.districtName)
      ? raw.districtName
      : null;

  return {
    rooms: positiveInt(raw.rooms, 30),
    areaSqm: positiveNumber(raw.areaSqm, 10_000),
    floor: positiveInt(raw.floor, 100),
    totalFloors: positiveInt(raw.totalFloors, 100),
    districtName: district,
    landmark: typeof raw.landmark === "string" && raw.landmark.trim() ? raw.landmark.trim().slice(0, 120) : null,
    price: positiveNumber(raw.price, 1_000_000_000),
    currency: raw.currency === "USD" ? "USD" : "TJS",
    isRental: raw.isRental === true,
    propertyType:
      raw.propertyType === "HOUSE" || raw.propertyType === "COMMERCIAL" || raw.propertyType === "LAND"
        ? raw.propertyType
        : "APARTMENT",
    sellerPhone: typeof raw.sellerPhone === "string" ? normalizeTjPhone(raw.sellerPhone) : null,
    isOwnerPost: raw.isOwnerPost === true,
  };
}

function positiveNumber(value: unknown, max: number): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= max ? n : null;
}

function positiveInt(value: unknown, max: number): number | null {
  const n = positiveNumber(value, max);
  return n == null ? null : Math.round(n);
}

/**
 * Номер к виду +992XXXXXXXXX.
 *
 * Считается по последним девяти цифрам — тем же `phoneTail`, которым вся CRM
 * решает «это один и тот же номер». Своё правило сравнения здесь развело бы
 * рыночную базу с карточками клиентов: один и тот же собственник оказался бы
 * разными людьми в зависимости от того, откуда пришёл его номер.
 * Не таджикский номер (меньше девяти цифр — обрывок) отбрасываем: ключ,
 * по которому нельзя искать, хуже пустого поля.
 */
export function normalizeTjPhone(raw: string | null | undefined): string | null {
  const tail = phoneTail(raw ?? "");
  return tail.length === PHONE_TAIL_LEN ? `+992${tail}` : null;
}

/** Промис с явным потолком ожидания — без него зависший вызов держит чат сотрудника. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`превышено ожидание ${ms} мс`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
