import {
  PROPERTY_CONDITIONS,
  PROPERTY_TYPES,
  CURRENCIES,
  PROPERTY_TYPE_LABELS,
  type PropertyCondition,
  type Currency,
  type PropertyDraftSuggestion,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { callAiText } from "./client.js";
import { asAddress, asPositiveNumber, asPropertyType, readMessages } from "./cardFill.js";

/**
 * Задача K (план docs/audit-02-09-2026/19-plan-03-09-evening.md): «ИИ копит
 * информацию по ВСЕМ каналам касания с продавцом (звонки, переписка), не только
 * из одного разговора. К моменту открытия формы создания объекта — черновик уже
 * заполнен».
 *
 * Тот же принцип, что и ai/cardFill.ts (заполнение карточки КЛИЕНТА со слов
 * покупателя), только источник — продавец, а извлекаем не его требования, а
 * параметры ЕГО СОБСТВЕННОГО ОБЪЕКТА. В отличие от cardFill.ts здесь НЕТ готового
 * накопленного черновика вроде BotConversation.leadDraft (leadQualifier.ts копит
 * бюджет/район/комнаты ПОКУПАТЕЛЯ, не параметры объекта продавца) — весь разбор
 * идёт ИИ по сырой переписке и звонкам заново при каждом открытии формы.
 *
 * СКОУП ПОЛЕЙ — НАМЕРЕННО УЖЕ, ЧЕМ ВСЯ ФОРМА ОБЪЕКТА. Задача называет площадь,
 * комнаты, этаж, состояние, цену — сюда же добавлены тип и район/адрес (тоже
 * достаточно однозначные и уже есть готовыми полями формы). Этажность и
 * количество окон НЕ извлекаются: собственный приём бота у продавца
 * (ai/sellerIntake.ts, SELLER_FACT_ORDER) их тоже не спрашивает и не отслеживает
 * — сигнал, что в живой переписке эти цифры продавец называет редко и ненадёжно,
 * а на форме они не блокируют сохранение сильнее прочих. Характеристики (баланс,
 * отопление и т.п., 13 select-полей) и amenities — тоже вне скоупа: форма
 * создания объекта их либо не показывает вовсе на этом шаге (amenities всегда
 * уходит пустым массивом при создании, см. PropertyFormModal.tsx), либо это
 * слишком мелкая, редко проговариваемая детализация для черновика по переписке.
 * Ничего не сохраняет — только предложение полей, агент правит и сохраняет
 * обычным POST /properties.
 *
 * ОДИН ПРОДАВЕЦ — НЕСКОЛЬКО КВАРТИР: ПОДСКАЗКА НЕ ВЫДАЁТСЯ ВОВСЕ (19.09.2026).
 * Разбор идёт по КЛИЕНТУ, а не по объекту: на входе clientId, и вся переписка с
 * продавцом уходит в одну просьбу «заполни черновик карточки ЕГО ОБЪЕКТА» —
 * единственного числа. Пока квартира одна, это работает. Как только продавец в
 * той же переписке рассказал о двух («одну на Сино, вторую на Фирдавси»), модель
 * обязана вернуть ОДИН набор полей по двум объектам — и возвращает смесь: комнаты
 * от первой, этаж от второй, цену от третьей фразы. Смесь молча уезжает дальше
 * точь-в-точь: карточка → подпись монтажёру в Telegram (lib/videoHandoff.ts) →
 * текст внутри смонтированного ролика → публикация. Поймано 19.09.2026 на двух
 * объектах одного продавца, заведённых подряд; после удаления и повторного
 * заведения смесь получилась другая — подпись модели ошибкой не повторяется.
 *
 * Поэтому здесь ДВА ЗАПРЕТА, и оба — код, а не просьба в промте (в этом проекте
 * промт гарантией не считается, см. шапку ai/topicLock.ts):
 *   1. У продавца уже есть хоть один объект в CRM → не разбираем вовсе, даже
 *      платный вызов не делаем: разделить в переписке «новую» квартиру и уже
 *      заведённую нечем, а подставить в новый объект факты старого — это ровно
 *      та поломка, из-за которой правило написано.
 *   2. Модель сама сообщает, о скольких РАЗНЫХ объектах шла речь (objectsCount),
 *      и при двух и больше поля обнуляются здесь, в коде, а не «модель обещала
 *      не путать».
 * В обоих случаях форма открывается ПУСТОЙ, с пометкой почему (ambiguityReason)
 * — агент заполняет руками. Пустая форма честнее смеси двух квартир.
 */

/** Сколько последних звонков берём в разбор и потолок одной расшифровки — те же
 *  цифры и то же обоснование, что в ai/cardFill.ts. Лимит на число/длину сообщений
 *  переписки здесь не дублируется: readMessages (переиспользована из cardFill.ts)
 *  уже обрезает и то, и другое сама. */
const MAX_CALLS = 3;
const MAX_TRANSCRIPT_CHARS = 4000;

export function asPropertyCondition(value: unknown): PropertyCondition | null {
  return typeof value === "string" && (PROPERTY_CONDITIONS as readonly string[]).includes(value)
    ? (value as PropertyCondition)
    : null;
}

export function asCurrency(value: unknown): Currency | null {
  return typeof value === "string" && (CURRENCIES as readonly string[]).includes(value) ? (value as Currency) : null;
}

/** Комнаты/этаж — целые числа, в отличие от площади/цены (asPositiveNumber). */
export function asPositiveInt(value: unknown): number | null {
  const n = asPositiveNumber(value);
  return n === null ? null : Math.round(n);
}

/** Ответ модели — внешние данные: ни одно поле не берём на веру, всё через проверки выше. */
interface PropertyExtract {
  propertyType?: unknown;
  rooms?: unknown;
  areaSqm?: unknown;
  floor?: unknown;
  condition?: unknown;
  price?: unknown;
  currency?: unknown;
  districtName?: unknown;
  address?: unknown;
  evidence?: unknown;
  objectsCount?: unknown;
}

function extractSchema(districtNames: string[]) {
  return {
    type: "object",
    properties: {
      propertyType: {
        type: "string",
        enum: [...PROPERTY_TYPES],
        description: "Тип недвижимости, если продавец назвал прямо (квартира/дом/участок/коммерческая).",
      },
      rooms: { type: "number", description: "Сколько комнат в объекте продавца." },
      areaSqm: { type: "number", description: "Площадь объекта в квадратных метрах." },
      floor: {
        type: "number",
        description: "Этаж объекта (не этажность дома — только сам этаж, на котором квартира).",
      },
      condition: {
        type: "string",
        enum: [...PROPERTY_CONDITIONS],
        description:
          "Состояние объекта: NEEDS_REPAIR — «каробка», без ремонта, требует ремонта; GOOD — обычный жилой " +
          "ремонт, «косметика», «жилое состояние»; EXCELLENT — «евроремонт», дизайнерский ремонт, " +
          "«всё новое»; NEW_BUILDING — новостройка, в которой никто никогда не жил. Не сказал ничего " +
          "по теме ремонта — оставь пустым, не угадывай по возрасту дома.",
      },
      price: {
        type: "number",
        description:
          "Сумма, которую продавец хочет получить за объект, — ровно то число, что он назвал (не пересчитывай " +
          "валюту, не округляй). Если называл вилку («от 500 до 550 тысяч») — бери верхнюю границу, это его цена.",
      },
      currency: {
        type: "string",
        enum: [...CURRENCIES],
        description: "Валюта, в которой продавец назвал цену — сомони (TJS) или доллары (USD).",
      },
      ...(districtNames.length > 0
        ? { districtName: { type: "string", enum: districtNames, description: "Район объекта из списка" } }
        : {}),
      address: {
        type: "string",
        description:
          "Адрес или ориентир объекта со слов продавца: улица и дом, ЖК, рынок, кинотеатр, школа " +
          "(«напротив кинотеатра Зебунисо», «ДОК»). Район сюда не дублируй — он идёт в districtName.",
      },
      evidence: {
        type: "array",
        items: { type: "string" },
        maxItems: 3,
        description: "До 3 коротких цитат продавца, подтверждающих заполненные поля.",
      },
      objectsCount: {
        type: "number",
        description:
          "О скольких РАЗНЫХ объектах недвижимости продавец говорил во всём этом общении. Одна квартира, " +
          "описанная в нескольких сообщениях, — это 1. Две квартиры в разных местах, дом и участок, " +
          "«ещё есть вторая» — 2 и больше. Поле обязательное.",
      },
    },
  };
}

/**
 * Правила чтения слов продавца — общие для разовой подсказки ниже и для фонового
 * накопления фактов (ai/sellerFactsExtract.ts). Одним текстом, чтобы словарь
 * «каробка → NEEDS_REPAIR» и правило «цену не конвертировать» не разошлись между
 * двумя промтами. Экспорт — ради второго потребителя.
 */
export const SELLER_OBJECT_RULES =
  "КРИТИЧЕСКИ ВАЖНО: бери ТОЛЬКО то, что продавец сказал сам об СВОЁМ ОБЪЕКТЕ. Ничего не додумывай и не выводи " +
  "по косвенным признакам: не назвал площадь, этаж, состояние, цену, комнаты, тип или район — оставляй поле " +
  "пустым, не угадывай по обрывочным намёкам. " +
  "Слова бота (assistant) и агента источником не считаются, только слова самого продавца — не путай с тем, " +
  "что предположил или переспросил бот. " +
  "Продавец может писать и говорить на таджикском (кириллицей или латиницей), русском или смеси — это нормально. " +
  "ЯЗЫК ОТВЕТА: всегда русский, независимо от языка продавца. Названия районов приводи к тому виду, в котором " +
  "они перечислены ниже, даже если продавец назвал район по-таджикски или разговорным именем. " +
  "В расшифровках телефонных разговоров встречаются оговорки, повторы, обрывки фраз и ошибки распознавания — " +
  "понимай смысл сказанного, а не буквальные слова. " +
  // Тот же приём, что в ai/sellerIntake.ts (условная разговорная лексика Душанбе) —
  // словарь для «состояния» дублирован в описании поля схемы, здесь коротко ещё раз,
  // так короткие модели (Haiku/Flash) чаще ловят ближнее напоминание.
  "СОСТОЯНИЕ. «Каробка», «без ремонта», «черновая» — это NEEDS_REPAIR. Обычный жилой ремонт без уточнений — " +
  "GOOD. «Евроремонт», «дизайнерский ремонт», «всё новое» — EXCELLENT. Явная новостройка, где никто не жил, — " +
  "NEW_BUILDING. Ремонт вообще не обсуждали — оставь пустым. " +
  "ЦЕНА И ВАЛЮТА. Продавец обычно называет ОДНУ сумму — это его цена, пиши как есть, в той валюте, в которой " +
  "он её назвал (сомони или доллары), ничего не конвертируй. Есть небольшой торг («может, чуть уступлю») — " +
  "всё равно бери названную им цену, а не предположение о скидке. " +
  "АДРЕС И ОРИЕНТИР. В Душанбе место называют ориентиром: «ДОК», «напротив кинотеатра Зебунисо», " +
  "«за рынком Саховат», «ЖК Пойтахт». Это и есть address — записывай его отдельным полем словами продавца. " +
  "Район при этом всё равно указывай в districtName, если он звучал или узнаётся по ориентиру. ";

function buildSystemPrompt(districtNames: string[]): string {
  return (
    "Ты разбираешь общение с ПРОДАВЦОМ недвижимости агентства Royal Home (Душанбе), чтобы заполнить черновик " +
    "карточки ЕГО ОБЪЕКТА — квартиры, дома или участка, который он предлагает нам на продажу. " +
    "Источники двух видов: переписка в мессенджере и расшифровки телефонных разговоров. " +
    SELLER_OBJECT_RULES +
    (districtNames.length > 0 ? `Районы агентства: ${districtNames.join(", ")}. Другие названия в districtName не пиши. ` : "") +
    `Типы недвижимости: ${PROPERTY_TYPES.map((t) => `${t} = ${PROPERTY_TYPE_LABELS[t]}`).join("; ")}. ` +
    "НЕСКОЛЬКО ОБЪЕКТОВ. Продавец мог рассказать сразу о двух и более своих объектах (разные квартиры, " +
    "квартира и участок). Тогда в objectsCount поставь их число и НЕ СМЕШИВАЙ их параметры в один набор полей: " +
    "поля оставь пустыми, какой именно объект сейчас заводит агент, ты знать не можешь. Объект один — objectsCount = 1. " +
    "Ответ передавай через инструмент submit_reply."
  );
}

/**
 * Собирает черновик карточки объекта по переписке и звонкам с продавцом.
 * Клиент должен существовать и быть продавцом (kind=SELLER) — проверка доступа,
 * наличия и роли остаётся на маршруте (routes/ai.ts), как и у buildCardFillSuggestion.
 */
export async function buildPropertyDraftSuggestion(clientId: string): Promise<PropertyDraftSuggestion> {
  const [botConversation, telegramConversation, districts, existingObjectsCount] = await Promise.all([
    // findFirst, не findUnique — та же причина, что в cardFill.ts: у продавца тоже
    // может быть несколько диалогов бот-платформы, берём самый свежий.
    prisma.botConversation.findFirst({
      where: { clientId },
      orderBy: { lastMessageAt: "desc" },
      select: { messages: true },
    }),
    prisma.telegramConversation.findUnique({
      where: { clientId },
      select: { messages: true },
    }),
    prisma.district.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    // Запрет №1 из шапки файла: объекты этого продавца, уже заведённые в CRM.
    // Удалённые не считаем — их факты никуда не уехали, разбирать переписку заново
    // после удаления объекта законно (именно так объект и заводят повторно).
    prisma.property.count({ where: { sellerClientId: clientId, deletedAt: null } }),
  ]);

  const conversation = botConversation ?? telegramConversation;
  const messages = readMessages(conversation?.messages);
  const clientLines = messages.filter((m) => m.role === "user");

  const districtByName = new Map(districts.map((d) => [d.name.trim().toLowerCase(), d]));
  const resolveDistrict = (name: unknown) =>
    typeof name === "string" ? districtByName.get(name.trim().toLowerCase()) ?? null : null;

  const suggestion: PropertyDraftSuggestion = {
    source: "none",
    type: null,
    rooms: null,
    areaSqm: null,
    floor: null,
    condition: null,
    price: null,
    currency: null,
    districtId: null,
    districtName: null,
    address: null,
    evidence: [],
    aiUnavailable: false,
    ambiguityReason: null,
    existingObjectsCount,
  };

  // Запрет №1 (шапка файла). Стоит ДО платного вызова модели: разбирать нечего —
  // какой бы набор полей ни вернулся, отличить в переписке новую квартиру от уже
  // заведённой нечем, и любой ответ будет фактами не того объекта.
  if (existingObjectsCount > 0) {
    suggestion.ambiguityReason = "ALREADY_HAS_OBJECTS";
    return suggestion;
  }

  // Разговоры по телефону — как в cardFill.ts, самый ценный источник: продавец по
  // телефону описывает объект подробнее, чем в переписке.
  const callTranscripts = await prisma.interaction.findMany({
    where: { clientId, type: "CALL", transcript: { not: null } },
    orderBy: { createdAt: "desc" },
    take: MAX_CALLS,
    select: { transcript: true, createdAt: true },
  });

  // Разбирать нечего: продавец не писал и не звонил (заявку завели руками) —
  // платный вызов пропускаем, форма просто открывается пустой.
  if (clientLines.length === 0 && callTranscripts.length === 0) return suggestion;

  const districtNames = districts.map((d) => d.name);
  const chatPart = messages.map((m) => `${m.role === "user" ? "ПРОДАВЕЦ" : "Бот"}: ${m.content}`).join("\n");
  const callsPart = [...callTranscripts]
    .reverse()
    .map((c) => {
      // Дата — по Душанбе, тот же приём и та же причина, что в cardFill.ts (аудит №4):
      // ночной звонок в UTC-контейнере не должен подписываться вчерашним днём.
      const day = c.createdAt.toLocaleDateString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        timeZone: "Asia/Dushanbe",
      });
      return `[Телефонный разговор ${day}]\n${(c.transcript ?? "").slice(0, MAX_TRANSCRIPT_CHARS)}`;
    })
    .join("\n\n");
  const transcript = [chatPart, callsPart].filter(Boolean).join("\n\n");

  const extract = await callAiText<PropertyExtract>({
    endpoint: "property-draft",
    // Разбор переписки в поля карточки — простая задача извлечения, не разговор:
    // тот же уровень, что и card-fill (там тоже simple: true).
    simple: true,
    system: buildSystemPrompt(districtNames),
    user: `Что продавец говорил и писал о своём объекте:\n${transcript}`,
    maxTokens: 500,
    schema: extractSchema(districtNames),
  });

  if (!extract) {
    // Модель молчит — форма всё равно открывается, просто без подсказок по переписке.
    suggestion.aiUnavailable = true;
    return suggestion;
  }

  suggestion.source = callTranscripts.length > 0 ? "call" : "chat";

  // Запрет №2 (шапка файла). Ответ модели — внешние данные: число объектов тоже
  // проверяем, а не берём на веру. Не назвала (старый ответ, отказ поля) — считаем
  // один объект: это сегодняшнее поведение, и ломать его молчанием модели незачем.
  const objectsCount = asPositiveInt(extract.objectsCount) ?? 1;
  if (objectsCount > 1) {
    // Цитаты оставляем: агент заполняет руками и по ним видит, что именно продавец
    // говорил про каждую квартиру. Поля — пустые, смесь двух объектов не подставляем.
    suggestion.ambiguityReason = "SEVERAL_IN_CHAT";
    suggestion.evidence = readEvidence(extract.evidence);
    return suggestion;
  }

  suggestion.type = asPropertyType(extract.propertyType);
  suggestion.rooms = asPositiveInt(extract.rooms);
  suggestion.areaSqm = asPositiveNumber(extract.areaSqm);
  suggestion.floor = asPositiveInt(extract.floor);
  suggestion.condition = asPropertyCondition(extract.condition);
  suggestion.price = asPositiveNumber(extract.price);
  suggestion.currency = asCurrency(extract.currency);
  suggestion.address = asAddress(extract.address);

  const district = resolveDistrict(extract.districtName);
  if (district) {
    suggestion.districtId = district.id;
    suggestion.districtName = district.name;
  }

  suggestion.evidence = readEvidence(extract.evidence);

  return suggestion;
}

/** Цитаты продавца из ответа модели — внешние данные, поэтому и тип, и длина, и
 *  количество проверяются здесь. Отдельной функцией: нужны в двух ветках —
 *  обычной и той, где поля не подставляются из-за нескольких объектов. */
function readEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
    .map((q) => q.trim().slice(0, 200))
    .slice(0, 3);
}
