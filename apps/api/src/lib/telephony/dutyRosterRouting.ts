import { prisma } from "../../db.js";
import { logSystemError } from "../systemError.js";
import { describeError } from "../describeError.js";
import { dushanbeStartOfToday } from "../dushanbeTime.js";
import { loadAmiCredentials } from "./amiClient.js";
import { loadAriCredentials } from "./ariClient.js";
import { hasLiveCall } from "./callTracker.js";
import { loadIncomingSettings } from "./incomingSettings.js";
import { resolveDialTarget, redirectChannelToAgent, stationHasRouteContext } from "./inboundRouting.js";

/**
 * НЕЗНАКОМЫЙ / БЕСХОЗНЫЙ ЗВОНОК — ДЕЖУРНОМУ ПО ОЧЕРЕДИ (владелец 20.08.2026,
 * режим `Settings.incomingRoutingMode === "dedicated_operator"`).
 *
 * ЛЁГКАЯ ВЕРСИЯ, А НЕ ВОЗВРАТ УДАЛЁННОЙ РОЛИ. 18.08.2026 роль оператора убрали
 * целиком: рабочее место, окно разбора звонка, отдельные права «кто принимает
 * входящие», браузерную трубку (−3353 строки). Полное возвращение — отдельная
 * большая задача (владелец явно спросил именно облегчённый вариант 20.08.2026).
 * Здесь НЕТ ничего из удалённого: просто список сотрудников в Настройках
 * (`Settings.incomingDutyAgentIds`), и звонок идёт по нему тем же переводом, что
 * известному клиенту и очереди по KPI (redirectChannelToAgent, контекст
 * royalhome-agent-route) — новой станционной работы это тоже не требует.
 *
 * КТО ДЕЖУРИТ СЕГОДНЯ — ПО КАЛЕНДАРНОМУ ДНЮ, БЕЗ ОТДЕЛЬНОГО КУРСОРА. Номер дня
 * по Душанбе (`dushanbeStartOfToday`) по модулю длины списка: детерминировано,
 * не требует хранить «чья была очередь вчера» и не зависит от того, сколько
 * звонков случилось, — в отличие от очереди по KPI, где дежурство МЕНЯЕТСЯ не
 * от числа звонков, а само по себе, по календарю.
 *
 * СРАБАТЫВАЕТ ТОЛЬКО когда `routeIncomingToAssignedAgent` отказал по причине
 * "no_client" или "no_agent" — та же граница, что и у kpiQueueRouting.ts, и по
 * той же причине: у звонка есть история — дежурный не подходит, там нужен
 * дежурный (сейчас — incomingForwardPhone), не гадание по расписанию.
 */
export type DutyRosterOutcome =
  | { routed: true; agentId: string; extension: string; viaMobile: boolean }
  | {
      routed: false;
      reason:
        | "disabled"
        | "no_roster"
        | "agent_not_found"
        | "no_extension"
        | "station_not_configured"
        | "agent_offline"
        | "agent_busy"
        | "no_dialplan"
        | "already_answered"
        | "redirect_failed";
    };

export interface DutyRosterRequest {
  channelName: string;
  phone: string;
  recordId?: string;
  isAnswered: () => boolean;
}

export async function routeUnknownCallByDutyRoster(request: DutyRosterRequest): Promise<DutyRosterOutcome> {
  try {
    const outcome = await decide(request);
    await recordDecision(request.recordId, outcome);
    return outcome;
  } catch (err) {
    void logSystemError("telephony", `Маршрутизация незнакомого звонка на дежурного сорвалась: ${describeError(err)}`);
    const outcome: DutyRosterOutcome = { routed: false, reason: "redirect_failed" };
    await recordDecision(request.recordId, outcome).catch(() => {});
    return outcome;
  }
}

async function decide(request: DutyRosterRequest): Promise<DutyRosterOutcome> {
  const settings = await loadIncomingSettings();
  if (settings.routingMode !== "dedicated_operator") return { routed: false, reason: "disabled" };
  if (!request.channelName || request.isAnswered()) return { routed: false, reason: "already_answered" };
  if (settings.dutyAgentIds.length === 0) return { routed: false, reason: "no_roster" };

  const dayIndex = Math.floor(dushanbeStartOfToday().getTime() / 86_400_000);
  const agentId = settings.dutyAgentIds[dayIndex % settings.dutyAgentIds.length];

  const agent = await prisma.agent.findFirst({
    where: { id: agentId, isActive: true },
    select: { id: true, sipExtension: true, phone: true },
  });
  // Уволен/отключён, а из списка дежурных его не убрали — не гадаем следующим по
  // очереди (тот не в курсе, что сегодня его смена): звонок остаётся на дежурном
  // номере, как раньше, и это видно в журнале, а не тихо подменяется.
  if (!agent) return { routed: false, reason: "agent_not_found" };
  if (!agent.sipExtension) return { routed: false, reason: "no_extension" };

  const ari = await loadAriCredentials();
  if (!ari) return { routed: false, reason: "station_not_configured" };
  const dial = await resolveDialTarget(ari, agent.sipExtension, agent.phone);
  if (!dial) return { routed: false, reason: "agent_offline" };
  if (hasLiveCall(agent.id)) return { routed: false, reason: "agent_busy" };
  if (request.isAnswered()) return { routed: false, reason: "already_answered" };

  // stationHasRouteContext больше не спрятан внутри redirectChannelToAgent (см.
  // 20.08.2026 — станция теперь та же, что и у "подсказки агенту", проверяется
  // один раз вызывающей стороной, как у attemptRoute выше в inboundRouting.ts).
  const creds = await loadAmiCredentials();
  if (!creds) return { routed: false, reason: "station_not_configured" };
  // Этот путь (незнакомый звонок дежурному) без зала ожидания — см. заголовок
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
    logLabel: `незнакомый ${request.phone} уходит дежурному`,
    failLabel: `Незнакомый входящий не переведён на дежурного (${agent.sipExtension})`,
  });
  if (!redirected.ok) return { routed: false, reason: redirected.reason };
  return { routed: true, agentId: agent.id, extension: agent.sipExtension, viaMobile: dial.viaMobile };
}

/** Тот же журнал входящих, что и у остальных путей перевода — префикс "duty_"
 *  отличает исход в общем списке решений от "kpi_"/обычного. */
async function recordDecision(recordId: string | undefined, outcome: DutyRosterOutcome): Promise<void> {
  if (!recordId) return;
  // «Режим выключен» ничего не решает, а до этой правки затирал успешный перевод другого
  // режима (incomingCalls вызывает обе функции подряд, CHANNEL-NEW-33, 04.10.2026).
  if (!outcome.routed && outcome.reason === "disabled") return;
  try {
    await prisma.incomingCall.update({
      where: { id: recordId },
      data: {
        routeDecision: outcome.routed ? (outcome.viaMobile ? "duty_routed_mobile" : "duty_routed") : `duty_${outcome.reason}`,
        routedToId: outcome.routed ? outcome.agentId : null,
      },
    });
  } catch (err) {
    void logSystemError("telephony", `Решение о переводе на дежурного не записано: ${describeError(err)}`);
  }
}
