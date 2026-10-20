import { prisma } from "../../db.js";
import { logSystemError } from "../systemError.js";
import { describeError } from "../describeError.js";
import { loadAmiCredentials } from "./amiClient.js";
import { loadAriCredentials } from "./ariClient.js";
import { hasLiveCall } from "./callTracker.js";
import { loadIncomingSettings } from "./incomingSettings.js";
// Напрямую из services/leads/selection.js, а не из бочки leads.js — та же
// причина, что у callTracker.ts (01.09.2026, см. комментарий там): бочка тянет
// эту же цепочку телефонии обратно в цикл.
import { pickAgentForLead } from "../../services/leads/selection.js";
import { resolveDialTarget, redirectChannelToAgent, stationHasRouteContext } from "./inboundRouting.js";

/**
 * НЕЗНАКОМЫЙ / БЕСХОЗНЫЙ ЗВОНОК — ЛУЧШЕМУ СВОБОДНОМУ АГЕНТУ ПО KPI (владелец
 * 20.08.2026, режим `Settings.incomingRoutingMode === "kpi_queue"`).
 *
 * До этого режима у такого звонка был ровно один путь — дежурный номер
 * (`incomingForwardPhone`). Один человек на ВЕСЬ поток чужих звонков — узкое
 * место: не отвечает — клиент потерян, свободен — решает то, что мог бы решить
 * агент по своему объекту. Этот режим вместо дежурного пробует дозвониться до
 * лучшего по Royal Score свободного агента — ТЕМ ЖЕ каналом, что и известному
 * клиенту (см. redirectChannelToAgent в inboundRouting.ts, контекст
 * royalhome-agent-route): отличается только то, КАК выбирается агент — не «чей
 * клиент», а «кто сейчас лучший и свободный», алгоритмом обычной раздачи лидов
 * (`pickAgentForLead`, тот же, что у лидов из чата).
 *
 * УЗКО, НАРОЧНО. Вызывается ТОЛЬКО когда `routeIncomingToAssignedAgent` отказал
 * по причине "no_client" или "no_agent" — то есть у звонка ВООБЩЕ нет
 * ответственного (номера нет в базе, либо карточка есть, но без агента:
 * «Прочие», отказ, ещё не распределено). Остальные причины отказа (занят, не в
 * сети, лид не принят, сделка закрыта, несколько карточек) — это не «звонить
 * некому», это «есть история, но прямо сейчас не получилось», и туда звонить
 * должен дежурный, а не случайный ДРУГОЙ агент: то самое соображение, из-за
 * которого владелец 20.08.2026 отменил веерный вызов — агент путает чужого
 * звонящего со своим клиентом. Выбор нового, ещё ничьего человека такой
 * путаницы не создаёт: ему README прежде и не было.
 *
 * КОМУ ДОСТАНЕТСЯ КАРТОЧКА — уже решено остальным конвейером, без правок здесь.
 * `markIncomingBridged` (incomingCalls.ts) узнаёт снявшего трубку по номеру
 * канала для ЛЮБОГО перевода, не только «своему агенту», и `autoLeadFromCall.ts`
 * отдаёт карточку именно ему (`answeredByAgentId`). Кого сюда позвали — тот и
 * получит клиента, если ответит; это тот же путь, а не отдельный.
 */
export type KpiQueueOutcome =
  | { routed: true; agentId: string; extension: string; viaMobile: boolean }
  | {
      routed: false;
      reason:
        | "disabled"
        | "no_slot"
        | "no_extension"
        | "station_not_configured"
        | "agent_offline"
        | "agent_busy"
        | "no_dialplan"
        | "already_answered"
        | "redirect_failed";
    };

export interface KpiQueueRequest {
  channelName: string;
  phone: string;
  recordId?: string;
  isAnswered: () => boolean;
}

export async function routeUnknownCallByKpiQueue(request: KpiQueueRequest): Promise<KpiQueueOutcome> {
  try {
    const outcome = await decide(request);
    await recordDecision(request.recordId, outcome);
    return outcome;
  } catch (err) {
    void logSystemError("telephony", `Маршрутизация незнакомого звонка по очереди KPI сорвалась: ${describeError(err)}`);
    const outcome: KpiQueueOutcome = { routed: false, reason: "redirect_failed" };
    await recordDecision(request.recordId, outcome).catch(() => {});
    return outcome;
  }
}

async function decide(request: KpiQueueRequest): Promise<KpiQueueOutcome> {
  const settings = await loadIncomingSettings();
  if (settings.routingMode !== "kpi_queue") return { routed: false, reason: "disabled" };
  if (!request.channelName || request.isAnswered()) return { routed: false, reason: "already_answered" };

  const agentId = await pickAgentForLead(undefined);
  if (!agentId) return { routed: false, reason: "no_slot" };

  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { sipExtension: true, phone: true } });
  if (!agent?.sipExtension) return { routed: false, reason: "no_extension" };

  const ari = await loadAriCredentials();
  if (!ari) return { routed: false, reason: "station_not_configured" };
  const dial = await resolveDialTarget(ari, agent.sipExtension, agent.phone);
  if (!dial) return { routed: false, reason: "agent_offline" };
  if (hasLiveCall(agentId)) return { routed: false, reason: "agent_busy" };
  if (request.isAnswered()) return { routed: false, reason: "already_answered" };

  // stationHasRouteContext больше не спрятан внутри redirectChannelToAgent (см.
  // 20.08.2026 — станция теперь та же, что и у "подсказки агенту", проверяется
  // один раз вызывающей стороной, как у attemptRoute выше в inboundRouting.ts).
  const creds = await loadAmiCredentials();
  if (!creds) return { routed: false, reason: "station_not_configured" };
  // Этот путь (незнакомый звонок по очереди KPI) без зала ожидания — см. заголовок
  // модуля: осознанный дизайн, а не пропуск. «Станция не ответила» и «контекста
  // честно нет» здесь одинаково означают «не переводим сейчас» (20.09.2026,
  // dialplanContext.ts различает их для ретраев в inboundRouting.ts, здесь
  // ретраев нет — обе причины сводим к одному и тому же исходу).
  const dialplanStatus = await stationHasRouteContext(creds);
  if (!("present" in dialplanStatus) || !dialplanStatus.present) return { routed: false, reason: "no_dialplan" };

  const redirected = await redirectChannelToAgent({
    channelName: request.channelName,
    extension: agent.sipExtension,
    dialTarget: dial.target,
    viaMobile: dial.viaMobile,
    ringSeconds: settings.routeRingSeconds,
    fallback: "queue",
    isAnswered: request.isAnswered,
    logLabel: `незнакомый ${request.phone} по очереди KPI уходит`,
    failLabel: `Незнакомый входящий не переведён по очереди KPI (${agent.sipExtension})`,
  });
  if (!redirected.ok) return { routed: false, reason: redirected.reason };
  return { routed: true, agentId, extension: agent.sipExtension, viaMobile: dial.viaMobile };
}

/** Решение — в тот же журнал входящих, что и у перевода известному агенту: один
 *  источник правды про судьбу звонка, а не два конкурирующих. */
async function recordDecision(recordId: string | undefined, outcome: KpiQueueOutcome): Promise<void> {
  if (!recordId) return;
  // «Режим выключен» ничего не решает, а затирал бы решение другого режима (CHANNEL-NEW-33).
  if (!outcome.routed && outcome.reason === "disabled") return;
  try {
    await prisma.incomingCall.update({
      where: { id: recordId },
      data: {
        // «Ушёл на мобильный» — отдельный код, как и у перевода известному агенту:
        // по нему видно, что у агента не было трубки на связи (платное плечо).
        routeDecision: outcome.routed ? (outcome.viaMobile ? "kpi_routed_mobile" : "kpi_routed") : `kpi_${outcome.reason}`,
        routedToId: outcome.routed ? outcome.agentId : null,
      },
    });
  } catch (err) {
    void logSystemError("telephony", `Решение о маршрутизации по KPI не записано: ${describeError(err)}`);
  }
}
