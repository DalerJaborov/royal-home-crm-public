import { createHash } from "node:crypto";
import {
  CURRENCIES,
  EMPTY_SELLER_OBJECT_FACTS,
  MARKET_TYPES,
  PROPERTY_CONDITIONS,
  PROPERTY_TYPES,
  PROPERTY_TYPE_LABELS,
  type MarketType,
  type SellerObjectFacts,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { callAiText } from "./client.js";
import { asAddress, asPositiveNumber, asPropertyType } from "./cardFill.js";
import { asCurrency, asPositiveInt, asPropertyCondition, SELLER_OBJECT_RULES } from "./propertyDraft.js";
import { resolveGeoText } from "../lib/geoResolve.js";
import { isSellerClient, latestSellerProperty, parseSellerFacts } from "../lib/sellerFacts.js";

/**
 * ФОНОВЫЙ РАЗБОР ФАКТОВ ОБ ОБЪЕКТЕ ПРОДАВЦА (владелец 21.09.2026). Исполняется
 * заданием seller-facts (jobs/sellerFacts.ts), постановка — lib/sellerFacts.ts.
 *
 * ЭКОНОМИЯ ТОКЕНОВ — УСТРОЙСТВО, А НЕ ПОЖЕЛАНИЕ:
 *  1. Инкрементально: в модель идут ПРЕДЫДУЩИЕ факты (короткий JSON) и только
 *     реплики после factsSourceUpTo и ещё не учтённые расшифровки звонков. Вся
 *     переписка заново не читается никогда.
 *  2. Нечего нового — вызова нет. Тот же вход (sha256) второй раз — вызова нет.
 *  3. Только реплики продавца; плейсхолдеры вложений («[📷]») выкидываются.
 *     Вопрос бота перед репликой идёт коротким контекстом (≤120 символов): без
 *     него ответ «3» на «Сколько комнат?» — просто цифра ни о чём.
 *  4. Дешёвая модель (GEMINI_EXTRACT_MODEL, по умолчанию gemini-3.1-flash-lite —
 *     проверена живым структурным вызовом, см. GEMINI_KNOWN_MODELS) и короткий
 *     ответ: модель возвращает ТОЛЬКО узнанные/изменившиеся поля.
 *  5. Отказ модели (402 — кончился баланс, 429, сеть) — факты не трогаем и
 *     границу не двигаем: следующая пачка сообщений разберёт и эти реплики.
 *     Журнал отказа пишет сам callAiText (logSystemError("ai", ...)), стоимость
 *     каждого вызова — его же logAiCall.
 *
 * НЕСКОЛЬКО ОБЪЕКТОВ. Владелец не хочет вопросов: факты описывают ПОСЛЕДНИЙ
 * обсуждаемый объект. Модель сообщает newObject=true, когда продавец в новых
 * репликах заговорил о другом объекте, — тогда набор начинается с чистого листа,
 * а не смешивается со старым (та самая смесь двух квартир 19.09.2026, см. шапку
 * ai/propertyDraft.ts). Объекты, уже заведённые в CRM, отсекаются границей: реплики
 * до заведения последнего объекта в разбор не идут, а факты, собранные до него,
 * считаются израсходованными.
 */

const EXTRACT_MODEL = process.env.GEMINI_EXTRACT_MODEL || "gemini-3.1-flash-lite";

/** Потолки входа одного разбора — чтобы первый разбор давнего продавца не стал
 *  дорогим: последние реплики важнее старых. */
const MAX_CHAT_LINES = 60;
const MAX_CHAT_CHARS = 6000;
const MAX_CALLS = 3;
const MAX_TRANSCRIPT_CHARS = 4000;
const MAX_CONTEXT_QUESTION_CHARS = 120;
/** Сколько id учтённых звонков помнить — больше у одного продавца не бывает. */
const MAX_REMEMBERED_CALLS = 50;
/** Сколько диалогов одного канала читать — у продавца их единицы. */
const MAX_CONVERSATIONS_PER_CHANNEL = 5;

/** Версия промта входит в хэш: поменяли правила — тот же вход честно разберётся заново. */
const PROMPT_VERSION = "seller-facts-v1";

export type SellerFactsRefreshResult =
  | "not-seller"
  | "nothing-new"
  | "same-input"
  | "ai-unavailable"
  | "updated";

interface ChatLine {
  at: number;
  text: string;
}

/** Ответ модели — внешние данные: каждое поле проверяется ниже. */
interface FactsExtract {
  newObject?: unknown;
  type?: unknown;
  rooms?: unknown;
  areaSqm?: unknown;
  landAreaSotka?: unknown;
  floor?: unknown;
  totalFloors?: unknown;
  windowCount?: unknown;
  price?: unknown;
  currency?: unknown;
  condition?: unknown;
  marketType?: unknown;
  documents?: unknown;
  districtName?: unknown;
  address?: unknown;
  description?: unknown;
}

function extractSchema(districtNames: string[]) {
  const num = (description: string) => ({ type: "number", description });
  return {
    type: "object",
    properties: {
      newObject: {
        type: "boolean",
        description: "true — в НОВЫХ репликах продавец говорит о другом объекте, не о том, что в текущих фактах.",
      },
      type: { type: "string", enum: [...PROPERTY_TYPES] },
      rooms: num("Комнат."),
      areaSqm: num("Площадь, м²."),
      landAreaSotka: num("Участок, соток (дом/земля)."),
      floor: num("Этаж квартиры."),
      totalFloors: num("Этажей в доме."),
      windowCount: num("Сколько окон."),
      price: num("Цена продавца полным числом."),
      currency: { type: "string", enum: [...CURRENCIES] },
      condition: { type: "string", enum: [...PROPERTY_CONDITIONS] },
      marketType: { type: "string", enum: [...MARKET_TYPES], description: "NEW_BUILD новостройка, SECONDARY вторичка." },
      documents: { type: "string", description: "Документы: техпаспорт, договор, дарственная…" },
      ...(districtNames.length > 0 ? { districtName: { type: "string", enum: districtNames } } : {}),
      address: { type: "string", description: "Адрес или ориентир словами продавца." },
      description: { type: "string", description: "Что продавец рассказал об объекте, 1-2 предложения." },
    },
  };
}

function buildSystemPrompt(districtNames: string[]): string {
  return (
    "Ты ведёшь карточку ОБЪЕКТА, который ПРОДАВЕЦ предлагает агентству Royal Home (Душанбе). " +
    "Тебе дают ТЕКУЩИЕ ФАКТЫ и НОВЫЕ реплики продавца / расшифровки звонков. Верни ТОЛЬКО поля, которые " +
    "новое добавило или изменило; остальные не пиши. " +
    SELLER_OBJECT_RULES +
    "ЧИСЛА — полным числом: «85 тыс $» → price 85000, currency USD; «1,2 млн сомони» → 1200000 TJS; «трёшка», " +
    "«3 хона» → rooms 3; «6 сотых», «6 сотка» → landAreaSotka 6. " +
    "Если в новых репликах продавец перешёл к ДРУГОМУ своему объекту — newObject=true и поля только этого " +
    "последнего объекта. Несколько объектов сразу — бери последний обсуждаемый. " +
    (districtNames.length > 0 ? `Районы: ${districtNames.join(", ")}. ` : "") +
    `Типы: ${PROPERTY_TYPES.map((t) => `${t}=${PROPERTY_TYPE_LABELS[t]}`).join(", ")}. ` +
    "Ответ — через инструмент submit_reply."
  );
}

function asMarketType(value: unknown): MarketType | null {
  return typeof value === "string" && (MARKET_TYPES as readonly string[]).includes(value) ? (value as MarketType) : null;
}

function asShortText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length > 0 ? t.slice(0, max) : null;
}

/** Реплика-заглушка вложения («[📷]», «[🎤]», «[📎]») — модели в ней читать нечего. */
function isPlaceholderOnly(text: string): boolean {
  return /^(\[[^\]]{1,40}\]\s*)+$/.test(text.trim());
}

/**
 * Новые реплики продавца из всех каналов. `since` — граница: берём строго позже.
 * Реплики без отметки времени (записаны до 01.08.2026) идут только в самый первый
 * разбор, когда границы ещё нет.
 */
function collectChatLines(conversations: { messages: unknown }[], since: number | null): { lines: ChatLine[]; maxAt: number | null } {
  const lines: ChatLine[] = [];
  let maxAt: number | null = null;
  for (const conv of conversations) {
    if (!Array.isArray(conv.messages)) continue;
    let lastQuestion: string | null = null;
    for (const item of conv.messages as unknown[]) {
      if (!item || typeof item !== "object") continue;
      const { role, content, at } = item as { role?: unknown; content?: unknown; at?: unknown };
      if (typeof content !== "string") continue;
      if (role !== "user") {
        // Вопрос бота/агента — только как короткий контекст к следующей реплике.
        lastQuestion = content.includes("?") ? content.trim().slice(-MAX_CONTEXT_QUESTION_CHARS) : null;
        continue;
      }
      const atMs = typeof at === "string" ? Date.parse(at) : NaN;
      const stamped = Number.isFinite(atMs);
      if (stamped) maxAt = Math.max(maxAt ?? 0, atMs);
      const fresh = since === null || (stamped && atMs > since);
      const text = content.trim();
      if (fresh && text && !isPlaceholderOnly(text)) {
        const context = lastQuestion ? `(вопрос: ${lastQuestion}) ` : "";
        lines.push({ at: stamped ? atMs : 0, text: `${context}ПРОДАВЕЦ: ${text}` });
      }
      lastQuestion = null;
    }
  }
  lines.sort((a, b) => a.at - b.at);
  // Потолок — с конца: свежие реплики ценнее старых.
  let tail = lines.slice(-MAX_CHAT_LINES);
  let total = tail.reduce((n, l) => n + l.text.length + 1, 0);
  while (tail.length > 1 && total > MAX_CHAT_CHARS) {
    total -= tail[0].text.length + 1;
    tail = tail.slice(1);
  }
  return { lines: tail, maxAt };
}

/** Текущие факты для модели — только заполненные поля, район именем: короче и понятнее. */
function factsForPrompt(facts: SellerObjectFacts, districtNameById: Map<string, string>): string {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(facts)) {
    if (value === null || key === "lat" || key === "lng" || key === "districtId") continue;
    out[key] = value;
  }
  if (facts.districtId) {
    const name = districtNameById.get(facts.districtId);
    if (name) out.districtName = name;
  }
  return JSON.stringify(out);
}

/**
 * Один разбор: собрать новое, спросить модель, слить с прошлым, записать.
 * Идемпотентен: повтор после падения между вызовом и записью разберёт тот же вход
 * ещё раз (граница не сдвинута), а после записи — не найдёт нового.
 */
export async function refreshSellerFacts(clientId: string): Promise<SellerFactsRefreshResult> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { kind: true, dualIntent: true, deletedAt: true },
  });
  if (!client || client.deletedAt || !isSellerClient(client)) return "not-seller";

  const [row, lastProperty, existingTitles] = await Promise.all([
    prisma.sellerObjectFacts.findUnique({ where: { clientId } }),
    latestSellerProperty(clientId),
    prisma.property.findMany({
      where: { sellerClientId: clientId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 3,
      select: { title: true },
    }),
  ]);

  // Факты, собранные до заведения последнего объекта, в него и ушли — следующий
  // объект начинается с чистого листа, и реплики до заведения в разбор не идут.
  const consumed = !!lastProperty && (!row?.factsUpdatedAt || lastProperty.createdAt >= row.factsUpdatedAt);
  const previous = (!consumed && row?.facts ? parseSellerFacts(row.facts) : null) ?? EMPTY_SELLER_OBJECT_FACTS;
  const boundaries = [row?.factsSourceUpTo?.getTime() ?? null, lastProperty?.createdAt.getTime() ?? null].filter(
    (v): v is number => v !== null
  );
  const since = boundaries.length > 0 ? Math.max(...boundaries) : null;
  const knownCallIds = row?.factsCallIds ?? [];

  const [botConversations, telegramConversation, directConversations, calls] = await Promise.all([
    prisma.botConversation.findMany({
      where: { clientId },
      orderBy: { lastMessageAt: "desc" },
      take: MAX_CONVERSATIONS_PER_CHANNEL,
      select: { messages: true },
    }),
    prisma.telegramConversation.findUnique({ where: { clientId }, select: { messages: true } }),
    prisma.telegramDirectConversation.findMany({
      where: { clientId },
      orderBy: { lastMessageAt: "desc" },
      take: MAX_CONVERSATIONS_PER_CHANNEL,
      select: { messages: true },
    }),
    prisma.interaction.findMany({
      where: {
        clientId,
        type: "CALL",
        transcript: { not: null },
        ...(knownCallIds.length > 0 ? { id: { notIn: knownCallIds } } : {}),
        ...(lastProperty ? { createdAt: { gt: lastProperty.createdAt } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: MAX_CALLS,
      select: { id: true, transcript: true },
    }),
  ]);

  const { lines, maxAt } = collectChatLines(
    [...botConversations, ...(telegramConversation ? [telegramConversation] : []), ...directConversations],
    since
  );
  if (lines.length === 0 && calls.length === 0) return "nothing-new";

  const districts = await prisma.district.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
  const districtNames = districts.map((d) => d.name);
  const districtNameById = new Map(districts.map((d) => [d.id, d.name]));
  const districtByName = new Map(districts.map((d) => [d.name.trim().toLowerCase(), d.id]));

  const callsPart = [...calls]
    .reverse()
    .map((c) => `[Звонок]\n${(c.transcript ?? "").slice(0, MAX_TRANSCRIPT_CHARS)}`)
    .join("\n\n");
  const user = [
    `ТЕКУЩИЕ ФАКТЫ: ${factsForPrompt(previous, districtNameById)}`,
    existingTitles.length > 0
      ? `Уже заведены в CRM (их факты не бери): ${existingTitles.map((p) => p.title).join("; ")}`
      : "",
    `НОВОЕ:\n${[lines.map((l) => l.text).join("\n"), callsPart].filter(Boolean).join("\n\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const system = buildSystemPrompt(districtNames);

  const inputHash = createHash("sha256").update(`${PROMPT_VERSION}\n${system}\n${user}`).digest("hex");
  if (row?.factsInputHash === inputHash) return "same-input";

  const extract = await callAiText<FactsExtract>({
    endpoint: "seller-facts",
    simple: true,
    preferModel: EXTRACT_MODEL,
    system,
    user,
    // Ответ — только изменившиеся поля, обычно десяток коротких значений.
    maxTokens: 400,
    schema: extractSchema(districtNames),
  });
  // Модель не ответила (402/429/сеть) — ни факты, ни границу не трогаем.
  if (!extract) return "ai-unavailable";

  const base = extract.newObject === true ? EMPTY_SELLER_OBJECT_FACTS : previous;
  const pick = <T>(value: T | null, fallback: T | null): T | null => (value === null ? fallback : value);
  const districtName = typeof extract.districtName === "string" ? extract.districtName.trim().toLowerCase() : "";
  const next: SellerObjectFacts = {
    type: pick(asPropertyType(extract.type), base.type),
    rooms: pick(asPositiveInt(extract.rooms), base.rooms),
    areaSqm: pick(asPositiveNumber(extract.areaSqm), base.areaSqm),
    landAreaSotka: pick(asPositiveNumber(extract.landAreaSotka), base.landAreaSotka),
    floor: pick(asPositiveInt(extract.floor), base.floor),
    totalFloors: pick(asPositiveInt(extract.totalFloors), base.totalFloors),
    windowCount: pick(asPositiveInt(extract.windowCount), base.windowCount),
    price: pick(asPositiveNumber(extract.price), base.price),
    currency: pick(asCurrency(extract.currency), base.currency),
    condition: pick(asPropertyCondition(extract.condition), base.condition),
    marketType: pick(asMarketType(extract.marketType), base.marketType),
    documents: pick(asShortText(extract.documents, 200), base.documents),
    districtId: pick(districtByName.get(districtName) ?? null, base.districtId),
    address: pick(asAddress(extract.address), base.address),
    lat: base.lat,
    lng: base.lng,
    description: pick(asShortText(extract.description, 600), base.description),
  };

  // Ориентир → точка на карте словарём мест, без ИИ. Только когда адрес новый:
  // старый уже разобран. Нечёткое совпадение не ставим — неверная точка хуже пустой.
  if (next.address && next.address !== base.address) {
    next.lat = null;
    next.lng = null;
    try {
      const place = await resolveGeoText(next.address);
      if (place && place.confidence !== "fuzzy") {
        next.lat = place.lat;
        next.lng = place.lng;
      }
    } catch (err) {
      console.error("[seller-facts] ориентир не разобран:", err instanceof Error ? err.message : err);
    }
  }

  const sourceUpTo = maxAt !== null ? new Date(maxAt) : (row?.factsSourceUpTo ?? null);
  const callIds = [...knownCallIds, ...calls.map((c) => c.id)].slice(-MAX_REMEMBERED_CALLS);
  const data = {
    facts: next,
    factsInputHash: inputHash,
    factsSourceUpTo: sourceUpTo,
    factsCallIds: callIds,
    factsUpdatedAt: new Date(),
  };
  await prisma.sellerObjectFacts.upsert({
    where: { clientId },
    create: { clientId, ...data },
    update: data,
  });
  return "updated";
}
