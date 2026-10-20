import {
  categoryFromIntent,
  convertToTjs,
  maskPhones,
  MARKET_TYPE_LABELS,
  PROPERTY_CONDITION_LABELS,
  spokenArea,
  spokenFloor,
  spokenPrice,
  type MarketType,
  propertyHasCondition,
  propertyHasMarket,
  visiblePropertyFacts,
} from "@royal-home/shared";
import { prisma } from "../../db.js";
import type { LiveVoiceFunctionDeclaration, LiveVoiceToolCall } from "../../ai/liveVoiceClient.js";
import { recordContactFacts, setContactCategory } from "../contactProfiles.js";
import { loadMoneyContext } from "../money.js";
import { MIN_REAL_PURCHASE_TJS } from "../../ai/moneyThresholds.js";
import {
  BOT_OFFER_SELECT,
  botMayOffer,
  botOfferableWhere,
  botOfferLink,
  findMatchingProperties,
  identifyProperty,
  matchFitNote,
  type MatchPlace,
  type PropertyClues,
  type PropertyMatchQuery,
} from "../propertyMatch.js";
import { resolveSearchPlace } from "../searchPlace.js";
import { describePlace } from "../landmarkPick.js";
import { districtByPoint } from "../propertyDistrict.js";
import { propertyOwnerAgentId } from "../propertyOwner.js";
import { sendSms, toSmsPhone } from "../sms/index.js";
import { findPhoneOwners } from "../clientPhones.js";
import { findStaffPhone } from "../staffPhoneGuard.js";
import { dushanbeStartOfToday } from "../dushanbeTime.js";
import { describeError } from "../describeError.js";
import { logSystemError } from "../systemError.js";
import type { LiveVoiceToolReply } from "./liveVoiceBridge.js";
import { extractPrices, keepSentences } from "../../ai/priceGuard.js";
import { attachGuardFacts, type GuardPropertyFacts } from "./liveVoiceGuards.js";

/**
 * КВАРТИРЫ В ЗВОНКЕ (24.09.2026, робозвонок-консультант, правка 3).
 *
 * Три действия консультанта:
 *  - search_properties — подобрать варианты под запрос покупателя. ТЕМ ЖЕ запросом,
 *    что чат-бот (lib/propertyMatch.ts): в WhatsApp и по телефону под одну просьбу
 *    называются одни и те же квартиры;
 *  - get_property — рассказать про объект, о котором спрашивают («номер сто
 *    двенадцать», «в Пайкаре на Сомони»), тем же поиском, что распознаёт объект
 *    в расшифровке звонка (resolveCallPropertyHint), и назвать агента, который его
 *    ведёт;
 *  - send_property_sms — прислать звонящему ссылки на обсуждённые квартиры.
 *
 * Что человек искал (район, тип, комнаты, бюджет), ложится в его ДОСЬЕ — то же, что
 * ведёт чат-бот (lib/contactProfiles.ts). Досье сходится по номеру: написал потом в
 * WhatsApp — бот уже знает, что он искал по телефону, и наоборот (Dan 24.09: «чтобы
 * клиента узнавали везде, где он обратится снова»).
 *
 * Остальное о квартирах:
 *    WhatsApp первым написать человеку не даёт (правила Meta), а СМС в CRM
 *    работают (lib/sms, 23.09.2026) — решение владельца 24.09: «может отправим смс».
 *
 * Что можно говорить по телефону: только то, что и так опубликовано — на сайте или
 * в соцсетях (правило одно на все каналы: lib/propertyMatch.ts::botMayOffer, решение
 * владельца 10.10.2026). Остальное — «подробности даст агент», без цены и адреса:
 * звонить может кто угодно, а закрытые карточки агенты показывают своим клиентам
 * личной ссылкой. Телефонов собственников в ответах нет вовсе — их модель не может
 * назвать, потому что не видит.
 *
 * Номер объекта модель видит (чтобы ссылаться на него в следующих вызовах), но
 * вслух не называет — то же правило, что у чат-бота.
 */

export const LIVE_VOICE_DISTRICTS = ["Исмоили Сомони", "Сино", "Фирдавси", "Шохмансур"] as const;

/** Больше трёх вариантов на слух не запомнить. */
const OPTIONS_PER_SEARCH = 3;
/** В одном СМС — не больше трёх ссылок: кириллица по 70 знаков на платную часть. */
const SMS_MAX_PROPERTIES = 3;
/**
 * Сколько СМС со ссылками робот шлёт на ОДИН номер за сутки по Душанбе
 * (02.10.2026, защита от СМС-бомбинга). «Один раз за звонок» (smsSent) держит
 * только один звонок: звонящий кладёт трубку, набирает снова, диктует тот же
 * чужой номер — и каждый раз жертве уходит СМС от имени агентства и за его
 * деньги. Предел считается по журналу отправок (SmsMessage), то есть по всем
 * звонкам и линиям сразу, а не по памяти одного разговора.
 */
export const SMS_PER_RECIPIENT_PER_DAY = 2;

/** Обещание звонка агента — не больше одного раза за разговор (02.10.2026, жалоба владельца
 *  «отдаёт агента сразу, нагло»: каждый ответ функции заново диктовал «агент перезвонит»). */
export const AGENT_CALLBACK_ONCE =
  "если в этом звонке ещё не звучало, что агент наберёт сам, скажи это один раз своими словами; уже звучало — не повторяй";

export const PROPERTY_TOOLS: LiveVoiceFunctionDeclaration[] = [
  {
    name: "search_properties",
    description:
      "Найти в продаже квартиры, дома, участки и коммерческие помещения под запрос покупателя (аренды в каталоге нет). Вызывай, когда известен хотя бы район, ориентир или тип, " +
      "не дожидаясь всех подробностей; узнал новое (бюджет, комнаты) — вызови снова. Ориентир или народное название («Профсоюз», «82 мкр», " +
      "«у Зелёного базара») передай в landmark словами человека — район по карте определит поиск, сам не угадывай. Пока идёт поиск, можно коротко сказать по смыслу «секунду, гляну» (своими словами, не одной и той же фразой).",
    parameters: {
      type: "OBJECT",
      properties: {
        district: { type: "STRING", description: "Официальный район Душанбе, если назван словом.", enum: [...LIVE_VOICE_DISTRICTS] },
        landmark: { type: "STRING", description: "Ориентир, микрорайон, улица или народное название — словами звонящего." },
        suburban: { type: "BOOLEAN", description: "true — ищет за городом (Вахдат, Варзоб, Гиссар, дача)." },
        sort: { type: "STRING", description: "cheap — просит подешевле / самое дешёвое.", enum: ["cheap"] },
        renovation: { type: "STRING", description: "with — с ремонтом, without — без ремонта (коробка).", enum: ["with", "without"] },
        market: { type: "STRING", description: "NEW_BUILD — новостройка, SECONDARY — вторичка.", enum: ["NEW_BUILD", "SECONDARY"] },
        furniture: { type: "BOOLEAN", description: "true — нужна мебель, false — без мебели." },
        parking: { type: "BOOLEAN", description: "true — нужна парковка." },
        type: {
          type: "STRING",
          description: "APARTMENT — квартира, HOUSE — дом, COMMERCIAL — коммерческое, LAND — участок.",
          enum: ["APARTMENT", "HOUSE", "COMMERCIAL", "LAND"],
        },
        rooms: { type: "INTEGER", description: "Сколько комнат просит." },
        budget_max: { type: "NUMBER", description: "Сколько человек готов заплатить максимум — числом, без слов." },
        budget_min: { type: "NUMBER", description: "Нижняя граница бюджета, если назвал «от … до …»." },
        currency: {
          type: "STRING",
          description:
            "В чём назван бюджет: USD — доллары, TJS — сомони. Передавай ТОЛЬКО если человек назвал валюту словом " +
            "(«долларов», «сомони», «баксов»). Назвал сумму без слова валюты («до шестидесяти тысяч») — поле НЕ передавай: " +
            "ответ попросит переспросить, и тогда спроси «в долларах или в сомони?».",
          enum: ["USD", "TJS"],
        },
      },
    },
  },
  {
    name: "get_property",
    description:
      "Узнать конкретный объект, о котором спрашивает человек (видел объявление). Передай ВСЁ, что он назвал: номер, ЖК " +
      "или адрес — в query; ориентир — в landmark («у фабрики Гулдаст», «82 мкр»); цену, комнаты, этаж, площадь, район. " +
      "Чем больше примет, тем точнее. Также — подробнее про вариант из search_properties (передай его number в query). " +
      "Подходят несколько — ответ даст кандидатов: переспроси по примете, которая их различает.",
    parameters: {
      type: "OBJECT",
      properties: {
        query: { type: "STRING", description: "Номер объекта цифрами, название ЖК или улица с домом — словами звонящего." },
        landmark: { type: "STRING", description: "Ориентир словами звонящего: возле чего стоит дом." },
        district: { type: "STRING", description: "Официальный район Душанбе, если назван.", enum: [...LIVE_VOICE_DISTRICTS] },
        type: {
          type: "STRING",
          description: "APARTMENT — квартира, HOUSE — дом, COMMERCIAL — коммерческое, LAND — участок.",
          enum: ["APARTMENT", "HOUSE", "COMMERCIAL", "LAND"],
        },
        rooms: { type: "INTEGER", description: "Сколько комнат в объявлении." },
        floor: { type: "INTEGER", description: "Этаж." },
        area: { type: "NUMBER", description: "Площадь в квадратных метрах." },
        price: { type: "NUMBER", description: "Цена из объявления числом, без слов." },
        currency: {
          type: "STRING",
          description: "В чём названа цена: USD — доллары, TJS — сомони. Не назвал — TJS.",
          enum: ["USD", "TJS"],
        },
      },
    },
  },
  {
    name: "send_property_sms",
    description:
      "Отправить звонящему СМС со ссылками на квартиры, которые вы обсудили (фото, видео, карта). Только если человек " +
      "согласился («да, скиньте»). Один раз за звонок.",
    parameters: {
      type: "OBJECT",
      properties: {
        numbers: {
          type: "STRING",
          description: "Номера объектов из search_properties/get_property через запятую. Не передан — все обсуждённые.",
        },
      },
    },
  },
];

/** Что осталось от квартир после звонка — для агента и для СМС. */
export interface PropertyCallMemory {
  /** Номера объектов, которые консультант назвал или о которых рассказывал, по порядку. */
  discussedShortIds: number[];
  /** Номер, на который звонят (со звонка) — для СМС. */
  callerPhone: string | null;
  /** Номер, который человек продиктовал сам (save_contact) — важнее номера звонка. */
  otherPhone: string | null;
  clientId: string | null;
  /** Досье звонящего — общее с чат-ботом; null — номер скрыт. */
  contactProfileId: string | null;
  smsSent: boolean;
  /**
   * Объект, который консультант УЗНАЛ (get_property) и чьего агента назвал
   * человеку (24.09.2026). Отдельно от discussedShortIds: туда попадают и
   * варианты из поиска. После звонка лид уходит агенту именно этого объекта,
   * а не тому, кого выберет повторное узнавание по расшифровке.
   */
  identifiedPropertyId: string | null;
  /**
   * Агент, которого консультант НАЗВАЛ человеку как ведущего объект («этот объект
   * ведёт Нурмухаммад», 02.10.2026). Ему и ставится задача «перезвонить»: человеку
   * пообещали звонок именно этого агента, а не того, кто ведёт его самого. null —
   * никого не называли (закрытый объект без агента, агент отключён или заморожен).
   */
  namedAgentId: string | null;
  /**
   * Сколько раз за звонок поиск просил переспросить валюту бюджета (`needs_currency`,
   * третий аудит 02.10.2026, С3). Больше одного раза не просим: ответ «не знаю» или
   * «в рублях» валютой не становится (enum знает только USD/TJS), и без счётчика круг
   * «переспроси → поиск → переспроси» шёл до потолка звонка.
   */
  currencyAsked?: number;
  /** Звонящему можно по-таджикски (liveVoiceForceRussianOnly выключен): тогда рядом с
   *  ценой/площадью/этажом словами идут те же слова по-таджикски (поля *_tg). */
  tajikAllowed?: boolean;
  /** Что звонящий ищет — структурно, для агента (save_client_request, liveVoiceClientTools.ts). */
  request?: ClientCallRequest | null;
  /** Перезвон на время, которое человек выбрал сам (request_callback). */
  callbackAt?: Date | null;
  callbackTopic?: string | null;
  /** Просьба о показе, которую робот НЕ записал сам (нет карточки или показы боту
   *  выключены): агенту — задача подтвердить ровно это время. */
  showingWish?: { shortId: number; at: Date } | null;
  /** Показ, который робот записал в CRM в этом звонке. */
  bookedShowing?: { shortId: number; at: Date; interactionId: string } | null;
  /** Карточка объекта ушла в переписку (WhatsApp/Telegram) — один раз за звонок. */
  messengerSent?: boolean;
}

/** Условия звонящего словами функции — всё необязательное. */
export interface ClientCallRequest {
  intent?: "buy" | "sell";
  districtName?: string;
  type?: string;
  rooms?: number;
  budgetMin?: number;
  budgetMax?: number;
  currency?: "USD" | "TJS";
  floor?: string;
  market?: string;
  condition?: string;
  timeframe?: string;
  notes?: string;
}

export function newPropertyCallMemory(
  init: Pick<PropertyCallMemory, "callerPhone" | "clientId"> & { contactProfileId?: string | null; tajikAllowed?: boolean }
): PropertyCallMemory {
  return { discussedShortIds: [], otherPhone: null, smsSent: false, contactProfileId: null, identifiedPropertyId: null, namedAgentId: null, currencyAsked: 0, ...init };
}

/**
 * Запрос покупателя — в досье, теми же ключами, что пишет чат-бот
 * (lib/contactProfileMemory.ts, BUYER_KEYS): бюджет в сомони, официальный район,
 * тип, комнаты. Источник «model», как у бота: запись агента догадкой не
 * перебивается (recordContactFacts). Не бросает: досье — память, а не разговор.
 */
async function rememberBuyerRequest(profileId: string | null, query: PropertyMatchQuery): Promise<void> {
  if (!profileId) return;
  try {
    await recordContactFacts({
      profileId,
      domain: "buyer",
      values: {
        intent: "buy",
        districtName: query.districtName ?? undefined,
        type: query.type ?? undefined,
        rooms: query.rooms ?? undefined,
        budgetMin: query.budgetMin ?? undefined,
        budgetMax: query.budgetMax ?? undefined,
      },
      source: "model",
      conversationId: null,
    });
    const category = categoryFromIntent("buy");
    if (category) await setContactCategory({ profileId, category, source: "model", conversationId: null });
  } catch (err) {
    void logSystemError("contact-profile", `Консультант: запрос покупателя в досье не записан: ${describeError(err)}`);
  }
}

function remember(memory: PropertyCallMemory, shortId: number): void {
  if (!memory.discussedShortIds.includes(shortId)) memory.discussedShortIds.push(shortId);
}

/** Цена для СМС и списка вариантов: числом и словом валюты. В речь модели цена идёт
 *  словами (voiceFacts ниже). */
function priceText(price: unknown, currency: string): string {
  const n = Math.round(Number(price)).toLocaleString("ru-RU").replace(/ /g, " ");
  return currency === "USD" ? `${n} долларов` : `${n} сомони`;
}

function floorText(p: { floor: number | null; totalFloors: number | null }): string | null {
  if (!p.floor) return null;
  return p.totalFloors ? `${p.floor} из ${p.totalFloors}` : String(p.floor);
}

/**
 * ЦЕНА, ПЛОЩАДЬ И ЭТАЖ — СЛОВАМИ (03.10.2026, аудит робота). Модели они уходят
 * готовой речью: «сорок пять тысяч долларов», «шестьдесят два с половиной
 * квадрата», «пятый этаж из девяти». Цифрами синтезатор читал их по-разному, а
 * просьба промта говорить словами выполнялась через раз. Можно таджикский — рядом
 * то же по-таджикски (поля *_tg).
 */
function voiceFacts(
  p: { price?: unknown; currency?: string; areaSqm: unknown; floor: number | null; totalFloors: number | null },
  tajik: boolean,
  withPrice: boolean,
  /** Курс из Настроек: долларовой цене рядом кладётся она же в сомони (P1-6). */
  usdToTjs?: number
): Record<string, string | null> {
  const area = Number(p.areaSqm);
  // ДОЛЛАРЫ В СОМОНИ — КОДОМ, А НЕ В УМЕ (09.10.2026, аудит P1-6): 03.10 модель
  // пересчитала «150 000 $» в «1 389 000 сомони» сама, с ошибкой. Пересчёт тот же, что
  // у всей CRM (convertToTjs, packages/shared/src/money.ts).
  const tjs = withPrice && p.currency === "USD" && usdToTjs && usdToTjs > 0 ? Math.round(convertToTjs(p.price, "USD", usdToTjs)) : null;
  const facts: Record<string, string | null> = {
    price: withPrice && p.currency ? spokenPrice(Number(p.price), p.currency, "ru") : null,
    ...(tjs !== null ? { price_tjs: spokenPrice(tjs, "TJS", "ru") } : {}),
    area: area > 0 ? spokenArea(area, "ru") : null,
    floor: p.floor ? spokenFloor(p.floor, p.totalFloors, "ru") : null,
  };
  if (tajik) {
    facts.price_tg = withPrice && p.currency ? spokenPrice(Number(p.price), p.currency, "tg") : null;
    if (tjs !== null) facts.price_tjs_tg = spokenPrice(tjs, "TJS", "tg");
    facts.area_tg = area > 0 ? spokenArea(area, "tg") : null;
    facts.floor_tg = p.floor ? spokenFloor(p.floor, p.totalFloors, "tg") : null;
  }
  return facts;
}

/** Приписка к ответу, где есть долларовые цены: в сомони — только готовое поле. */
const PRICE_TJS_NOTE = " Цену в сомони сам не пересчитывай: если спросят в сомони, бери готовое price_tjs.";

/** Сырые числа объекта для сторожа «вне подборки» (liveVoiceGuards.ts) — модель их не видит. */
function guardFacts(
  p: { price?: unknown; currency?: string; areaSqm: unknown; floor: number | null; totalFloors: number | null },
  withPrice: boolean,
  usdToTjs?: number
): GuardPropertyFacts[] {
  const area = Number(p.areaSqm);
  const price = withPrice ? Number(p.price) : NaN;
  const base: GuardPropertyFacts = {
    price: Number.isFinite(price) && price > 0 ? price : null,
    currency: withPrice ? (p.currency ?? null) : null,
    areaSqm: area > 0 ? area : null,
    floor: p.floor ?? null,
    totalFloors: p.totalFloors ?? null,
  };
  if (base.price !== null && p.currency === "USD" && usdToTjs && usdToTjs > 0) {
    return [base, { price: Math.round(convertToTjs(p.price, "USD", usdToTjs)), currency: "TJS", areaSqm: null, floor: null, totalFloors: null }];
  }
  return [base];
}

/**
 * УЛИЦА БЕЗ НОМЕРА ДОМА И КВАРТИРЫ (09.10.2026, аудит P1-9). Адрес идёт модели как
 * ориентир («Айни», «82 мкр»), а «дом 45, кв. 12» по телефону не называются — раньше
 * запрет стоял только в ответе get_property, а поиск отдавал адрес целиком.
 */
export function streetWithoutHouse(address: string | null | undefined): string | null {
  const cut = (address ?? "")
    .trim()
    .replace(/[,\s]+(?:(?:д|дом|кв|квартира|корп|корпус)(?=[.\s\d]|$)|№).*$/iu, "")
    .replace(/[,\s]+\d+\p{L}?(?:\/\d+)?(?=\s*(?:,|$)).*$/u, "")
    .trim();
  return cut || null;
}

function place(p: { district: { name: string } | null; address: string | null; landmark?: string | null }): string {
  return [p.district?.name, streetWithoutHouse(p.address), p.landmark?.trim()].filter(Boolean).join(", ") || "район не указан";
}

/**
 * ОПИСАНИЕ АГЕНТА — БЕЗ ТЕЛЕФОНОВ И СУММ (09.10.2026, аудит P1-9). Свободный текст
 * карточки: в нём бывают телефон собственника и «другая цена», и такая цена для
 * сторожа «законная» (пришла из функции). Телефоны — тем же maskPhones, что у исходящих
 * сообщений; предложения с суммой — вон тем же разбором цен, что у чат-бота.
 */
export function descriptionForVoice(description: string | null | undefined): string | null {
  const text = (description ?? "").trim().slice(0, 400);
  if (!text) return null;
  const cleaned = keepSentences(maskPhones(text).text, (sentence) => extractPrices(sentence).length === 0).trim();
  return cleaned || null;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[^\d.]/g, "")) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Функции квартир. null — функция не отсюда. Не бросает: отказ базы — ответ
 *  модели «не получилось», а не тишина в трубке. */
export async function handlePropertyTool(
  memory: PropertyCallMemory,
  call: LiveVoiceToolCall
): Promise<LiveVoiceToolReply | null> {
  try {
    if (call.name === "search_properties") return await searchTool(memory, call.args);
    if (call.name === "get_property") return await getTool(memory, call.args);
    if (call.name === "send_property_sms") return await smsTool(memory, call.args);
    return null;
  } catch (err) {
    if (!["search_properties", "get_property", "send_property_sms"].includes(call.name)) throw err;
    void logSystemError("telephony", `Консультант: ${call.name} не выполнен: ${describeError(err)}`);
    return {
      response: { ok: false, error: `база сейчас не ответила — ${AGENT_CALLBACK_ONCE}` },
      scheduling: "WHEN_IDLE",
    };
  }
}

/** Приписка к ответу поиска, когда валюту бюджета человек так и не назвал, а переспрашивать больше нельзя. */
const ASSUMED_DOLLARS_NOTE = (assumed: boolean): string =>
  assumed
    ? " ВАЛЮТУ БЮДЖЕТА человек не назвал — искали в долларах (в сомони такая сумма не бюджет покупки). Называй цены с валютой и не утверждай, что он имел в виду именно доллары."
    : "";

/**
 * ЗАПРОС ГОЛОСА — ИЗ АРГУМЕНТОВ МОДЕЛИ, МЕСТО РАЗБИРАЕТ КОД (10.10.2026, аудит поиска
 * P0-3). Карты города у робота в промте нет: раньше он сам переводил «82 мкр» в район
 * «из головы». Теперь ориентир приходит словами (landmark) и разбирается тем же
 * resolveSearchPlace, что и реплика чат-бота (lib/searchPlace.ts): район словом,
 * точка с карты, народное название, «за городом». Без бюджета — он ниже, с валютой.
 */
export async function voiceSearchQuery(
  args: Record<string, unknown>
): Promise<{ query: Omit<PropertyMatchQuery, "budgetMax" | "budgetMin">; landmark: string | null }> {
  const landmark = typeof args.landmark === "string" && args.landmark.trim() ? args.landmark.trim() : null;
  const resolved = await resolveSearchPlace(landmark);
  const type = typeof args.type === "string" && ["APARTMENT", "HOUSE", "COMMERCIAL", "LAND"].includes(args.type) ? args.type : null;
  const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
    typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;
  return {
    landmark,
    query: {
      districtName: LIVE_VOICE_DISTRICTS.find((d) => d === args.district) ?? resolved.districtName ?? resolved.placeDistrictName,
      type,
      rooms: typeof args.rooms === "number" && args.rooms > 0 ? Math.round(args.rooms) : null,
      place: resolved.place,
      placeText: landmark,
      suburban: args.suburban === true || resolved.suburban,
      sort: pick(args.sort, ["cheap"] as const),
      renovation: pick(args.renovation, ["with", "without"] as const),
      market: pick(args.market, ["NEW_BUILD", "SECONDARY"] as const),
      furniture: typeof args.furniture === "boolean" ? args.furniture : null,
      parking: typeof args.parking === "boolean" ? args.parking : null,
    },
  };
}

async function searchTool(memory: PropertyCallMemory, args: Record<string, unknown>): Promise<LiveVoiceToolReply> {
  const { query: baseQuery, landmark } = await voiceSearchQuery(args);
  // Как у чат-бота: без района, места и типа не ищем — «что у вас есть» это весь каталог,
  // и первые три строки из него ничего не говорят человеку.
  if (!baseQuery.districtName && !baseQuery.type && !baseQuery.place && !baseQuery.suburban) {
    return {
      response: {
        ok: false,
        error: landmark
          ? "такого места на карте не нашли: переспроси район или ближайший известный ориентир"
          : "мало данных: сначала узнай район или хотя бы что ищет — квартиру, дом, участок",
      },
      scheduling: "WHEN_IDLE",
    };
  }
  // Бюджет запроса — в сомони; назван в долларах — переводим по тому же курсу, что
  // в справочнике.
  // Регистр не важен: «usd» тоже названная валюта (третий аудит, С3), а не «не названа».
  const currencyArg = typeof args.currency === "string" ? args.currency.trim().toUpperCase() : "";
  const usd = currencyArg === "USD";
  const rate = usd ? (await loadMoneyContext()).usdToTjs : 1;
  const toTjs = (v: unknown, r: number) => {
    const n = num(v);
    return n === null ? null : Math.round(n * r);
  };
  const budgetQuery = (r: number): PropertyMatchQuery => ({
    ...baseQuery,
    budgetMax: toTjs(args.budget_max, r),
    budgetMin: toTjs(args.budget_min, r),
  });
  let query = budgetQuery(rate);
  const searchOptions = { alreadyShownShortIds: memory.discussedShortIds, limit: OPTIONS_PER_SEARCH };

  // ВАЛЮТА НЕ НАЗВАНА — НЕ УГАДЫВАЕМ СОМОНИ (аудит 02.10.2026, №10). «До шестидесяти
  // тысяч» без слова «долларов» считалось 60 000 сомони (~$5,5 тыс.), и робот честно
  // отвечал «ничего нет» человеку, который имел в виду доллары. Правило то же, что
  // у текстового бота (ai/moneyThresholds.ts): сумма в сомони ниже MIN_REAL_PURCHASE_TJS
  // — не бюджет покупки, а непонятная валюта; кроме того, пустой поиск в сомони при
  // непустом в долларах — тот же признак. В обоих случаях робот спрашивает, а
  // запрос в досье НЕ пишется: бюджет с неверной валютой хуже пустого.
  const statedBudget = Math.max(num(args.budget_max) ?? 0, num(args.budget_min) ?? 0);
  const currencyNamed = currencyArg === "USD" || currencyArg === "TJS";
  let assumedDollars = false;
  if (!currencyNamed && statedBudget > 0) {
    const asUsdRate = (await loadMoneyContext()).usdToTjs;
    const tooSmallForSomoni = statedBudget < MIN_REAL_PURCHASE_TJS;
    let suggestsDollars = tooSmallForSomoni;
    if (!suggestsDollars) {
      const inSomoni = await findMatchingProperties(query, { ...searchOptions, limit: 1 });
      if (inSomoni.length === 0) {
        suggestsDollars = (await findMatchingProperties(budgetQuery(asUsdRate), { ...searchOptions, limit: 1 })).length > 0;
      }
    }
    if (suggestsDollars && (memory.currencyAsked ?? 0) >= 1) {
      // Уже спрашивали, а валюта так и не названа: считаем так, как подсказывает сам
      // запрос (в сомони — явно не бюджет покупки), и говорим об этом модели.
      assumedDollars = true;
      query = budgetQuery(asUsdRate);
    } else if (suggestsDollars) {
      memory.currencyAsked = (memory.currencyAsked ?? 0) + 1;
      return {
        response: {
          ok: false,
          needs_currency: true,
          error:
            "валюта бюджета не названа — не угадывай. Спроси человека одной фразой: «в долларах или в сомони?» — " +
            "и вызови поиск снова, передав currency по его ответу",
        },
        scheduling: "WHEN_IDLE",
      };
    }
  }

  await rememberBuyerRequest(memory.contactProfileId, query);
  // Поля, которых у типа нет (этаж у дома, «новостройка» у дома), робот не
  // называет даже у старых карточек (propertyTypeFields.ts).
  const found = (await findMatchingProperties(query, searchOptions)).map((p) => visiblePropertyFacts(p));
  if (found.length === 0) {
    return {
      response: {
        ok: true,
        found: 0,
        note: "Под такой запрос сейчас в продаже ничего нет — подходящих объектов нет: не называй адреса, площади, этажи и цены и не придумывай варианты. Скажи честно; предложи смягчить условие (соседний район, бюджет) или спроси, удобно ли, чтобы агент подобрал и набрал, когда появится." + ASSUMED_DOLLARS_NOTE(assumedDollars),
      },
      scheduling: "WHEN_IDLE",
    };
  }
  found.forEach((p) => remember(memory, p.shortId));
  const usdToTjs = (await loadMoneyContext()).usdToTjs;
  const anyUsd = found.some((p) => p.currency === "USD");
  const response = {
    ok: true,
    found: found.length,
    // Где названное место — по карте, та же строка, что у чат-бота (describePlace).
    ...(baseQuery.place ? { asked_place: await askedPlaceLine(baseQuery.place) } : {}),
    options: found.map((p) => ({
      number: p.shortId,
      rooms: p.rooms,
      where: place(p),
      ...voiceFacts(p, !!memory.tajikAllowed, true, usdToTjs),
      market: p.marketType ? MARKET_TYPE_LABELS[p.marketType as MarketType] : null,
      // Честная пометка подбора: «на комнату больше», «чуть дороже бюджета», «за городом».
      fit: matchFitNote(p.match),
    })),
    note:
      "Назови ОДИН вариант, который подходит лучше всего, коротко и живо, не больше двух предложений: где, сколько комнат, цена. " +
      "Числа произноси словами («шестьдесят два с половиной квадрата», «пятый этаж из девяти»). Не зачитывай всё подряд и не называй номер объекта. " +
      "Ориентир (район, улицу, что рядом) назвать можно, а номер дома и квартиры — нет. " +
      "Есть у варианта fit — скажи это честно одной фразой (например, что комнат на одну больше). " +
      "Спроси, что откликается; не подошёл — расскажи про следующий. Интересно — предложи прислать ссылки по СМС (send_property_sms)." +
      (anyUsd ? PRICE_TJS_NOTE : "") +
      ASSUMED_DOLLARS_NOTE(assumedDollars),
  };
  return {
    response: attachGuardFacts(response, found.flatMap((p) => guardFacts(p, true, usdToTjs))),
    scheduling: "WHEN_IDLE",
  };
}

/** «82-й микрорайон, рядом Мехргон (район Сино)» — тем же describePlace, что подписывает
 *  места чат-боту (ai/geoMentions.ts) и объекты на карте. */
async function askedPlaceLine(p: MatchPlace): Promise<string> {
  const [described, district] = await Promise.all([describePlace(p.lat, p.lng), districtByPoint(p.lat, p.lng)]);
  return `${p.name} — ${described.text || "место на карте"}${district ? ` (район ${district.name})` : ""}`;
}

/** Приметы из аргументов модели — в вопрос общему узнаванию (lib/propertyMatch.ts),
 *  тому же, что разбирает звонок оператору: консультант и оператор узнают объект
 *  одинаково. */
async function cluesFromArgs(args: Record<string, unknown>): Promise<PropertyClues> {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() || null : typeof v === "number" ? String(v) : null);
  const int = (v: unknown) => {
    const n = num(v);
    return n === null ? null : Math.round(n);
  };
  const price = num(args.price);
  const rate =
    price !== null && typeof args.currency === "string" && args.currency.trim().toUpperCase() === "USD"
      ? (await loadMoneyContext()).usdToTjs
      : 1;
  return {
    text: str(args.query),
    place: str(args.landmark),
    districtName: LIVE_VOICE_DISTRICTS.find((d) => d === args.district) ?? null,
    type: typeof args.type === "string" && ["APARTMENT", "HOUSE", "COMMERCIAL", "LAND"].includes(args.type) ? args.type : null,
    rooms: int(args.rooms),
    floor: int(args.floor),
    areaSqm: num(args.area),
    priceTjs: price === null ? null : Math.round(price * rate),
  };
}

/** Кандидаты на переспрос — только различающие приметы. Объект, который ботам
 *  предлагать нельзя (botMayOffer), — без цены и адреса, как в самом ответе. */
async function candidatesForAsking(ids: string[], tajik: boolean, usdToTjs: number) {
  const rows = await prisma.property.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      type: true,
      rooms: true,
      floor: true,
      totalFloors: true,
      areaSqm: true,
      price: true,
      currency: true,
      address: true,
      landmark: true,
      ...BOT_OFFER_SELECT,
      district: { select: { name: true } },
    },
  });
  const visible = ids
    .map((id) => rows.find((r) => r.id === id))
    .filter((p): p is (typeof rows)[number] => !!p)
    .map((p) => visiblePropertyFacts(p));
  return {
    list: visible.map((p) => ({
      rooms: p.rooms,
      ...voiceFacts(p, tajik, botMayOffer(p), usdToTjs),
      where: botMayOffer(p) ? place(p) : p.district?.name ?? null,
    })),
    facts: visible.flatMap((p) => guardFacts(p, botMayOffer(p), usdToTjs)),
  };
}

async function getTool(memory: PropertyCallMemory, args: Record<string, unknown>): Promise<LiveVoiceToolReply> {
  const clues = await cluesFromArgs(args);
  if (!clues.text && !clues.place && !clues.priceTjs && !clues.rooms && !clues.areaSqm) {
    return {
      response: { ok: false, error: "нечего искать: спроси номер объявления, адрес или ориентир, цену, комнаты" },
      scheduling: "WHEN_IDLE",
    };
  }
  const found = await identifyProperty(clues);
  const id = found.propertyId;
  const usdToTjs = (await loadMoneyContext()).usdToTjs;
  if (!id) {
    const asked =
      found.candidates.length > 1
        ? await candidatesForAsking(found.candidates.map((c) => c.id), !!memory.tajikAllowed, usdToTjs)
        : { list: [], facts: [] };
    const candidates = asked.list;
    const response = {
      ok: true,
      found: false,
      ...(candidates.length > 1 ? { candidates } : {}),
      note:
        candidates.length > 1
          ? "Подходят несколько объектов. Переспроси ОДНОЙ приметой, которая их различает (этаж, метры, ориентир, цена), и вызови get_property снова со всеми приметами. Номера не называй."
          : "Такого объекта не нашли — не называй адрес, площадь, этаж и цену по памяти. Уточни ориентир, адрес или номер из объявления; не нашли и так — спроси, удобно ли, чтобы агент нашёл его и набрал.",
    };
    return { response: attachGuardFacts(response, candidates.length > 1 ? asked.facts : []), scheduling: "WHEN_IDLE" };
  }
  const p = await prisma.property.findUnique({
    where: { id },
    include: {
      district: { select: { name: true } },
      intakeAgent: { select: { fullName: true, isActive: true, frozenAt: true } },
      assignedAgent: { select: { fullName: true, isActive: true, frozenAt: true } },
      createdBy: { select: { fullName: true, isActive: true, frozenAt: true } },
    },
  });
  if (!p) return { response: { ok: true, found: false }, scheduling: "WHEN_IDLE" };
  remember(memory, p.shortId);
  // Проданный не ведёт к агенту — консультант предлагает похожие.
  if (p.status !== "SOLD") memory.identifiedPropertyId = p.id;

  if (p.status === "SOLD") {
    return {
      response: {
        ok: true,
        found: true,
        sold: true,
        note: "Этот объект уже продан. Скажи честно и предложи похожие: узнай, что важно, и вызови search_properties.",
      },
      scheduling: "WHEN_IDLE",
    };
  }

  // Агент объекта — тот, кого выбирает раздача лидов (lib/propertyOwner.ts).
  const ownerId = propertyOwnerAgentId(p);
  const owner = [p.intakeAgent, p.assignedAgent, p.createdBy].find(
    (a, i) => a && [p.intakeAgentId, p.assignedAgentId, p.createdById][i] === ownerId
  );
  // Уволенного и замороженного (отпуск) не называем: обещать звонок человека, который
  // не работает, значит потерять клиента (02.10.2026).
  const agentName = owner?.isActive && !owner.frozenAt && owner.fullName.trim() ? owner.fullName.trim().split(/\s+/)[0] : null;
  // Назвали агента — запоминаем КОГО: задача «перезвонить» после звонка уйдёт ему.
  if (agentName && ownerId) memory.namedAgentId = ownerId;

  // Что можно называть по телефону — один флаг (lib/propertyMatch.ts::botMayOffer, P0-5).
  if (!botMayOffer(p)) {
    return {
      response: {
        ok: true,
        found: true,
        number: p.shortId,
        closed: true,
        agent: agentName,
        note: "Этот объект показываем только лично: цену, адрес и подробности по телефону не называй — их скажет агент, который его ведёт. Предложи, чтобы этот агент набрал, и дождись ответа.",
      },
      scheduling: "WHEN_IDLE",
    };
  }
  const facts = visiblePropertyFacts(p);
  const response = {
    ok: true,
    found: true,
    number: p.shortId,
    status: p.status === "RESERVED" ? "в брони — может освободиться, агент скажет" : "в продаже",
    rooms: facts.rooms,
    where: place(p),
    ...voiceFacts(facts, !!memory.tajikAllowed, true, usdToTjs),
    market: propertyHasMarket(p.type) && p.marketType ? MARKET_TYPE_LABELS[p.marketType as MarketType] : null,
    condition: propertyHasCondition(p.type) ? PROPERTY_CONDITION_LABELS[p.condition] : null,
    description: descriptionForVoice(p.description),
    agent: agentName,
    note:
      "Расскажи коротко, не больше двух предложений, отвечая на то, что спросили, а не всю карточку. Числа произноси словами. " +
      // Справочник говорит «торг есть всегда», а про КОНКРЕТНУЮ квартиру по телефону это
      // звучит как обещание (аудит P2-2).
      "Торг и скидку не обсуждай: спросят про торг — «торг обсуждает агент с собственником, обычно после просмотра». " +
      "Ориентир (район, улицу, что рядом) назвать можно, а номер дома и квартиры — нет. Показ и точный адрес — через агента" +
      (agentName ? `: этот объект ведёт ${agentName}.` : ".") +
      " Звонок агента не обещай, пока человек сам не захотел посмотреть или поговорить подробнее." +
      (p.currency === "USD" ? PRICE_TJS_NOTE : ""),
  };
  return { response: attachGuardFacts(response, guardFacts(facts, true, usdToTjs)), scheduling: "WHEN_IDLE" };
}

async function smsTool(memory: PropertyCallMemory, args: Record<string, unknown>): Promise<LiveVoiceToolReply> {
  if (memory.smsSent) {
    return { response: { ok: false, error: "СМС в этом звонке уже отправлено — второй раз не шлём" }, scheduling: "WHEN_IDLE" };
  }
  const phone = memory.otherPhone ?? memory.callerPhone;
  const smsPhone = toSmsPhone(phone);
  if (!phone || !smsPhone) {
    return {
      response: { ok: false, error: `номер для СМС неизвестен или не таджикский — ссылки пришлёт агент; ${AGENT_CALLBACK_ONCE}` },
      scheduling: "WHEN_IDLE",
    };
  }
  const refusal = await smsRecipientRefusal(memory, phone);
  if (refusal) return { response: { ok: false, error: refusal }, scheduling: "WHEN_IDLE" };
  // Один номер дважды («сто двенадцать, и ещё сто двенадцатую») — одна ссылка.
  const asked = [
    ...new Set(
      typeof args.numbers === "string"
        ? args.numbers.split(/[^\d]+/).filter(Boolean).map(Number)
        : typeof args.numbers === "number"
          ? [args.numbers]
          : []
    ),
  ];
  // Только то, что в этом звонке уже обсуждали: модель не должна слать по СМС
  // объект, о котором человеку не рассказывала (или выдуманный номер).
  const wanted = (asked.length ? asked.filter((n) => memory.discussedShortIds.includes(n)) : memory.discussedShortIds).slice(
    0,
    SMS_MAX_PROPERTIES
  );
  const props = wanted.length
    ? await prisma.property.findMany({
        // Что можно предлагать — одно правило с подбором и рассказом (lib/propertyMatch.ts).
        where: { shortId: { in: wanted }, status: "AVAILABLE", AND: [botOfferableWhere()] },
        select: {
          id: true,
          shortId: true,
          siteListingId: true,
          publishedOnSite: true,
          instagramUrl: true,
          rooms: true,
          type: true,
          areaSqm: true,
          price: true,
          currency: true,
          district: { select: { name: true } },
        },
      })
    : [];
  if (props.length === 0) {
    return {
      response: { ok: false, error: "нечего отправить: сначала расскажи про варианты (search_properties или get_property)" },
      scheduling: "WHEN_IDLE",
    };
  }
  // Без ссылки (ни страницы на сайте, ни поста Instagram) объект в СМС не кладём:
  // ссылку не придумываем, а СМС без неё — просто повтор сказанного голосом.
  const ordered = wanted
    .map((n) => props.find((p) => p.shortId === n))
    .filter((p): p is (typeof props)[number] => !!p && botOfferLink(p) !== null);
  if (ordered.length === 0) {
    return {
      response: { ok: false, error: `ссылки на этот объект у нас нет — подробности и фото пришлёт агент; ${AGENT_CALLBACK_ONCE}` },
      scheduling: "WHEN_IDLE",
    };
  }
  // Подсчёт и отправка — подряд под замком номера: две линии, на которых
  // одновременно диктуют один номер, иначе обе увидели бы «ещё можно».
  const sent = await oneSendAtATime(smsPhone, async () => {
    // Два вызова с разными id прошли проверку в начале до await: под замком
    // перепроверяем, иначе второй отправил бы СМС следом за первым (LIVE01).
    if (memory.smsSent) return "already" as const;
    if ((await robotSmsSentToday(smsPhone)) >= SMS_PER_RECIPIENT_PER_DAY) return null;
    const result = await sendSms({
      phone,
      text: propertiesSmsText(ordered),
      purpose: "CALL_PROPERTIES",
      clientId: memory.clientId,
      propertyId: ordered.length === 1 ? ordered[0].id : null,
    });
    // Флаг ставим здесь же, под замком: следующий в очереди увидит его.
    if (result.ok) memory.smsSent = true;
    return result;
  });
  if (sent === "already") {
    return { response: { ok: false, error: "СМС в этом звонке уже отправлено — второй раз не шлём" }, scheduling: "WHEN_IDLE" };
  }
  if (!sent) return { response: { ok: false, error: SMS_LIMIT_REFUSAL }, scheduling: "WHEN_IDLE" };
  if (!sent.ok) {
    return { response: { ok: false, error: `СМС не ушло — ссылки пришлёт агент; ${AGENT_CALLBACK_ONCE}` }, scheduling: "WHEN_IDLE" };
  }
  return { response: { ok: true, sent: ordered.length }, scheduling: "WHEN_IDLE" };
}

const SMS_LIMIT_REFUSAL =
  `на этот номер ссылки сегодня уже отправляли — второй раз не шлём; подробности пришлёт агент; ${AGENT_CALLBACK_ONCE}`;
const SMS_FOREIGN_NUMBER_REFUSAL =
  `этот номер в CRM записан за другим человеком — на него не шлём; подробности пришлёт агент; ${AGENT_CALLBACK_ONCE}`;

/** Сколько СМС со ссылками робот уже отправил на номер с начала суток по Душанбе.
 *  Неудачная отправка (FAILED) не в счёт: до человека она не дошла. */
async function robotSmsSentToday(smsPhone: string): Promise<number> {
  return prisma.smsMessage.count({
    where: { phone: smsPhone, purpose: "CALL_PROPERTIES", status: { not: "FAILED" }, createdAt: { gte: dushanbeStartOfToday() } },
  });
}

/**
 * ЧУЖОЙ НОМЕР — НЕ ШЛЁМ (02.10.2026). Номер, с которого звонят, — свой: на него
 * можно всегда (в пределах суточного предела). Номер, который человек
 * ПРОДИКТОВАЛ, проверяется: если в CRM он записан за другой карточкой клиента или
 * за сотрудником, это не «мой второй номер», а чужой человек, и СМС от имени
 * агентства ему слать не за что. Своя карточка звонящего (memory.clientId) не в
 * счёт: её запасной номер — его же. null — можно слать.
 */
async function smsRecipientRefusal(memory: PropertyCallMemory, phone: string): Promise<string | null> {
  const dictated = memory.otherPhone !== null && toSmsPhone(memory.otherPhone) !== toSmsPhone(memory.callerPhone);
  if (dictated) {
    // Номер — в полной форме 992…: сверка с сотрудниками сравнивает две полные
    // записи целиком, и «0 93…» против «+992 93…» иначе разошлась бы.
    if (await findStaffPhone([toSmsPhone(phone)])) return SMS_FOREIGN_NUMBER_REFUSAL;
    const owners = await findPhoneOwners([phone], { exceptClientId: memory.clientId ?? undefined, limit: 1 });
    if (owners.length > 0) return SMS_FOREIGN_NUMBER_REFUSAL;
  }
  return null;
}

/** Очередь отправок на один номер внутри процесса: подсчёт «сколько уже ушло» и
 *  сама отправка идут без чужой вставки посередине. */
const smsQueues = new Map<string, Promise<unknown>>();
async function oneSendAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
  const prev = smsQueues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(run);
  smsQueues.set(key, next);
  try {
    return await next;
  } finally {
    if (smsQueues.get(key) === next) smsQueues.delete(key);
  }
}

/** Короткий текст намеренно: кириллица — 70 знаков на платную часть. Ссылка — общим
 *  botOfferLink (lib/propertyMatch.ts): страница на сайте (там фото, видео и карта), а
 *  у объекта не с сайта — его публикация в Instagram. Без ссылки строки нет. */
export function propertiesSmsText(
  props: {
    id: string;
    siteListingId?: number | null;
    publishedOnSite: boolean;
    instagramUrl?: string | null;
    rooms: number | null;
    areaSqm: unknown;
    price: unknown;
    currency: string;
    district: { name: string } | null;
  }[]
): string {
  const lines = props.flatMap((p) => {
    const link = botOfferLink(p);
    if (!link) return [];
    const price =
      p.currency === "USD"
        ? `$${Math.round(Number(p.price)).toLocaleString("ru-RU").replace(/ /g, " ")}`
        : `${Math.round(Number(p.price)).toLocaleString("ru-RU").replace(/ /g, " ")} с.`;
    const facts = [p.rooms ? `${p.rooms}-комн.` : null, p.district?.name, `${Math.round(Number(p.areaSqm))} м²`, price]
      .filter(Boolean)
      .join(", ");
    return [`${facts}: ${link}`];
  });
  return `Royal Home, по вашему звонку:\n${lines.join("\n")}`;
}

/**
 * Какие объекты обсуждали — словами для агента, а не номерами (Dan 24.09: «агент
 * номер не помнит, а прямо приметы: какой дом, сколько метров, адрес, ориентир»).
 * Номер остаётся в конце, в скобках: по нему объект ищется в CRM. Удалённый объект
 * — одним номером, чтобы строка не пропала.
 */
export async function describeDiscussedProperties(shortIds: number[]): Promise<string[]> {
  if (shortIds.length === 0) return [];
  const rows = await prisma.property.findMany({
    where: { shortId: { in: shortIds } },
    select: {
      shortId: true,
      type: true,
      rooms: true,
      areaSqm: true,
      floor: true,
      totalFloors: true,
      address: true,
      landmark: true,
      price: true,
      currency: true,
      district: { select: { name: true } },
    },
  });
  const byId = new Map(rows.map((p) => [p.shortId, visiblePropertyFacts(p)]));
  return shortIds.map((id) => {
    const p = byId.get(id);
    if (!p) return `№${id}`;
    const floor = floorText(p);
    const facts = [
      p.rooms ? `${p.rooms}-комн.` : null,
      Number(p.areaSqm) > 0 ? `${Number(p.areaSqm)} м²` : null,
      floor ? `этаж ${floor}` : null,
      p.district?.name,
      p.address?.trim() || null,
      p.landmark?.trim() ? `ориентир ${p.landmark.trim()}` : null,
      priceText(p.price, p.currency),
    ].filter(Boolean);
    return `${facts.join(", ")} (№${id})`;
  });
}
