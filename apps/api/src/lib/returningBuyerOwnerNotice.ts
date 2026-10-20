import { formatClientCode } from "@royal-home/shared";
import { prisma } from "../db.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";

/**
 * ПОКУПАТЕЛЬ ВЕРНУЛСЯ, А ЕГО АГЕНТ НА БОЛЬНИЧНОМ (владелец 16.09.2026).
 *
 * Дословное правило: карточка «никуда не уходит», но владельцу приходит уведомление.
 * До 16.09 система в этом случае решала сама — отдавала покупателя в очередь, если
 * разговора с агентом ни разу не было. Теперь передача принадлежит владельцу и
 * только ему, а задача системы — чтобы он об этом случае УЗНАЛ: человек ждёт,
 * агент болеет, и без строки в ленте это осталось бы тихим.
 *
 * Отдельным модулем, а не строкой внутри приёма заявки: приём лида не должен
 * знать, как устроена очередь алармов, и не должен ничего ждать (вызов
 * fire-and-forget). Best-effort по контракту: клиент уже принят, и уведомление не
 * имеет права сорвать приём.
 */
export async function notifyOwnerReturningBuyerSickAgent(clientId: string, agentId: string): Promise<void> {
  const [client, agent] = await Promise.all([
    prisma.client.findFirst({
      where: { id: clientId, deletedAt: null },
      select: { shortId: true, fullName: true, kind: true },
    }),
    prisma.agent.findUnique({ where: { id: agentId }, select: { fullName: true } }),
  ]);
  if (!client) return;

  await enqueueDirectorAlert({
    // «Нет на месте», а не «на больничном»: с 23.09.2026 так же остаётся и
    // покупатель агента в отпуске (lib/returningClientRouting.ts).
    title: "Покупатель вернулся, а его агента нет на месте",
    body:
      `${formatClientCode(client.shortId, client.kind)} ${client.fullName} написал сам. ` +
      `Карточка осталась за агентом${agent?.fullName ? ` (${agent.fullName})` : ""} — передать её может только руководитель.`,
    url: `/clients/${client.shortId}`,
    // Ждёт решения: система сознательно ничего не сделала и передаёт выбор человеку.
    level: "APPROVAL",
    tag: `returning-buyer-sick-agent-${clientId}`,
    recipientPermission: "clients.assign",
  });
}
