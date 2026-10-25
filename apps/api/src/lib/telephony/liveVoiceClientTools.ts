import {
  categoryFromIntent,
  convertToTjs,
  isDayOff,
  normalizeDaysOff,
  numberToWords,
  spokenDistance,
  spokenWhen,
  type DaysOffCalendar,
} from "@royal-home/shared";
import { prisma } from "../../db.js";
import { loadDaysOffCalendar } from "../daysOffCalendar.js";
import type { LiveVoiceFunctionDeclaration, LiveVoiceToolCall } from "../../ai/liveVoiceClient.js";
import { loadBotCapabilities } from "../../messengers/botCapabilities.js";
import { recordContactFacts, setContactCategory } from "../contactProfiles.js";
import { deliverToConversation, findClientDeliveryTarget, lastClientMessageAt } from "../conversationDelivery.js";
import type { DeliveryTarget } from "../conversationState.js";
import { describeError } from "../describeError.js";
import { DUSHANBE_OFFSET_MS, dushanbeDateString, dushanbeWallClock } from "../dushanbeTime.js";
import { resolveGeoText } from "../geoResolve.js";
import { boundingBoxAround, haversineMeters } from "../geoDistance.js";
import { nearbyLandmarks, nearestPlaceArea } from "../landmarkPick.js";
import { isMessagingWindowOpen } from "../messagingWindow.js";
import { loadMoneyContext } from "../money.js";
import { propertyOwnerAgentId } from "../propertyOwner.js";
import { BOT_OFFER_SELECT, botMayOffer, botOfferableWhere, botOfferLink, type BotOfferFields } from "../propertyMatch.js";
import { bookShowing, resolveShowingSlot, SHOWING_CONFLICT_WINDOW_MS, type BookingProblem } from "../showingBooking.js";
import { sendSms, toSmsPhone } from "../sms/index.js";
import { logSystemError } from "../systemError.js";
import { isWithinConsultantHours } from "./consultantHours.js";
import type { LiveVoiceToolReply } from "./liveVoiceBridge.js";
import { attachTranscriptLine } from "./liveVoiceGuards.js";
import {
  AGENT_CALLBACK_ONCE,
  LIVE_VOICE_DISTRICTS,
  streetWithoutHouse,
  type ClientCallRequest,
  type PropertyCallMemory,
} from "./liveVoicePropertyTools.js";

/**
 * РОБОТ, КОТОРЫЙ РЕШАЕТ ВОПРОС, А НЕ ПРИНИМАЕТ СООБЩЕНИЕ (09.10.2026, задача владельца:
 * «самый умный, с полным доступом, понимает всё»).
 *
 * ГРАНИЦА ДОСТУПА (решение 09.10). Робот ЧИТАЕТ всё, что нужно для ответа, ПИШЕТ только
 * заявки, задачи, перезвоны и запись на показ — существующими механизмами CRM, а не
 * своими копиями. Звонящий — незнакомый человек по телефону, номер подделывается, поэтому
 * каждая функция отдаёт модели ТОЛЬКО поля из своего белого списка (ответ собирается
 * поле за полем, без разворота строки базы): никогда — телефоны, имена собственников и
 * других клиентов, суммы сделок и комиссии, номер дома и квартиры, свободный текст
 * агента. Свой клиент (номер найден в карточке) слышит только своё: своего агента,
 * свой ближайший показ, стадию своей сделки, состояние своего объекта.
 *
 * Функции:
 *  - my_status — статус своего клиента;
 *  - save_client_request — условия звонящего структурно: в общее досье (то же, что
 *    у чат-бота) и строкой для агента в запись звонка;
 *  - request_callback — перезвон на время, которое выбрал сам человек;
 *  - showing_slots / book_showing — свободное время агента по календарю показов CRM и
 *    запись на показ (bookShowing, тот же, что у чат-бота), подтверждение по СМС;
 *  - send_property_messenger — карточка объекта в уже открытую переписку WhatsApp или
 *    Telegram (deliverToConversation, тот же путь, что ответ из «Чатов»);
 *  - describe_area — что рядом с объектом или местом, по справочнику ориентиров.
 *
 * Всё, что функция СДЕЛАЛА, ложится строкой в расшифровку звонка (attachTranscriptLine):
 * по ней видно, что робот записал, на когда и куда отправил.
 */

const DEAL_STAGE_WORDS: Record<string, string> = {
  NEGOTIATION: "идут переговоры",
  AGREEMENT_PENDING: "готовится соглашение",
  CONTRACT_SIGNED: "договор подписан",
  PENDING_APPROVAL: "сделка оформляется",
  COMPLETED: "сделка завершена",
};

const OWN_PROPERTY_STATUS_WORDS: Record<string, string> = {
  PENDING_REVIEW: "карточку проверяют перед публикацией",
  AWAITING_PHOTOS: "ждёт фотосъёмку",
  AWAITING_VIDEO: "ждёт видеосъёмку",
  EDITING: "монтируется видео",
  AVAILABLE: "в продаже",
  RESERVED: "в брони",
  SOLD: "продан",
  WITHDRAWN: "снят с продажи",
};

const DAY_DESCRIPTION =
  "День: today, tomorrow, after_tomorrow или дата YYYY-MM-DD (по Душанбе). «В субботу» — переведи в дату по текущей дате из справочника.";
const TIME_DESCRIPTION = "Время HH:MM (24 часа) или часть суток: morning, afternoon, evening.";

export const CLIENT_TOOLS: LiveVoiceFunctionDeclaration[] = [
  {
    name: "my_status",
    description:
      "Только если звонящий — наш клиент и спрашивает про СВОЁ: свой показ, свою сделку, свой объект, кто его агент. " +
      "Отдаёт только его собственные данные. Незнакомцу функция откажет — тогда предложи, чтобы агент перезвонил.",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "save_client_request",
    description:
      "Записать, что человек ищет или продаёт, — молча, как только он это сказал, и снова, когда узнал новое (бюджет, срок). " +
      "Агенту потом не придётся переспрашивать. Передавай только то, что человек сказал сам.",
    parameters: {
      type: "OBJECT",
      properties: {
        intent: { type: "STRING", description: "buy — покупает, sell — продаёт свою.", enum: ["buy", "sell"] },
        district: { type: "STRING", description: "Официальный район Душанбе.", enum: [...LIVE_VOICE_DISTRICTS] },
        type: { type: "STRING", description: "APARTMENT, HOUSE, COMMERCIAL, LAND.", enum: ["APARTMENT", "HOUSE", "COMMERCIAL", "LAND"] },
        rooms: { type: "INTEGER", description: "Сколько комнат." },
        budget_min: { type: "NUMBER", description: "Бюджет от — числом." },
        budget_max: { type: "NUMBER", description: "Бюджет до — числом." },
        currency: { type: "STRING", description: "USD или TJS — только если человек назвал валюту словом.", enum: ["USD", "TJS"] },
        floor: { type: "STRING", description: "Пожелание по этажу словами звонящего («не первый», «до пятого»)." },
        market: { type: "STRING", description: "Новостройка или вторичка.", enum: ["NEW_BUILD", "SECONDARY", "ANY"] },
        condition: { type: "STRING", description: "Ремонт: с ремонтом, коробка, не важно — словами звонящего." },
        timeframe: { type: "STRING", description: "Когда планирует купить или продать («в этом месяце», «к весне»)." },
        notes: { type: "STRING", description: "Другое важное одной фразой (ориентир, школа рядом, этажность дома)." },
      },
    },
  },
  {
    name: "request_callback",
    description:
      "Человек сам выбрал, когда ему удобно, чтобы агент перезвонил («завтра после обеда», «в субботу в десять»). " +
      "Ставит агенту задачу ровно на это время. Время не выбрал — не вызывай: агент наберёт в ближайшее рабочее время.",
    parameters: {
      type: "OBJECT",
      properties: {
        day: { type: "STRING", description: DAY_DESCRIPTION },
        time: { type: "STRING", description: TIME_DESCRIPTION },
        topic: { type: "STRING", description: "О чём перезвонить, одной фразой для агента." },
      },
      required: ["day", "time"],
    },
  },
  {
    name: "showing_slots",
    description:
      "Свободное время для показа объекта, который вы обсудили (номер из search_properties/get_property). Берёт календарь показов агента. " +
      "Назови человеку одно-два времени и спроси, какое удобно. Свои времена не придумывай.",
    parameters: {
      type: "OBJECT",
      properties: {
        number: { type: "INTEGER", description: "Номер объекта из функций этого звонка." },
        day: { type: "STRING", description: `Необязательно. ${DAY_DESCRIPTION}` },
      },
      required: ["number"],
    },
  },
  {
    name: "book_showing",
    description:
      "Записать на показ, когда человек выбрал время (из showing_slots или своё). Ответ скажет, записан ли показ " +
      "или передан агенту на подтверждение — говори человеку ровно это.",
    parameters: {
      type: "OBJECT",
      properties: {
        number: { type: "INTEGER", description: "Номер объекта из функций этого звонка." },
        day: { type: "STRING", description: DAY_DESCRIPTION },
        time: { type: "STRING", description: TIME_DESCRIPTION },
      },
      required: ["number", "day", "time"],
    },
  },
  {
    name: "send_property_messenger",
    description:
      "Отправить карточку обсуждённых объектов (ссылка с фото, цена, район и улица) в WhatsApp или Telegram, где человек уже переписывался с нами. " +
      "Только если человек согласился. Не вышло (переписки нет) — предложи СМС через send_property_sms.",
    parameters: {
      type: "OBJECT",
      properties: {
        numbers: { type: "STRING", description: "Номера объектов через запятую. Не передан — все обсуждённые." },
      },
    },
  },
  {
    name: "describe_area",
    description:
      "Что рядом с объектом или местом: школы, базар, больница, парк — по нашему справочнику ориентиров, с расстоянием. " +
      "Передай number (объект из функций этого звонка) или place (место словами звонящего). Чего нет в ответе — не придумывай.",
    parameters: {
      type: "OBJECT",
      properties: {
        number: { type: "INTEGER", description: "Номер объекта из функций этого звонка." },
        place: { type: "STRING", description: "Место словами звонящего: «82 мкр», «Профсоюз», «у ЦУМа»." },
      },
    },
  },
];

const CLIENT_TOOL_NAMES = new Set(CLIENT_TOOLS.map((t) => t.name));

/** Функции этого модуля. null — функция не отсюда. Не бросает: отказ базы — ответ
 *  модели «не получилось», а не тишина в трубке. */
export async function handleClientTool(memory: PropertyCallMemory, call: LiveVoiceToolCall): Promise<LiveVoiceToolReply | null> {
  if (!CLIENT_TOOL_NAMES.has(call.name)) return null;
  try {
    switch (call.name) {
      case "my_status":
        return await myStatusTool(memory);
      case "save_client_request":
        return await saveRequestTool(memory, call.args);
      case "request_callback":
        return await requestCallbackTool(memory, call.args);
      case "showing_slots":
        return await showingSlotsTool(memory, call.args);
      case "book_showing":
        return await bookShowingTool(memory, call.args);
      case "send_property_messenger":
        return await messengerTool(memory, call.args);
      case "describe_area":
        return await describeAreaTool(memory, call.args);
    }
  } catch (err) {
    void logSystemError("telephony", `Консультант: ${call.name} не выполнен: ${describeError(err)}`, { dedupKey: `live-voice-client-tool-${call.name}` });
  }
  return reply({ ok: false, error: `база сейчас не ответила — ${AGENT_CALLBACK_ONCE}` });
}

function reply(response: Record<string, unknown>, line?: string, scheduling: LiveVoiceToolReply["scheduling"] = "WHEN_IDLE"): LiveVoiceToolReply {
  return { response: line ? attachTranscriptLine(response, line) : response, scheduling };
}

/** «завтра, в два часа дня» — и по-таджикски рядом, если таджикский разрешён. */
function whenFields(at: Date, memory: PropertyCallMemory, now = new Date()): Record<string, string> {
  return {
    when: spokenWhen(at, now, "ru"),
    ...(memory.tajikAllowed ? { when_tg: spokenWhen(at, now, "tg") } : {}),
  };
}

/** «10.10 в 15:00» по Душанбе — для расшифровки и для агента, не для речи. */
function digitsWhen(at: Date): string {
  const w = dushanbeWallClock(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(w.getUTCDate())}.${p(w.getUTCMonth() + 1)} в ${p(w.getUTCHours())}:${p(w.getUTCMinutes())}`;
}

function firstName(agent: { fullName: string; isActive: boolean; frozenAt: Date | null } | null | undefined): string | null {
  return agent?.isActive && !agent.frozenAt && agent.fullName.trim() ? agent.fullName.trim().split(/\s+/)[0] : null;
}

function str(v: unknown, max = 160): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, max) : undefined;
}

function positive(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[^\d.]/g, "")) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function shortIdArg(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/\D/g, "")) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ── my_status ─────────────────────────────────────────────────────────────────

/**
 * СТАТУС СВОЕГО КЛИЕНТА — БЕЛЫЙ СПИСОК. Отдаётся: имя его агента (если работает),
 * ближайший показ (когда, район и улица без дома; у закрытого объекта — только район),
 * стадия его сделки словами, состояние его объекта (если он продавец) словами. Не
 * отдаётся НИКОГДА: суммы сделки и комиссии, цена, телефоны, ФИО, свободный текст задач,
 * чужие клиенты. Номер входящего подделывается — поэтому даже своему только это.
 */
async function myStatusTool(memory: PropertyCallMemory): Promise<LiveVoiceToolReply> {
  if (!memory.clientId) {
    return reply({
      ok: false,
      error: "номер звонящего не записан ни за одной карточкой — про показы и сделки по телефону не рассказываем. Скажи, что это знает агент, и спроси, удобно ли, чтобы агент перезвонил",
    });
  }
  const now = new Date();
  const client = await prisma.client.findFirst({
    where: { id: memory.clientId, deletedAt: null },
    select: { id: true, assignedAgent: { select: { fullName: true, isActive: true, frozenAt: true } } },
  });
  if (!client) return reply({ ok: false, error: "карточка клиента не найдена — скажи, что уточнит агент" });

  const [showing, deal, ownProperties] = await Promise.all([
    prisma.interaction.findFirst({
      where: {
        clientId: client.id,
        type: "SHOWING",
        completedAt: null, taskCancelledAt: null,
        declinedAt: null,
        nextAction: { not: null },
        nextActionDate: { gte: now },
      },
      orderBy: { nextActionDate: "asc" },
      select: {
        nextActionDate: true,
        property: { select: { rooms: true, address: true, ...BOT_OFFER_SELECT, district: { select: { name: true } } } },
      },
    }),
    prisma.deal.findFirst({
      where: { clientId: client.id, annulledAt: null, stage: { not: "CANCELLED" } },
      orderBy: { startedAt: "desc" },
      select: { stage: true, property: { select: { district: { select: { name: true } } } } },
    }),
    prisma.property.findMany({
      where: { sellerClientId: client.id, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 3,
      select: { status: true, rooms: true, district: { select: { name: true } } },
    }),
  ]);

  const agent = firstName(client.assignedAgent);
  const nextShowing =
    showing?.nextActionDate
      ? {
          ...whenFields(showing.nextActionDate, memory, now),
          where: showing.property
            ? [
                showing.property.district?.name,
                // Улицу — тому, что ботам можно называть (lib/propertyMatch.ts::botMayOffer).
                botMayOffer(showing.property) ? streetWithoutHouse(showing.property.address) : null,
              ]
                .filter(Boolean)
                .join(", ") || null
            : null,
          rooms: showing.property?.rooms ?? null,
        }
      : null;
  const response: Record<string, unknown> = {
    ok: true,
    agent,
    next_showing: nextShowing,
    deal: deal && DEAL_STAGE_WORDS[deal.stage] ? { stage: DEAL_STAGE_WORDS[deal.stage], district: deal.property?.district?.name ?? null } : null,
    own_properties: ownProperties.map((p) => ({
      status: OWN_PROPERTY_STATUS_WORDS[p.status] ?? null,
      rooms: p.rooms,
      district: p.district?.name ?? null,
    })),
    note:
      "Это данные самого звонящего. Ответь на то, что спросил, одной-двумя фразами. Сумм, цен и чужих данных здесь нет и называть их нельзя. " +
      "Чего нет в ответе (почему перенесли, какие документы, сколько уступят) — это знает агент" +
      (agent ? ` ${agent}.` : ".") +
      (nextShowing ? "" : " Показа не назначено — так и скажи, если спросят."),
  };
  return reply(
    response,
    `[статус клиента: агент ${agent ?? "—"}; показ ${showing?.nextActionDate ? digitsWhen(showing.nextActionDate) : "нет"}; сделка ${deal ? deal.stage : "нет"}; объектов продавца ${ownProperties.length}]`
  );
}

// ── save_client_request ───────────────────────────────────────────────────────

/** Белый список условий — каждое поле проверено, свободный текст обрезан. */
export function sanitizeClientRequest(args: Record<string, unknown>): ClientCallRequest {
  const out: ClientCallRequest = {};
  if (args.intent === "buy" || args.intent === "sell") out.intent = args.intent;
  const district = LIVE_VOICE_DISTRICTS.find((d) => d === args.district);
  if (district) out.districtName = district;
  if (typeof args.type === "string" && ["APARTMENT", "HOUSE", "COMMERCIAL", "LAND"].includes(args.type)) out.type = args.type;
  const rooms = positive(args.rooms);
  if (rooms && rooms <= 20) out.rooms = Math.round(rooms);
  const min = positive(args.budget_min);
  const max = positive(args.budget_max);
  if (min) out.budgetMin = Math.round(min);
  if (max) out.budgetMax = Math.round(max);
  const currency = typeof args.currency === "string" ? args.currency.trim().toUpperCase() : "";
  if (currency === "USD" || currency === "TJS") out.currency = currency;
  if (args.market === "NEW_BUILD" || args.market === "SECONDARY") out.market = args.market;
  for (const key of ["floor", "condition", "timeframe", "notes"] as const) {
    const v = str(args[key], key === "notes" ? 200 : 80);
    if (v) out[key] = v;
  }
  return out;
}

const TYPE_WORDS: Record<string, string> = { APARTMENT: "квартира", HOUSE: "дом", COMMERCIAL: "коммерческое", LAND: "участок" };

/** Условия одной строкой — для агента в записи звонка и в расшифровке. */
export function clientRequestText(r: ClientCallRequest): string {
  const money = (n: number) => `${n.toLocaleString("ru-RU").replace(/\s/g, " ")}${r.currency === "USD" ? " $" : r.currency === "TJS" ? " с." : " (валюта не названа)"}`;
  return [
    r.intent === "sell" ? "продаёт" : r.intent === "buy" ? "покупает" : null,
    r.type ? TYPE_WORDS[r.type] : null,
    r.rooms ? `${r.rooms}-комн.` : null,
    r.districtName ?? null,
    r.budgetMin && r.budgetMax ? `бюджет ${money(r.budgetMin)}–${money(r.budgetMax)}` : r.budgetMax ? `бюджет до ${money(r.budgetMax)}` : r.budgetMin ? `бюджет от ${money(r.budgetMin)}` : null,
    r.market === "NEW_BUILD" ? "новостройка" : r.market === "SECONDARY" ? "вторичка" : null,
    r.condition ? `ремонт: ${r.condition}` : null,
    r.floor ? `этаж: ${r.floor}` : null,
    r.timeframe ? `срок: ${r.timeframe}` : null,
    r.notes ?? null,
  ]
    .filter(Boolean)
    .join(", ");
}

async function saveRequestTool(memory: PropertyCallMemory, args: Record<string, unknown>): Promise<LiveVoiceToolReply> {
  const fresh = sanitizeClientRequest(args);
  if (Object.keys(fresh).length === 0) return reply({ ok: false, error: "нечего записать: передай то, что человек сказал" });
  const merged: ClientCallRequest = { ...(memory.request ?? {}), ...fresh };
  memory.request = merged;
  // В общее досье — теми же ключами, что пишет чат-бот (BUYER_KEYS): район, тип,
  // комнаты, бюджет В СОМОНИ. Бюджет без названной валюты в досье не идёт: бюджет с
  // неверной валютой хуже пустого (то же правило, что в search_properties).
  if (memory.contactProfileId && merged.intent !== "sell") {
    try {
      const rate = merged.currency === "USD" ? (await loadMoneyContext()).usdToTjs : 1;
      const tjs = (n: number | undefined) => (n && merged.currency ? Math.round(convertToTjs(n, merged.currency, rate)) : undefined);
      await recordContactFacts({
        profileId: memory.contactProfileId,
        domain: "buyer",
        values: {
          ...(merged.intent ? { intent: merged.intent } : {}),
          districtName: merged.districtName,
          type: merged.type,
          rooms: merged.rooms,
          budgetMin: tjs(merged.budgetMin),
          budgetMax: tjs(merged.budgetMax),
        },
        source: "model",
        conversationId: null,
      });
    } catch (err) {
      void logSystemError("contact-profile", `Консультант: условия звонящего в досье не записаны: ${describeError(err)}`);
    }
  }
  if (memory.contactProfileId && merged.intent) {
    const category = categoryFromIntent(merged.intent);
    if (category) await setContactCategory({ profileId: memory.contactProfileId, category, source: "model", conversationId: null }).catch(() => undefined);
  }
  return reply({ ok: true }, `[условия клиента: ${clientRequestText(merged)}]`, "SILENT");
}

// ── request_callback ──────────────────────────────────────────────────────────

async function requestCallbackTool(memory: PropertyCallMemory, args: Record<string, unknown>): Promise<LiveVoiceToolReply> {
  const now = new Date();
  // Разбор дня и времени — тот же, что у показа (resolveShowingSlot): «завтра», «evening»,
  // «2026-10-11» по Душанбе, без setHours.
  const slot = resolveShowingSlot({ day: str(args.day), time: str(args.time) }, now);
  if (!slot.ok) {
    const error =
      slot.reason === "no_time"
        ? "время не разобрать — переспроси день и час"
        : slot.reason === "too_far"
          ? "это дальше месяца — предложи время поближе"
          : slot.reason === "past"
            ? "это время уже прошло или наступит меньше чем через полчаса — скажи, что агент наберёт в ближайшее рабочее время, и не вызывай функцию снова"
            : "это поздно или рано — агенты на связи в рабочие часы; предложи время в рабочие часы";
    return reply({ ok: false, error });
  }
  // Перезванивать будет агент клиента — его личный выходной (11.10.2026) тоже закрыт.
  const callbackAgentDaysOff = await clientAgentDaysOff(memory);
  if (!(await isWithinConsultantHours(slot.at, callbackAgentDaysOff))) {
    return reply({
      ok: false,
      error: "в это время агент не на связи (нерабочее время или у агента выходной) — предложи другое время в рабочие часы из справочника",
    });
  }
  memory.callbackAt = slot.at;
  memory.callbackTopic = str(args.topic, 200) ?? null;
  return reply(
    {
      ok: true,
      ...whenFields(slot.at, memory, now),
      note: "Задача агенту поставлена. Скажи человеку одной фразой, что агент наберёт в это время, и больше звонок агента в этом разговоре не обещай.",
    },
    `[перезвон: задача агенту на ${digitsWhen(slot.at)}${memory.callbackTopic ? ` — ${memory.callbackTopic}` : ""}]`
  );
}

// ── showing_slots / book_showing ──────────────────────────────────────────────

/** Часы, которые робот предлагает для показа: в окне показов (09:00–20:00, showingBooking.ts),
 *  с запасом от краёв — первый показ в десять, последний в семь. */
const SLOT_HOURS = [10, 11, 12, 14, 15, 16, 17, 18, 19] as const;
const SLOTS_TO_OFFER = 3;

interface ShowingProperty extends BotOfferFields {
  id: string;
  shortId: number;
  address: string | null;
  district: { name: string } | null;
  assignedAgentId: string | null;
  intakeAgentId: string | null;
  createdById: string | null;
}

/** Объект, обсуждённый в этом звонке (номер из функций, а не выдуманный). */
async function discussedProperty(memory: PropertyCallMemory, number: unknown): Promise<ShowingProperty | null> {
  const shortId = shortIdArg(number);
  if (shortId === null || !memory.discussedShortIds.includes(shortId)) return null;
  return prisma.property.findFirst({
    where: { shortId, deletedAt: null },
    select: {
      id: true,
      shortId: true,
      ...BOT_OFFER_SELECT,
      address: true,
      district: { select: { name: true } },
      assignedAgentId: true,
      intakeAgentId: true,
      createdById: true,
    },
  });
}

/** Личные выходные агента клиента (он перезванивает). Нет клиента/агента — пусто. */
async function clientAgentDaysOff(memory: PropertyCallMemory): Promise<number[]> {
  if (!memory.clientId) return [];
  const client = await prisma.client
    .findFirst({ where: { id: memory.clientId, deletedAt: null }, select: { assignedAgent: { select: { weeklyDaysOff: true } } } })
    .catch(() => null);
  return normalizeDaysOff(client?.assignedAgent?.weeklyDaysOff);
}

/** Кто поедет на показ — то же правило, что у bookShowing: агент клиента, иначе агент
 *  объекта (у незнакомца — хозяин объекта по раздаче, propertyOwnerAgentId). Уволенный и
 *  замороженный (отпуск) — никто. */
async function showingAgent(memory: PropertyCallMemory, p: ShowingProperty): Promise<{ id: string; name: string | null } | null> {
  const client = memory.clientId
    ? await prisma.client.findFirst({ where: { id: memory.clientId, deletedAt: null }, select: { assignedAgentId: true } })
    : null;
  const agentId = client?.assignedAgentId ?? p.assignedAgentId ?? propertyOwnerAgentId(p);
  if (!agentId) return null;
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { id: true, fullName: true, isActive: true, frozenAt: true } });
  if (!agent?.isActive || agent.frozenAt) return null;
  return { id: agent.id, name: firstName(agent) };
}

/**
 * Дни, на которые ищем время: названный, иначе ближайшие два РАБОЧИХ дня агента — без
 * общих выходных и его личных (Настройки, 11.10.2026; до этого — без воскресенья).
 */
function candidateDays(day: string | undefined, now: Date, cal: DaysOffCalendar): string[] {
  if (day) return [day];
  const days: string[] = [];
  for (let i = 0; days.length < 2 && i < 9; i++) {
    const at = new Date(now.getTime() + i * 86_400_000);
    if (!isDayOff(at, cal)) days.push(dushanbeDateString(at));
  }
  return days;
}

/**
 * СВОБОДНОЕ ВРЕМЯ АГЕНТА ПО КАЛЕНДАРЮ ПОКАЗОВ CRM. Отдельного графика у агента нет
 * (решение владельца 31.07, showingBooking.ts) — занятость = его открытые показы, как в
 * календаре (routes/calendar.ts: agentId ИЛИ subjectAgentId: показ, записанный ботом,
 * подписан subjectAgentId). Час занят, если до показа агента меньше часа
 * (SHOWING_CONFLICT_WINDOW_MS). Выходные — общие и личные этого агента (Настройки,
 * 11.10.2026): на свой выходной агенту время не предлагается. Уже назначенные показы
 * этим не трогаются — они остаются и напоминания по ним идут как обычно.
 */
export async function freeShowingSlots(agentId: string, day: string | undefined, now: Date = new Date()): Promise<Date[]> {
  const cal = await loadDaysOffCalendar(agentId);
  const candidates: Date[] = [];
  for (const d of candidateDays(day, now, cal)) {
    for (const h of SLOT_HOURS) {
      const slot = resolveShowingSlot({ day: d, time: `${String(h).padStart(2, "0")}:00` }, now);
      if (slot.ok && !isDayOff(slot.at, cal)) candidates.push(slot.at);
    }
  }
  if (candidates.length === 0) return [];
  const from = new Date(candidates[0].getTime() - SHOWING_CONFLICT_WINDOW_MS);
  const to = new Date(candidates[candidates.length - 1].getTime() + SHOWING_CONFLICT_WINDOW_MS);
  const busy = await prisma.interaction.findMany({
    where: {
      OR: [{ agentId }, { subjectAgentId: agentId }],
      type: "SHOWING",
      completedAt: null, taskCancelledAt: null,
      declinedAt: null,
      nextAction: { not: null },
      nextActionDate: { gte: from, lte: to },
    },
    select: { nextActionDate: true },
    take: 200,
  });
  const taken = busy.map((b) => b.nextActionDate!.getTime());
  return candidates.filter((c) => taken.every((t) => Math.abs(t - c.getTime()) >= SHOWING_CONFLICT_WINDOW_MS));
}

/** Свободные часы вразбивку: первый, середина и последний — чтобы человеку было из чего выбрать. */
function spread(slots: Date[], n: number): Date[] {
  if (slots.length <= n) return slots;
  return [slots[0], slots[Math.floor(slots.length / 2)], slots[slots.length - 1]].slice(0, n);
}

async function showingSlotsTool(memory: PropertyCallMemory, args: Record<string, unknown>): Promise<LiveVoiceToolReply> {
  const p = await discussedProperty(memory, args.number);
  if (!p) return reply({ ok: false, error: "этот объект в звонке не обсуждали — сначала найди его через get_property или search_properties" });
  if (p.status !== "AVAILABLE") return reply({ ok: false, error: "объект сейчас не в продаже (в брони или продан) — показ не записать; предложи похожие" });
  // Показы боту выключены (Settings.botCanBookShowings) — тот же тумблер, что у чата и у
  // book_showing (аудит 10.10.2026, P1-3): время показа робот с клиентом не обсуждает.
  if (!(await loadBotCapabilities()).showings) {
    return reply(
      { ok: false, error: `время показа назовёт агент — сам время не предлагай; спроси, удобно ли, чтобы агент набрал и договорился; ${AGENT_CALLBACK_ONCE}` },
      `[время показа №${p.shortId}: показы боту выключены — время назовёт агент]`
    );
  }
  const agent = await showingAgent(memory, p);
  if (!agent) return reply({ ok: false, error: `у объекта сейчас нет агента на месте — время показа назовёт агент; ${AGENT_CALLBACK_ONCE}` });
  const now = new Date();
  const slots = spread(await freeShowingSlots(agent.id, str(args.day), now), SLOTS_TO_OFFER);
  if (slots.length === 0) {
    return reply({ ok: true, slots: [], note: "На этот день свободного времени нет — спроси другой день и вызови снова." }, `[время показа №${p.shortId}: свободного нет]`);
  }
  return reply(
    {
      ok: true,
      slots: slots.map((at) => ({ day: dushanbeDateString(at), time: digitsWhen(at).slice(-5), ...whenFields(at, memory, now) })),
      note: "Назови человеку одно-два времени словами (поле when) и спроси, какое удобно. Выбрал — book_showing с day и time этого варианта.",
    },
    `[время показа №${p.shortId}: предложено ${slots.map(digitsWhen).join(", ")}]`
  );
}

const BOOKING_PROBLEM_WORDS: Partial<Record<BookingProblem, string>> = {
  no_time: "время не разобрать — переспроси день и час",
  outside_hours: "показы бывают с девяти утра до восьми вечера — предложи время в этом окне",
  past: "это время уже прошло или слишком скоро — предложи другое",
  too_far: "это дальше месяца — предложи время поближе",
  unavailable: "объект сейчас не в продаже — показ не записать; предложи похожие",
  no_property: "объект не найден — уточни, о каком речь",
};

async function bookShowingTool(memory: PropertyCallMemory, args: Record<string, unknown>): Promise<LiveVoiceToolReply> {
  const p = await discussedProperty(memory, args.number);
  if (!p) return reply({ ok: false, error: "этот объект в звонке не обсуждали — сначала найди его через get_property или search_properties" });
  const request = { action: "book" as const, propertyCode: p.shortId, day: str(args.day), time: str(args.time) };
  const now = new Date();
  const slot = resolveShowingSlot(request, now);
  if (!slot.ok) return reply({ ok: false, error: BOOKING_PROBLEM_WORDS[slot.reason] ?? "время не подходит — предложи другое" });
  // Выходной — общий или того, кто поедет на показ (Настройки, 11.10.2026).
  const showingBy = await showingAgent(memory, p);
  if (isDayOff(slot.at, await loadDaysOffCalendar(showingBy?.id))) {
    return reply({ ok: false, error: "в этот день у агента выходной — предложи другой день" });
  }
  if (p.status !== "AVAILABLE") return reply({ ok: false, error: BOOKING_PROBLEM_WORDS.unavailable! });

  // Показы боту выключены (Настройки → Бот, botCanBookShowings; решение владельца 01.08:
  // показ назначает живой агент) или звонящий не наш клиент (без карточки показ не
  // записать, bookShowing → no_client): НЕ ЗАПИСЫВАЕМ и не говорим «записала» — агенту
  // уходит задача подтвердить ровно это время.
  const canBook = !!memory.clientId && (await loadBotCapabilities()).showings;
  if (canBook) {
    const booked = await bookShowing({ clientId: memory.clientId!, request, channel: "PHONE", actor: { kind: "client", channel: "PHONE" }, now });
    if (booked.ok) {
      memory.bookedShowing = { shortId: p.shortId, at: booked.at, interactionId: booked.interactionId };
      const agent = booked.agentId ? await prisma.agent.findUnique({ where: { id: booked.agentId }, select: { fullName: true, isActive: true, frozenAt: true } }) : null;
      const agentName = firstName(agent);
      const smsSent = await sendShowingConfirmation(memory, p, booked.at, agentName);
      return reply(
        {
          ok: true,
          booked: true,
          ...whenFields(booked.at, memory, now),
          agent: agentName,
          sms_confirmation: smsSent,
          note:
            "Показ записан в CRM. Скажи человеку: записали на это время" +
            (agentName ? `, показывать будет ${agentName}` : "") +
            ". Точный адрес и как подъехать скажет агент перед показом." +
            (smsSent ? " Подтверждение пришло ему по СМС." : ""),
        },
        `[показ: записан №${p.shortId} на ${digitsWhen(booked.at)}${booked.rescheduled ? " (перенос)" : ""}; СМС-подтверждение ${smsSent ? "отправлено" : "не отправлено"}]`
      );
    }
    if (booked.reason !== "no_agent" && booked.reason !== "no_client") {
      return reply({ ok: false, error: BOOKING_PROBLEM_WORDS[booked.reason] ?? "показ не записался — предложи другое время" });
    }
  }
  memory.showingWish = { shortId: p.shortId, at: slot.at };
  return reply(
    {
      ok: true,
      booked: false,
      passed_to_agent: true,
      ...whenFields(slot.at, memory, now),
      note:
        "Показ НЕ записан: время передано агенту, агент перезвонит и подтвердит. Так и скажи: «передала агенту, агент подтвердит показ на это время». " +
        "Не говори, что показ уже назначен.",
    },
    `[показ: передано агенту на подтверждение №${p.shortId} на ${digitsWhen(slot.at)}]`
  );
}

/** Подтверждение записанного показа — СМС на номер, с которого звонят (не на
 *  продиктованный: чужому человеку подтверждение незачем). Без номера дома. */
async function sendShowingConfirmation(memory: PropertyCallMemory, p: ShowingProperty, at: Date, agentName: string | null): Promise<boolean> {
  const phone = memory.callerPhone;
  if (!phone || !toSmsPhone(phone)) return false;
  const where = [p.district?.name, botMayOffer(p) ? streetWithoutHouse(p.address) : null].filter(Boolean).join(", ");
  const text = showingConfirmationText(at, where, agentName);
  try {
    const result = await sendSms({ phone, text, purpose: "SHOWING_CONFIRM", clientId: memory.clientId, propertyId: p.id });
    return result.ok;
  } catch (err) {
    void logSystemError("telephony", `Консультант: СМС о показе не ушло: ${describeError(err)}`);
    return false;
  }
}

export function showingConfirmationText(at: Date, where: string, agentName: string | null): string {
  return `Royal Home: показ ${digitsWhen(at)}${where ? `, ${where}` : ""}.${agentName ? ` Агент ${agentName}.` : ""} Точный адрес сообщит агент.`;
}

// ── send_property_messenger ───────────────────────────────────────────────────

/** Переписка звонящего: по его карточке, иначе WhatsApp-диалог на номер, с которого
 *  он звонит (у WhatsApp subscriberId — сам номер). Только номер звонка: на
 *  продиктованный номер не пишем — он может быть чужим. */
async function callerConversation(memory: PropertyCallMemory): Promise<DeliveryTarget | null> {
  if (memory.clientId) {
    const target = await findClientDeliveryTarget(memory.clientId);
    if (target) return target;
  }
  const digits = (memory.callerPhone ?? "").replace(/\D/g, "");
  if (digits.length < 9) return null;
  const conv = await prisma.botConversation.findFirst({
    where: { channel: "WHATSAPP", subscriberId: { endsWith: digits.slice(-9) }, OR: [{ clientId: null }, { client: { deletedAt: null } }] },
    orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }],
    select: { id: true, channel: true, subscriberId: true, accountId: true },
  });
  return conv ? { kind: "bot", id: conv.id, channel: conv.channel, subscriberId: conv.subscriberId, accountId: conv.accountId } : null;
}

/** Карточка объекта в переписку — белый список: комнаты, район, улица без дома, метры,
 *  цена и ссылка общим botOfferLink (lib/propertyMatch.ts): страница на сайте (там
 *  фото, видео), у объекта не с сайта — пост Instagram; нет ни того ни другого —
 *  карточка без ссылки, адрес не придумываем. Без точки на карте: геометка отдала
 *  бы дом точнее номера. */
export function messengerCardText(
  props: {
    id: string;
    siteListingId?: number | null;
    publishedOnSite: boolean;
    instagramUrl?: string | null;
    rooms: number | null;
    areaSqm: unknown;
    price: unknown;
    currency: string;
    address: string | null;
    district: { name: string } | null;
  }[]
): string {
  const lines = props.map((p) => {
    const price = Math.round(Number(p.price)).toLocaleString("ru-RU").replace(/\s/g, " ");
    const facts = [
      p.rooms ? `${p.rooms}-комн.` : null,
      [p.district?.name, streetWithoutHouse(p.address)].filter(Boolean).join(", ") || null,
      Number(p.areaSqm) > 0 ? `${Math.round(Number(p.areaSqm))} м²` : null,
      p.currency === "USD" ? `$${price}` : `${price} сомони`,
    ]
      .filter(Boolean)
      .join(", ");
    const link = botOfferLink(p);
    return link ? `${facts}\n${link}` : facts;
  });
  return `Royal Home, по нашему разговору:\n\n${lines.join("\n\n")}`;
}

async function messengerTool(memory: PropertyCallMemory, args: Record<string, unknown>): Promise<LiveVoiceToolReply> {
  if (memory.messengerSent) return reply({ ok: false, error: "в переписку в этом звонке уже отправляли — второй раз не шлём" });
  const asked = typeof args.numbers === "string" ? [...new Set(args.numbers.split(/[^\d]+/).filter(Boolean).map(Number))] : [];
  const wanted = (asked.length ? asked.filter((n) => memory.discussedShortIds.includes(n)) : memory.discussedShortIds).slice(0, 3);
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
          areaSqm: true,
          price: true,
          currency: true,
          address: true,
          district: { select: { name: true } },
        },
      })
    : [];
  if (props.length === 0) return reply({ ok: false, error: "нечего отправить: сначала расскажи про варианты (search_properties или get_property)" });
  const target = await callerConversation(memory);
  if (!target) {
    return reply({ ok: false, error: "переписки с этим номером в WhatsApp или Telegram у нас нет — предложи прислать ссылки по СМС (send_property_sms)" }, "[мессенджер: переписки нет]");
  }
  const channel = target.kind === "telegram" ? "TELEGRAM" : target.channel;
  if (!isMessagingWindowOpen(channel, await lastClientMessageAt(target))) {
    return reply(
      { ok: false, error: "человек давно не писал нам в WhatsApp — первыми туда написать нельзя; предложи СМС (send_property_sms) или попроси написать нам в WhatsApp" },
      `[мессенджер: ${channel} — окно закрыто]`
    );
  }
  const ordered = wanted.map((n) => props.find((p) => p.shortId === n)).filter((p): p is (typeof props)[number] => !!p);
  const sent = await deliverToConversation(target, messengerCardText(ordered), undefined, { sender: { kind: "bot" } });
  if (!sent.ok) {
    return reply({ ok: false, error: "сообщение не ушло — предложи СМС (send_property_sms)" }, `[мессенджер: ${channel} — не ушло: ${sent.error.slice(0, 80)}]`);
  }
  memory.messengerSent = true;
  return reply(
    { ok: true, sent: ordered.length, channel: channel === "TELEGRAM" ? "Telegram" : "WhatsApp" },
    `[мессенджер: ${channel} — отправлено ${ordered.map((p) => `№${p.shortId}`).join(", ")}]`
  );
}

// ── describe_area ─────────────────────────────────────────────────────────────

/** Радиус «объектов поблизости» для справки о месте. */
const AREA_LISTINGS_RADIUS_M = 1500;

async function describeAreaTool(memory: PropertyCallMemory, args: Record<string, unknown>): Promise<LiveVoiceToolReply> {
  let point: { lat: number; lng: number; name: string | null } | null = null;
  const shortId = shortIdArg(args.number);
  if (shortId !== null) {
    if (!memory.discussedShortIds.includes(shortId)) return reply({ ok: false, error: "этот объект в звонке не обсуждали — сначала найди его" });
    const p = await prisma.property.findFirst({
      where: { shortId, deletedAt: null },
      select: { lat: true, lng: true, ...BOT_OFFER_SELECT, district: { select: { name: true } } },
    });
    // Объект, который ботам предлагать нельзя, показывают лично: что рядом с ним — то
    // же, что его адрес (lib/propertyMatch.ts::botMayOffer).
    if (!p || !botMayOffer(p)) return reply({ ok: false, error: "про этот объект подробности даёт агент — так и скажи" });
    if (p.lat === null || p.lng === null) {
      return reply({ ok: false, error: "у объекта нет точки на карте — что рядом, скажет агент; не придумывай" });
    }
    point = { lat: Number(p.lat), lng: Number(p.lng), name: null };
  } else {
    const text = str(args.place, 80);
    if (!text) return reply({ ok: false, error: "передай номер объекта или место словами звонящего" });
    // Только точное совпадение или начало названия: «похоже по буквам» (fuzzy) привело
    // бы робота рассказывать про другое место уверенным голосом.
    const resolved = await resolveGeoText(text);
    const found = resolved && resolved.confidence !== "fuzzy" ? resolved : null;
    if (!found) return reply({ ok: false, error: "такого места в справочнике нет — переспроси или скажи, что уточнит агент; не придумывай" });
    point = { lat: found.lat, lng: found.lng, name: found.name };
  }

  const tg = !!memory.tajikAllowed;
  const [area, landmarks, listings] = await Promise.all([
    nearestPlaceArea(point.lat, point.lng),
    nearbyLandmarks(point.lat, point.lng, 4),
    shortId === null ? listingsNear(point.lat, point.lng) : Promise.resolve(null),
  ]);
  const response: Record<string, unknown> = {
    ok: true,
    place: point.name,
    area: area?.name ?? null,
    nearby: landmarks.map((l) => ({
      name: l.name,
      what: l.category,
      distance: spokenDistance(l.distanceM, "ru"),
      ...(tg ? { distance_tg: spokenDistance(l.distanceM, "tg") } : {}),
    })),
    ...(listings !== null ? { our_listings_nearby: listings, listings_words: numberToWords(listings, "ru") } : {}),
    note:
      "Назови одно-два места, важных для человека (школа, базар, транспорт), с расстоянием словами. Чего нет в списке — не придумывай: «точнее скажет агент»." +
      (listings !== null ? " our_listings_nearby — сколько наших объектов в продаже в полутора километрах; есть — предложи посмотреть через search_properties." : ""),
  };
  return reply(response, `[что рядом: ${point.name ?? `объект №${shortId}`} — ${landmarks.map((l) => l.name).join(", ") || "ориентиров нет"}]`);
}

/** Сколько наших объектов в продаже рядом с точкой — счётчик, без адресов. */
async function listingsNear(lat: number, lng: number): Promise<number> {
  const box = boundingBoxAround(lat, lng, AREA_LISTINGS_RADIUS_M);
  const rows = await prisma.property.findMany({
    where: {
      status: "AVAILABLE",
      // Считаем то же, что подбор потом предложит (lib/propertyMatch.ts).
      AND: [botOfferableWhere()],
      lat: { gte: box.minLat, lte: box.maxLat },
      lng: { gte: box.minLng, lte: box.maxLng },
    },
    select: { lat: true, lng: true },
    take: 200,
  });
  return rows.filter((r) => haversineMeters(lat, lng, Number(r.lat), Number(r.lng)) <= AREA_LISTINGS_RADIUS_M).length;
}

/** Для тестов: момент по Душанбе «YYYY-MM-DD HH:MM» → Date. */
export function dushanbeMoment(day: string, hhmm: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  const [h, min] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, h, min) - DUSHANBE_OFFSET_MS);
}
