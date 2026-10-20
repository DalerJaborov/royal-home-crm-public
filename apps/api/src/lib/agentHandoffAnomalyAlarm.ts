import { prisma } from "../db.js";
import { sendPushToAgents } from "../push.js";
import { createNotifications } from "./notifications.js";
import { isWithinWorkingHours } from "./workingHours.js";
import { dushanbeStartOfMonth } from "./dushanbeTime.js";

/**
 * СЧЁТЧИК АНОМАЛИЙ «ПЕРЕДАЧА / NO_TRUST» (задача F-2, план вечерней сессии
 * 03-04.09.2026, решение владельца).
 *
 * ПОЧЕМУ ОДИН СЧЁТЧИК НА ДВА ДЕЙСТВИЯ. С 03-04.09.2026 «Передать» (lib/clientTransfer.ts)
 * принимает только причину NO_TRUST («не сложился контакт с агентом», задача F-1),
 * но у агента есть и второй способ сказать то же самое: закрыть карточку через
 * «Завершить сделку → Без сделки» с той же причиной NO_TRUST (REFUSAL_REASONS,
 * routes/clients/lifecycle.ts::refuse). Если считать только «Передачи», агент,
 * который хочет избежать счётчика, просто выберет второй путь — оба технически
 * расстаются с клиентом по одной и той же человеческой причине, и считать их
 * нужно ОДНИМ числом (владелец, дословно из плана: «иначе агент просто выберет
 * необсчитываемый способ»).
 *
 * ЧТО НЕ СЧИТАЕТСЯ. Вынужденные переназначения (заморозка агента, отпуск, ручная
 * правка assignedAgentId руководителем через POST /clients/:id/assign) — эта
 * функция вызывается ТОЛЬКО из двух перечисленных мест (transferClientByAgent и
 * refuse при reason=NO_TRUST), а не из общего пути смены ответственного, поэтому
 * принудительные переносы в счётчик попасть не могут структурно, без отдельной
 * проверки.
 *
 * ПАТТЕРН — тот же, что у buyerNoCallAlarm.ts/sellerNoPropertyAlarm.ts:
 * isWithinWorkingHours (директора не будят ночью — решение владельца «3б»),
 * createNotifications + sendPushToAgents получателям DIRECTOR по роли, дедуп по
 * tag. В отличие от тех двух модулей это НЕ тик крона, а вызов прямо из действия
 * агента — поэтому счётчик (запись в AuditLog) пишется ВСЕГДА, а вот уведомление
 * директору — только если сейчас рабочие часы; ночная передача не потеряется,
 * просто не разбудит директора, а посчитается всё равно.
 *
 * КАЛЕНДАРНЫЙ МЕСЯЦ, а не скользящие 30 дней (в отличие от
 * clientTransfer.ts::noteTransferForQuota, который считает отдельную, более
 * старую квоту передач за 30 дней) — так дословно сформулировал владелец
 * («за календарный месяц»), и это же проще объяснить агенту словами «с начала
 * месяца», а не «за последние 30 дней от сейчас».
 */

const ANOMALY_THRESHOLD = 3;

export type AgentHandoffKind = "TRANSFER_NO_TRUST" | "REFUSE_NO_TRUST";

const AUDIT_ACTIONS: readonly AgentHandoffKind[] = ["TRANSFER_NO_TRUST", "REFUSE_NO_TRUST"];

export async function noteAgentHandoffAndAlarmIfAnomalous(input: {
  agentId: string;
  client: { id: string; shortId: number; fullName: string };
  kind: AgentHandoffKind;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  try {
    const agent = await prisma.agent.findUnique({ where: { id: input.agentId }, select: { fullName: true } });
    await prisma.auditLog.create({
      data: {
        action: input.kind,
        entityType: "Client",
        entityId: input.client.id,
        agentId: input.agentId,
        agentName: agent?.fullName ?? "Неизвестно",
      },
    });

    const monthStart = dushanbeStartOfMonth(now);
    const count = await prisma.auditLog.count({
      where: { agentId: input.agentId, action: { in: [...AUDIT_ACTIONS] }, createdAt: { gte: monthStart } },
    });
    if (count <= ANOMALY_THRESHOLD) return;

    // Директора не будим ночью — решение владельца «3б» (тот же приём, что у
    // buyerNoCallAlarm/sellerNoPropertyAlarm): счётчик уже записан выше и не
    // потеряется, следующий рабочий час догонит его тем же tag.
    if (!(await isWithinWorkingHours(now))) return;

    const directorIds = (
      await prisma.agent.findMany({ where: { role: { in: ["DIRECTOR", "ADMIN", "HEAD_OF_SALES"] }, isActive: true }, select: { id: true } })
    ).map((d) => d.id);
    if (directorIds.length === 0) return;

    // Один tag на агента и месяц — повторные передачи/отказы в том же месяце
    // схлопываются в одну строку ленты (createNotifications::upsertByTag,
    // count++), а не плодят пуш на каждое следующее превышение.
    const monthTag = `${monthStart.getUTCFullYear()}-${monthStart.getUTCMonth() + 1}`;
    const tag = `agent-handoff-anomaly-${input.agentId}-${monthTag}`;
    const payload = {
      kind: "oversight" as const,
      title: `⚠️ ${agent?.fullName ?? "Агент"}: много передач/NO_TRUST за месяц`,
      body: `${count}-й случай с начала месяца («Передать» или закрытие «не сложился контакт») — «${input.client.fullName}». Возможно, стоит поговорить.`,
      url: `/clients/${input.client.shortId}`,
      tag,
    };
    await createNotifications(directorIds, payload);
    void sendPushToAgents(directorIds, payload).catch((err) =>
      console.error("[alarm] agent-handoff-anomaly push:", err)
    );
  } catch (err) {
    // Сигнал руководителю не важнее самого действия агента — не роняем передачу/
    // отказ из-за непрочитанного счётчика (тот же приём, что и в noteTransferForQuota).
    console.error("[alarm] agent-handoff-anomaly:", err instanceof Error ? err.message : err);
  }
}
