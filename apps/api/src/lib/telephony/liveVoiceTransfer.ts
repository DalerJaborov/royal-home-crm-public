import { prisma } from "../../db.js";
import type { LiveVoiceFunctionDeclaration, LiveVoiceToolCall } from "../../ai/liveVoiceClient.js";
import { notifyFeedOnly } from "../notifications.js";
import { describeError } from "../describeError.js";
import { logSystemError } from "../systemError.js";
import { isWithinConsultantHours } from "./consultantHours.js";
import { noteConsultantReturned, noteConsultantTransfer } from "./incomingCalls.js";
import type { RouteFallback } from "./inboundRouting.js";
import { pickTransferAgent, transferLiveCallToAgent, type TransferRefusal } from "./liveCallTransfer.js";
import type { LiveVoiceToolReply } from "./liveVoiceBridge.js";
import { AGENT_CALLBACK_ONCE, describeDiscussedProperties, type PropertyCallMemory } from "./liveVoicePropertyTools.js";
import { clientRequestText } from "./liveVoiceClientTools.js";

/**
 * ПЕРЕВОД ЖИВОГО ЗВОНКА АГЕНТУ (24.09.2026, робозвонок-консультант, правка 4).
 *
 * Dan 24.09: консультант «соединяет с любым агентом без проблем, как только узнает
 * объект или если просто по желанию». Кому:
 *  1. названный объект — агенту, который его ведёт (propertyOwnerAgentId: тот же
 *     выбор, что у раздачи лидов по объекту);
 *  2. иначе клиент нашего агента — его агенту;
 *  3. иначе — дежурному для перевода (Настройки → Живой голос), а не назначен —
 *     дежурному оператору обратных звонков.
 *
 * Кому и как — общая с оператором часть (liveCallTransfer.ts): станции звонок
 * уходит ТЕМ ЖЕ путём, что перевод известного клиента его агенту, те же
 * переменные канала и тот же контекст royalhome-agent-route (inboundRouting.ts). Агенту играет та же подсказка в ухо, если она для этого
 * клиента уже озвучена, а о чём звонок — строкой в ленте CRM и записью в карточке
 * клиента (liveVoiceConsultant.ts), с приметами объекта, а не номером. Пуша в
 * телефон нет: Dan 24.09 «уведомлением в телефон не надо, меньше пуша» — телефон
 * агента и так звонит.
 *
 * Не взял агент — звонок возвращается консультанту (RH_ROUTE_FALLBACK "ai"), а не
 * на автоответчик: решение Dan 24.09 «автоответчика больше не будет». Исключение
 * (владелец 11.10.2026) — клиент работающего агента: ему голосовая почта, см.
 * transferFallback. Пока станция
 * не знает этого значения, диалплан трактует его как «очередь операторов» — тот же
 * безопасный путь, что и при любом незнакомом значении.
 *
 * В нерабочее время не переводит: агенты не на месте, и звонок на мобильный ночью —
 * не то, что обещали клиенту. Консультант говорит, что агент перезвонит утром.
 */

export const TRANSFER_TOOL: LiveVoiceFunctionDeclaration = {
  name: "transfer_to_agent",
  description:
    "Соединить звонящего с живым агентом прямо сейчас. Вызывай ТОЛЬКО когда человек согласился на твой вопрос («да, соедините») " +
    "или сам попросил живого человека. Заинтересовался объектом — сначала спроси, соединить ли сейчас, и жди ответа; без «да» не вызывай. " +
    "Речь об объекте — передай его number. ПЕРЕД вызовом коротко, своими словами, по смыслу «секунду, соединяю» (имя агента — " +
    "только если его ещё не называли в этом звонке), и замолчи. Ответила ошибкой — спокойно продолжай разговор; если ещё не звучало, " +
    "что агент наберёт сам, скажи это один раз.",
  parameters: {
    type: "OBJECT",
    properties: {
      property_number: { type: "INTEGER", description: "Номер объекта из search_properties или get_property, если речь о нём." },
      summary: {
        type: "STRING",
        description: "Одной фразой для агента: кто звонит и что хочет. Например: «Фарход, ищет двушку в Сино до 60 тысяч долларов».",
      },
    },
    required: ["summary"],
  },
};

/** Сколько звонить агенту при переводе от консультанта. Короче, чем своему клиенту
 *  (Settings.incomingRouteRingSeconds, 150 с): человек только что говорил с нами и
 *  ждёт живого ответа, а не гудков две с половиной минуты. Не взял — вернётся к
 *  консультанту. */
export const TRANSFER_RING_SECONDS = 30;

export interface TransferContext {
  channelId: string;
  clientId: string | null;
  /** Имя, которым человек назвался в этом звонке. */
  callerName: string | null;
  properties: PropertyCallMemory;
  /** Вызов отменён моделью или упёрся в потолок: канал к агенту не уводим (LIVE05). */
  isCancelled?: () => boolean;
}

export { pickTransferAgent } from "./liveCallTransfer.js";

const fail = (error: string): LiveVoiceToolReply => ({ response: { ok: false, error }, scheduling: "INTERRUPT" });

export async function handleTransferTool(ctx: TransferContext, call: LiveVoiceToolCall): Promise<LiveVoiceToolReply | null> {
  if (call.name !== TRANSFER_TOOL.name) return null;
  try {
    return await transfer(ctx, call.args);
  } catch (err) {
    void logSystemError("telephony", `Консультант: перевод звонка ${ctx.channelId} не удался: ${describeError(err)}`);
    return fail(`соединить не получилось; ${AGENT_CALLBACK_ONCE}`);
  }
}

/** Что консультант говорит звонящему, когда перевода нет. Без «он/она» про агента
 *  (02.10.2026: агент Ноза — «он перезвонит»), без «нерабочее время» и «все заняты»
 *  (казённые фразы с живого звонка), и обещание звонка — один раз за разговор. */
function refusalForCaller(reason: TransferRefusal, firstName: string): string {
  switch (reason) {
    case "after_hours":
      // Срок — тот, что в правиле «КОГДА ПОЗВОНИТ АГЕНТ» промта (ai/agencyFacts.ts::callbackPromise,
      // 10.10.2026): голое «утром» в субботу вечером вело на воскресенье-выходной.
      return "соединить сейчас не выйдет; если ещё не звучало, скажи только, что агент наберёт сам — в срок из правила «КОГДА ПОЗВОНИТ АГЕНТ» (не «утром» наугад), без слов «нерабочее время», «заняты», «к сожалению»";
    case "no_phone":
      return `у ${firstName} нет рабочего телефона в CRM — соединить не выйдет; ${AGENT_CALLBACK_ONCE}`;
    case "busy":
      return `${firstName} сейчас на другом звонке — соединить не выйдет; если ещё не звучало, скажи один раз, что ${firstName} наберёт, как освободится`;
    case "no_station":
      return `соединить не получилось; ${AGENT_CALLBACK_ONCE}`;
    case "offline":
      return `${firstName} сейчас не на связи — соединить не выйдет; ${AGENT_CALLBACK_ONCE}`;
    case "failed":
      return `соединить с ${firstName} не получилось; ${AGENT_CALLBACK_ONCE}`;
    default:
      return `соединить не получилось; ${AGENT_CALLBACK_ONCE}`;
  }
}

/**
 * ПЕРЕВОД НА ЗВОНОК УЖЕ ИДЁТ (третий аудит робота 02.10.2026, мост п.8). Мост хранит ОДИН
 * общий итог перевода на сессию: второй вызов «соедини» с другим агентом получал «ок»
 * первого, канал уходил к первому, а CRM записывала передачу и ленту второму — разговор
 * засчитывался человеку, который трубку не брал. Здесь, на стороне CRM: по звонку один
 * получатель; тот же агент повторно — тот же итог без второй отметки и ленты, другой —
 * отказ с понятной моделью причиной.
 */
const transfersInFlight = new Map<string, { agentId: string; reply: Promise<LiveVoiceToolReply> }>();

async function transfer(ctx: TransferContext, args: Record<string, unknown>): Promise<LiveVoiceToolReply> {
  // Ночью не ищем, кому звонить: отказ один и тот же, а разговор не ждёт базу.
  if (!(await isWithinConsultantHours())) return fail(refusalForCaller("after_hours", ""));
  const number = await transferPropertyNumber(ctx.properties, args.property_number);
  // Режим «после оператора»: оператор первой линии уже не взял — второй раз ему не звоним (P1-4).
  const picked = await pickTransferAgent(ctx, number, { skipOperatorWhenNoAnswer: true });
  if (!picked) return fail(`соединить сейчас не с кем; ${AGENT_CALLBACK_ONCE}`);
  const { agent } = picked;
  const firstName = agent.fullName.trim().split(/\s+/)[0];
  const summary = typeof args.summary === "string" ? args.summary.trim().slice(0, 300) : "";
  const inFlight = transfersInFlight.get(ctx.channelId);
  if (inFlight) {
    if (inFlight.agentId === agent.id) return inFlight.reply;
    return fail("соединение уже идёт с другим агентом — дождись его; не вызывай перевод второй раз");
  }
  const reply = runTransfer(ctx, agent, picked, firstName, summary);
  transfersInFlight.set(ctx.channelId, { agentId: agent.id, reply });
  // Неудачный перевод можно повторить; удавшийся держим ещё минуту — повторный вызов
  // после него получает тот же ответ, а не вторую отметку.
  void reply.then((r) => {
    const ok = (r.response as { ok?: boolean }).ok === true;
    const drop = () => {
      if (transfersInFlight.get(ctx.channelId)?.reply === reply) transfersInFlight.delete(ctx.channelId);
    };
    if (ok) setTimeout(drop, 60_000).unref?.();
    else drop();
  });
  return reply;
}

/**
 * НОМЕР ОБЪЕКТА ДЛЯ ПЕРЕВОДА.
 *
 * К агенту объекта — только по объекту, о котором в ЭТОМ звонке уже говорили
 * (02.10.2026, то же правило, что у СМС со ссылками). Иначе звонящий, назвав
 * любой номер из каталога («соедините по объекту сто двенадцать»), дозванивался
 * бы до любого агента агентства по выбору.
 *
 * РЕЗЕРВ — ОБЪЕКТ, УЗНАННЫЙ В ЗВОНКЕ (10.10.2026, аудит
 * docs/audit-bots-2026-10-10-object-routing.md, P0-4). Модель вызывает перевод и
 * без номера («соедините с агентом»), хотя объект уже узнан get_property и его
 * агента консультант назвал человеку. Тогда звонок уходил своему агенту клиента
 * или дежурному — не тому, кого обещали. Теперь пустой (или не обсуждавшийся)
 * номер заменяется узнанным объектом звонка; его нет — обычный путь.
 */
export async function transferPropertyNumber(properties: PropertyCallMemory, asked: unknown): Promise<number | null> {
  const n = typeof asked === "number" && asked > 0 ? Math.round(asked) : null;
  if (n !== null && properties.discussedShortIds.includes(n)) return n;
  if (!properties.identifiedPropertyId) return null;
  const identified = await prisma.property.findUnique({
    where: { id: properties.identifiedPropertyId },
    select: { shortId: true },
  });
  return identified?.shortId ?? null;
}

type PickedTransfer = NonNullable<Awaited<ReturnType<typeof pickTransferAgent>>>;

/** Только для тестов: забыть переводы, идущие или недавно удавшиеся. */
export function resetTransfersInFlight(): void {
  transfersInFlight.clear();
}

async function runTransfer(
  ctx: TransferContext,
  agent: PickedTransfer["agent"],
  picked: PickedTransfer,
  firstName: string,
  summary: string
): Promise<LiveVoiceToolReply> {
  // ОТМЕТКА «КОМУ ОТДАЛИ ЗВОНОК» — ДО ПЕРЕВОДА, А НЕ ПОСЛЕ (третий аудит робота
  // 02.10.2026, п.8). transferLiveCallToAgent возвращается только после того, как мост
  // закончил сессию (запись разговора до 20 с, итог в базу до 8 с): отметка, поставленная
  // после, опаздывала на десятки секунд, и агент, ответивший сразу, оставался без
  // засчитанного разговора. Не вышло перевести — отметку снимаем.
  noteConsultantTransfer(ctx.channelId, { id: agent.id, extension: agent.sipExtension });
  let told: Promise<unknown> | undefined;
  const outcome = await transferLiveCallToAgent({
    channel: { kind: "consultant", channelId: ctx.channelId },
    agent,
    clientId: ctx.clientId,
    // Агент слышит приметы объекта, о котором говорили (Dan 24.09.2026).
    propertyId: picked.propertyId,
    ringSeconds: TRANSFER_RING_SECONDS,
    fallback: await transferFallback(ctx.clientId, picked.because),
    requireWorkingHours: false,
    isCancelled: ctx.isCancelled,
    // Лента «консультант соединяет» уходит в момент, когда звонок отдан станции, а не
    // после завершения сессии: иначе она приходила, когда агент уже взял трубку.
    // Запускается сразу, а здесь только присоединяется к концу.
    onMoved: () => {
      told = tellAgent(agent.id, ctx, summary, picked.because).catch((err) =>
        logSystemError("telephony", `Консультант: агенту не ушло уведомление о переводе: ${describeError(err)}`)
      );
    },
  });
  await told;
  if (!outcome.ok) noteConsultantReturned(ctx.channelId);
  // Человек положил трубку, пока соединяли: говорить уже некому.
  if (!outcome.ok && outcome.reason === "gone") return { response: { ok: true }, scheduling: "SILENT" };
  if (!outcome.ok) return fail(refusalForCaller(outcome.reason, firstName));
  return { response: { ok: true, transferred_to: firstName }, scheduling: "SILENT" };
}

/**
 * КУДА ЗВОНОК, ЕСЛИ АГЕНТ НЕ ВЗЯЛ (владелец 11.10.2026: «робот НЕ отвечает клиентам
 * агента — даже если агент не отвечает, он сам перезвонит»).
 *
 * Незакреплённый звонящий (новый, незнакомый, клиент без работающего агента) —
 * назад к консультанту ("ai" → Stasis returned), как с 24.09. Звонящий — клиент
 * работающего агента (или перевод ушёл его агенту) — голосовая почта ("voicemail"):
 * робот его второй раз не берёт, задачу агенту ставит пропущенный звонок. До
 * консультанта такой клиент доходит только сбоем (вердикт CRM не успел к станции) —
 * штатно станция ведёт его агенту мимо робота (inboundRouting.ts).
 */
export async function transferFallback(
  clientId: string | null,
  because: PickedTransfer["because"]
): Promise<RouteFallback> {
  if (because === "client") return "voicemail";
  if (!clientId) return "ai";
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { deletedAt: true, assignedAgent: { select: { isActive: true, frozenAt: true } } },
  });
  const agent = client && !client.deletedAt ? client.assignedAgent : null;
  return agent && agent.isActive && !agent.frozenAt ? "voicemail" : "ai";
}

/** О чём звонок — агенту в ленту CRM, без пуша (см. шапку). */
async function tellAgent(agentId: string, ctx: TransferContext, summary: string, because: "property" | "client" | "duty") {
  const client = ctx.clientId
    ? await prisma.client.findUnique({ where: { id: ctx.clientId }, select: { shortId: true, fullName: true } })
    : null;
  const who = client?.fullName ?? ctx.callerName ?? "Новый звонящий";
  const described = await describeDiscussedProperties(ctx.properties.discussedShortIds);
  const objects = described.length ? ` Обсуждали: ${described.join("; ")}.` : "";
  // Что человек ищет — структурно (save_client_request): агент берёт трубку, уже зная
  // район, бюджет и срок, и не переспрашивает (09.10.2026, тёплая передача).
  const wants = ctx.properties.request ? clientRequestText(ctx.properties.request) : "";
  const conditions = wants ? ` Условия: ${wants}.` : "";
  const why = because === "property" ? "по вашему объекту" : because === "client" ? "ваш клиент" : "просит агента";
  await notifyFeedOnly([agentId], {
    kind: "lead",
    title: `📞 Консультант соединяет: ${who} (${why})`,
    body: `${summary || "Звонящий попросил соединить с агентом."}${conditions}${objects}`,
    url: client ? `/clients/${client.shortId}` : "/calls",
    tag: `live-voice-transfer-${ctx.channelId}`,
  });
}
