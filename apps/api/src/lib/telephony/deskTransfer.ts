import { prisma } from "../../db.js";
import { changeClientAgent } from "../changeClientAgent.js";
import { describeError } from "../describeError.js";
import { logSystemError } from "../systemError.js";
import { logTimeline, type TimelineActor } from "../timeline.js";
import { continueInDialplan, hangupCall, loadAriCredentials, readChannelVariable } from "./ariClient.js";
import type { AriEvent } from "./ariTypes.js";
import { liveIncomingForTransfer } from "./incomingCalls.js";
import { pickTransferAgent, transferLiveCallToAgent, type TransferRefusal } from "./liveCallTransfer.js";
import { PROPERTY_WHISPER_SELECT, propertyFeaturesText } from "./propertyWhisper.js";

/**
 * ПЕРЕВОД ЗВОНКА АГЕНТУ ОБЪЕКТА С ОФИСНОГО ТЕЛЕФОНА (24.09.2026, решение Dan).
 *
 * Кнопки в CRM нет и не будет (Dan 08:57): оператор говорит с клиентом по
 * кнопочному IP-телефону и, поняв, о каком объекте речь, нажимает «Перевод» и
 * набирает 7 и номер объекта (7132 — объект 132). Станция (from-internal-custom,
 * ops/asterisk/extensions_custom.conf) отдаёт канал звонящего сюда, в
 * Stasis-приложение CRM, с номером объекта в аргументах, а CRM:
 *  1. находит агента, который ведёт объект (pickTransferAgent — тот же выбор, что
 *     у консультанта и у раздачи лидов по объекту);
 *  2. звонит ему тем же путём royalhome-agent-route, что и перевод своему клиенту:
 *     перед соединением агент слышит ПРИМЕТЫ объекта (propertyWhisper.ts), а не
 *     номер — «агент номер не помнит» (Dan 08:59);
 *  3. пишет в карточку клиента, кому и по какому объекту перевели;
 *  4. агент взял трубку — клиент закрепляется за ним сразу принятым, «не как новый
 *     лид» (Dan 08:57). Пуша агенту нет — «меньше пуша» (Dan 09:00).
 * Не вышло (номер набран с ошибкой, у объекта нет агента, агент занят или не
 * взял) — звонок возвращается в очередь операторов, и в карточке остаётся почему.
 *
 * Автоматический путь не тронут: звонок, который оператор не переводил, после
 * разговора разбирает ИИ и отдаёт агенту объекта (autoLeadFromCall.ts).
 */

/** Первый аргумент Stasis(royal-home-crm,desk-transfer,<номер объекта>). */
export const DESK_TRANSFER_ARG = "desk-transfer";

/** Сколько звонить агенту. Клиент уже поговорил с оператором и ждёт живого ответа —
 *  тот же срок, что у перевода консультантом. Не взял — назад в очередь. */
export const DESK_TRANSFER_RING_SECONDS = 30;

/** Переводы, которые ждут ответа агента: по id канала в Stasis — кто, куда, по чему. */
interface PendingTransfer {
  recordId: string | null;
  clientId: string | null;
  agentId: string;
  agentName: string;
  propertyId: string;
  shortId: number;
  at: number;
}
const pending = new Map<string, PendingTransfer>();
/** Дольше звонок агенту не идёт: запись, не дождавшаяся исхода, уже ничья. */
const PENDING_TTL_MS = 10 * 60_000;

function sweepPending(now: number): void {
  for (const [id, p] of pending) if (now - p.at > PENDING_TTL_MS) pending.delete(id);
}

function stasisArgs(event: AriEvent): string[] {
  return Array.isArray(event.args) ? event.args.map((a) => String(a)) : [];
}

/** Это канал, который станция отдала на перевод по объекту. */
export function isDeskTransferStart(event: AriEvent): boolean {
  return event.type === "StasisStart" && stasisArgs(event)[0] === DESK_TRANSFER_ARG;
}

/** Код после «7» — номер объекта. Всё, что не число, — ошибка набора. */
function parseShortId(raw: string | undefined): number | null {
  if (!raw || !/^\d{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

/** Почему не вышло — словами для карточки клиента. */
function refusalText(reason: TransferRefusal | "no_property", agentName: string | null): string {
  const who = agentName ?? "агент";
  switch (reason) {
    case "no_property":
      return "объекта с таким номером нет в продаже или у него нет агента";
    case "busy":
      return `${who} сейчас на другом звонке`;
    case "offline":
      return `${who} не на связи`;
    case "no_phone":
      return `у агента ${who} нет рабочего телефона в CRM`;
    case "no_station":
    case "no_dialplan":
      return "станция не настроена для перевода";
    default:
      return "станция не приняла перевод";
  }
}

async function operatorActor(answeredBy: string | null, agentId: string | null): Promise<TimelineActor> {
  const operator = answeredBy
    ? await prisma.agent.findFirst({ where: { sipExtension: answeredBy }, select: { id: true } })
    : null;
  return operator
    ? { kind: "agent", agentId: operator.id }
    : { kind: "system", source: "desk-transfer", subjectAgentId: agentId };
}

/**
 * Станция отдала канал на перевод. Наружу не бросает: это обработчик события АТС,
 * и канал, застрявший в Stasis без ответа, — тишина в трубке у клиента.
 */
export async function handleDeskTransferStart(event: AriEvent): Promise<void> {
  const channel = event.channel;
  if (!channel) return;
  const ari = await loadAriCredentials();
  if (!ari) return;
  sweepPending(Date.now());

  const shortId = parseShortId(stasisArgs(event)[1]);
  let call: Awaited<ReturnType<typeof liveIncomingForTransfer>> = null;

  /** Назад на станцию: следующая строка диалплана — очередь операторов. Звонка из
   *  журнала не нашли — значит перевели не клиента (оператор набрал код со своей
   *  трубки): класть его в свою же очередь незачем, отбой. */
  const giveBack = async () => {
    const back = call ? await continueInDialplan(ari, channel.id) : await hangupCall(ari, channel.id);
    if (!back.ok) void logSystemError("telephony", `Перевод по объекту: канал не вернулся на станцию: ${back.error ?? ""}`, { dedupKey: "Перевод по объекту: канал не вернулся на станцию: …" });
  };

  try {
    // ARI отдаёт linkedid полем канала не на всех сборках — тогда спрашиваем станцию.
    const own = (channel as { linkedid?: unknown }).linkedid;
    const linked =
      typeof own === "string" && own
        ? own
        : await readChannelVariable(ari, channel.id, "CHANNEL(linkedid)").catch(() => null);
    call = await liveIncomingForTransfer([channel.id, linked], channel.caller?.number);

    const picked = shortId ? await pickTransferAgent({ clientId: call?.clientId ?? null }, shortId) : null;
    // Только агент ОБЪЕКТА: оператор набрал номер объекта, и отдать звонок «своему
    // агенту клиента» или дежурному вместо него — не то, о чём он просил.
    if (!picked || picked.because !== "property" || !picked.propertyId) {
      await noteOnCard(call, `Оператор переводил звонок по объекту №${stasisArgs(event)[1] ?? "?"} — не вышло: ${refusalText("no_property", null)}. Звонок вернулся в очередь операторов`);
      await giveBack();
      return;
    }
    const { agent, propertyId } = picked;
    // ЗАПИСЬ О ПЕРЕВОДЕ — ДО ТОГО, КАК КАНАЛ УШЁЛ В ДИАЛПЛАН (CHANNEL-NEW-30, 04.10.2026).
    // Dial ANSWER приходит по ARI WebSocket параллельно с HTTP-ответом на continue и
    // может опередить его (автоответ мобильного): без записи noteDeskTransferDial
    // возвращал false, а повторного ANSWER не будет — закрепление клиента за ответившим
    // терялось. Не вышло перевести — запись снимается ниже.
    pending.set(channel.id, {
      recordId: call?.recordId ?? null,
      clientId: call?.clientId ?? null,
      agentId: agent.id,
      agentName: agent.fullName,
      propertyId,
      shortId: shortId!,
      at: Date.now(),
    });
    let outcome: Awaited<ReturnType<typeof transferLiveCallToAgent>>;
    try {
      outcome = await transferLiveCallToAgent({
        channel: { kind: "stasis", channelId: channel.id },
        agent,
        clientId: call?.clientId ?? null,
        propertyId,
        ringSeconds: DESK_TRANSFER_RING_SECONDS,
        fallback: call ? "queue" : "hangup",
        // Оператор в офисе и сам решает, звонить ли агенту вечером.
        requireWorkingHours: false,
      });
    } catch (err) {
      pending.delete(channel.id);
      throw err;
    }
    if (!outcome.ok) {
      pending.delete(channel.id);
      if (outcome.reason === "failed" || outcome.reason === "no_dialplan" || outcome.reason === "no_station") {
        void logSystemError("telephony", `Перевод по объекту №${shortId} агенту ${agent.fullName} не удался: ${outcome.reason}`, { dedupKey: "Перевод по объекту №… агенту … не удался: …" });
      }
      await noteOnCard(call, `Оператор переводил звонок агенту ${agent.fullName} по объекту №${shortId} — не вышло: ${refusalText(outcome.reason, agent.fullName)}. Звонок вернулся в очередь операторов`, propertyId);
      await giveBack();
      return;
    }

    if (call?.recordId) {
      // Ответ агента мог прийти раньше этой записи (см. выше) — «ответил» не затираем.
      await prisma.incomingCall
        .updateMany({
          where: { id: call.recordId, OR: [{ routeDecision: null }, { routeDecision: { not: "desk_transfer_answered" } }] },
          data: { routeDecision: "desk_transfer", routedToId: agent.id },
        })
        .catch((err) => logSystemError("telephony", `Перевод по объекту не записан в журнал входящих: ${describeError(err)}`, { dedupKey: "Перевод по объекту не записан в журнал входящих: …" }));
    }
    if (call?.clientId) {
      const property = await prisma.property.findUnique({ where: { id: propertyId }, select: PROPERTY_WHISPER_SELECT });
      const features = property ? propertyFeaturesText(property) : "";
      await logTimeline({
        clientId: call.clientId,
        actor: await operatorActor(call.answeredBy, agent.id),
        type: "SYSTEM",
        notes: `Оператор перевёл звонок агенту ${agent.fullName} по объекту${features ? `: ${features}` : ""} (№${shortId})`,
        propertyId,
      });
    }
  } catch (err) {
    void logSystemError("telephony", `Перевод по объекту с офисного телефона сорвался: ${describeError(err)}`, { dedupKey: "Перевод по объекту с офисного телефона сорвался: …" });
    await giveBack().catch(() => undefined);
  }
}

/** Запись в карточке клиента о переводе, который не состоялся. Карточки нет — молча. */
async function noteOnCard(
  call: { clientId: string | null; answeredBy: string | null } | null,
  notes: string,
  propertyId?: string
): Promise<void> {
  if (!call?.clientId) return;
  await logTimeline({
    clientId: call.clientId,
    actor: await operatorActor(call.answeredBy, null),
    type: "SYSTEM",
    notes,
    propertyId: propertyId ?? null,
  }).catch((err) => logSystemError("telephony", `Запись о переводе по объекту не легла в карточку: ${describeError(err)}`, { dedupKey: "Запись о переводе по объекту не легла в карточку: …" }));
}

/** Исходы набора, после которых звонок агенту закончился. Промежуточные (RINGING,
 *  PROGRESS) приходят тем же событием и ничего не решают. */
const FINAL_DIAL = new Set(["ANSWER", "NOANSWER", "BUSY", "CONGESTION", "CHANUNAVAIL", "CANCEL"]);

/**
 * Исход звонка агенту — по событию Dial станции, где звонящий (наш канал) — caller.
 * true — событие наше и разобрано. Набор очереди (агент не взял, звонок вернулся к
 * операторам) тоже шлёт Dial с тем же caller: его узнаём по каналу `@from-queue` и
 * не путаем с ответом агента.
 */
export async function noteDeskTransferDial(event: AriEvent): Promise<boolean> {
  if (event.type !== "Dial") return false;
  const callerId = event.caller?.id;
  const p = callerId ? pending.get(callerId) : undefined;
  if (!callerId || !p) return false;
  const status = event.dialstatus ?? "";
  if (!FINAL_DIAL.has(status)) return true;
  pending.delete(callerId);
  if ((event.peer?.name ?? "").includes("@from-queue")) return true;
  try {
    if (status === "ANSWER") await onAnswered(p);
    else await onMissed(p, status);
  } catch (err) {
    void logSystemError("telephony", `Исход перевода по объекту №${p.shortId} не записан: ${describeError(err)}`, { dedupKey: "Исход перевода по объекту №… не записан: …" });
  }
  return true;
}

async function onAnswered(p: PendingTransfer): Promise<void> {
  if (p.recordId) {
    await prisma.incomingCall.update({ where: { id: p.recordId }, data: { routeDecision: "desk_transfer_answered" } });
  }
  if (!p.clientId) return;
  /**
   * Агент поговорил с клиентом — клиент его, сразу принятый: без окна «Принять» и
   * без таймера, как у агента, снявшего трубку сам (qualifyIncoming.ts). Чужого
   * клиента не забираем: условие «без агента» прямо в запросе — клиент, которого
   * уже ведёт другой агент, остаётся у него (то же правило, что у повторного звонка).
   */
  const now = new Date();
  const claimed = await changeClientAgent({
    clientId: p.clientId,
    toAgentId: p.agentId,
    reason: `Оператор перевёл звонок по объекту №${p.shortId}, агент взял трубку`,
    source: "desk-transfer",
    guardWhere: { assignedAgentId: null },
    data: {
      assignedAt: now,
      acceptedAt: now,
      workStatus: "ACTIVE",
      assignReason: "own_property_explicit",
      lastContactAt: now,
    },
  });
  if (!claimed.ok) {
    const client = await prisma.client.findUnique({
      where: { id: p.clientId },
      select: { assignedAgentId: true, assignedAgent: { select: { fullName: true } } },
    });
    if (client?.assignedAgentId && client.assignedAgentId !== p.agentId) {
      await logTimeline({
        clientId: p.clientId,
        actor: { kind: "system", source: "desk-transfer", subjectAgentId: client.assignedAgentId },
        type: "SYSTEM",
        notes: `${p.agentName} поговорил с клиентом по объекту №${p.shortId}; клиент остаётся у своего агента ${client.assignedAgent?.fullName ?? ""}`.trim(),
        propertyId: p.propertyId,
      });
    }
  }
}

async function onMissed(p: PendingTransfer, status: string): Promise<void> {
  if (p.recordId) {
    await prisma.incomingCall.update({ where: { id: p.recordId }, data: { routeDecision: "desk_transfer_missed" } });
  }
  if (!p.clientId) return;
  const why = status === "CANCEL" ? "клиент положил трубку, пока звонили агенту" : `${p.agentName} не взял трубку — звонок вернулся в очередь операторов`;
  await logTimeline({
    clientId: p.clientId,
    actor: { kind: "system", source: "desk-transfer", subjectAgentId: p.agentId },
    type: "SYSTEM",
    notes: `Перевод по объекту №${p.shortId}: ${why}`,
    propertyId: p.propertyId,
  });
}

/** Только для тестов. */
export function resetDeskTransfers(): void {
  pending.clear();
}
