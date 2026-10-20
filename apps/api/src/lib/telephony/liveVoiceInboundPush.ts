import { prisma } from "../../db.js";
import { sendPushToAgents } from "../../push.js";
import { partitionByPermission } from "../recipients.js";
import { logSystemError } from "../systemError.js";

/**
 * ПУШ «РОБОТ ВЗЯЛ ВХОДЯЩИЙ ЗВОНОК» (09.10.2026).
 *
 * Руководство (директор и администратор) получает уведомление в момент, когда
 * робот-консультант ответил клиенту, и может сразу открыть «Звонки» → «Слушать».
 *
 * Правила:
 *  - получатели — только DIRECTOR и ADMIN, и только те, у кого есть право слушать
 *    разговоры (calls.hearRecording): ссылка в уведомлении ведёт на прослушку;
 *  - один пуш на разговор (дедупликация по id сессии) — повторный вызов для
 *    того же разговора ничего не отправляет;
 *  - НИКОГДА не бросает: отказ пуша или базы пишется в журнал и больше никуда не
 *    идёт — звонок от него не зависит. Вызывать как `void notify...()`.
 *  - номер клиента маскирует сам sendPushToAgents по праву clients.viewPhone
 *    каждого получателя.
 */

/** Сколько последних разговоров помним для дедупликации (одного звонка хватает на минуты). */
const REMEMBER_LAST = 500;
const notified = new Set<string>();

export async function notifyRobotTookInboundCall(params: {
  /** id строки LiveVoiceSession (session.dbId) — ключ дедупликации. */
  key: string;
  callerNumber: string | null;
}): Promise<void> {
  try {
    if (notified.has(params.key)) return;
    notified.add(params.key);
    if (notified.size > REMEMBER_LAST) {
      const oldest = notified.values().next().value;
      if (oldest !== undefined) notified.delete(oldest);
    }

    const leaders = await prisma.agent.findMany({
      where: { isActive: true, role: { in: ["DIRECTOR", "ADMIN"] } },
      select: { id: true },
    });
    const { granted } = await partitionByPermission(
      leaders.map((a) => a.id),
      "calls.hearRecording"
    );
    if (granted.length === 0) return;

    await sendPushToAgents(granted, {
      kind: "oversight",
      title: "Робот взял входящий звонок",
      body: params.callerNumber ? `Звонит ${params.callerNumber}. Можно послушать.` : "Можно послушать разговор.",
      url: "/calls",
      tag: `live-voice-listen-${params.key}`,
    });
  } catch (err) {
    void logSystemError(
      "telephony",
      `Живой голос: уведомление «робот взял звонок» не отправлено: ${err instanceof Error ? err.message : String(err)}`,
      { dedupKey: "live-voice-inbound-push-failed" }
    );
  }
}

/** Только для тестов. */
export function resetInboundPushMemoryForTests(): void {
  notified.clear();
}
