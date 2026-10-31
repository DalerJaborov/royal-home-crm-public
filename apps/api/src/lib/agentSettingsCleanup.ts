import { logSystemAudit } from "./audit.js";
import type { Tx } from "./changeClientAgent.js";

/**
 * СОТРУДНИК УШЁЛ — НАСТРОЙКА НЕ ДОЛЖНА УКАЗЫВАТЬ НА НЕГО МОЛЧА (ночная проверка
 * 24.09.2026, М12-в, решение владельца: при увольнении/заморозке снимать
 * сотрудника из этих настроек, а не оставлять ссылку на того, кто больше не
 * работает — до правки комментарий в схеме прямо говорил, что несуществующий/
 * уволенный id это «agent_not_found» в фоновом коде, а не забота настроек).
 *
 * Четыре поля со ссылкой на сотрудника, которых это касается — три из находки
 * М12-в и ещё два той же формы, добавленные разбором класса (25.09.2026,
 * «нашёл баг — ищи весь класс», CLAUDE.md):
 *  - callbackOperatorAgentId — дежурный оператор обратных звонков;
 *  - videoMontajerAgentId — монтажёр;
 *  - incomingDutyAgentIds — дежурные по входящим (список, порядок важен);
 *  - liveVoiceTransferAgentId — консультант на телефоне (робозвонок), кому
 *    переводить звонок без агента объекта и своего агента.
 *
 * Вызывается при переходе isActive true→false (routes/agents.ts,
 * finishAccountDeactivation) и при заморозке (POST /:id/freeze). Пишет в
 * системный журнал, только если правда что-то снял — иначе запись
 * появлялась бы на каждое увольнение, даже когда сотрудник ни в одной из этих
 * настроек не стоял.
 */
export async function clearAgentFromSettingsReferences(
  tx: Tx,
  agentId: string,
  agentName: string,
  reason: "deactivate" | "freeze"
): Promise<void> {
  const settings = await tx.settings.findUnique({
    where: { id: "singleton" },
    select: {
      callbackOperatorAgentId: true,
      videoMontajerAgentId: true,
      incomingDutyAgentIds: true,
      liveVoiceTransferAgentId: true,
    },
  });
  if (!settings) return;

  const data: Record<string, unknown> = {};
  const cleared: string[] = [];
  if (settings.callbackOperatorAgentId === agentId) {
    data.callbackOperatorAgentId = null;
    cleared.push("callbackOperatorAgentId");
  }
  if (settings.videoMontajerAgentId === agentId) {
    data.videoMontajerAgentId = null;
    cleared.push("videoMontajerAgentId");
  }
  if (settings.liveVoiceTransferAgentId === agentId) {
    data.liveVoiceTransferAgentId = null;
    cleared.push("liveVoiceTransferAgentId");
  }
  if (settings.incomingDutyAgentIds.includes(agentId)) {
    data.incomingDutyAgentIds = settings.incomingDutyAgentIds.filter((id) => id !== agentId);
    cleared.push("incomingDutyAgentIds");
  }
  if (cleared.length === 0) return;

  await tx.settings.update({ where: { id: "singleton" }, data });
  logSystemAudit(
    reason === "freeze" ? "AGENT_FROZEN_REMOVED_FROM_SETTINGS" : "AGENT_DEACTIVATED_REMOVED_FROM_SETTINGS",
    "Settings",
    "singleton",
    { agentId, agentName, fields: cleared }
  );
}
