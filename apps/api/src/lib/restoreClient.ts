import { SALES_AGENT_ROLES } from "@royal-home/shared";
import { prisma } from "../db.js";
import { changeClientAgent } from "./changeClientAgent.js";
import { findPhoneOwners } from "./clientPhones.js";
import { publishClientUpdated } from "./livePublish.js";
import { findAgentsWithPermission } from "./recipients.js";
import { sendPushToAgents } from "../push.js";

/**
 * ВОССТАНОВЛЕНИЕ КЛИЕНТА ИЗ КОРЗИНЫ — ОДНА ФУНКЦИЯ НА ВСЕ ВХОДЫ (15.11.2026).
 *
 * Тело вынесено из POST /clients/:id/restore (routes/clients/card.ts) без изменения поведения:
 * вторым входом стала кнопка «Восстановить» под сообщением Шабнам руководству об удалении
 * (telegram/trashRestoreNotice.ts) — второй копии правил (проверка агента, очередь раздачи,
 * пуш руководству) быть не должно. Право (`clients.delete`) проверяет вызывающий, запись в журнал
 * (нужен req) — тоже у него.
 */
export type RestoreClientResult =
  | {
      ok: true;
      client: { id: string; shortId: number; fullName: string; phone: string };
      ownerReassignedToQueue: boolean;
    }
  | { ok: false; status: 404 | 409; error: string; duplicateOf?: { id: string; shortId: number } };

/**
 * Восстановление клиента из Корзины — право `clients.delete` (директор, админ).
 *
 * ПРОВЕРКА АГЕНТА (аудит владения 11.09.2026, дыра №3, `docs/ownership-audit-11-09.md`):
 * карточка могла пролежать в Корзине неделями, а агент за это время уволиться —
 * `restore` без проверки оживил бы клиента на уволенном (isActive=false), который
 * его физически не увидит. По явному уточнению П8 от 25.10.2026 восстановление
 * исключает также любую заморозку; действующий портфель вне восстановления
 * это правило не перераспределяет.
 */
export async function restoreClientFromTrash(clientId: string, actorId: string): Promise<RestoreClientResult> {
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client || !client.deletedAt) return { ok: false, status: 404, error: "Клиент не найден в корзине" };

  const eligible = (agent: { isActive: boolean; frozenAt: Date | null; role: string } | null | undefined) =>
    !!agent?.isActive && agent.frozenAt === null && (SALES_AGENT_ROLES as readonly string[]).includes(agent.role);
  const owner = client.assignedAgentId
    ? await prisma.agent.findUnique({ where: { id: client.assignedAgentId }, select: { isActive: true, frozenAt: true, role: true } })
    : null;
  const historicalOwner = !eligible(owner) && client.lastAgentId && !client.assignmentRefusedAt && !client.assignmentCompletedAt
    ? await prisma.agent.findUnique({ where: { id: client.lastAgentId }, select: { id: true, isActive: true, frozenAt: true, role: true } }) : null;
  const restoredAgentId = client.kind !== "OTHER" && eligible(historicalOwner) ? historicalOwner!.id : null;
  const completedAssignment = Boolean(client.assignmentRefusedAt || client.assignmentCompletedAt);
  const ownerGone = !completedAssignment && client.assignedAgentId != null && !eligible(owner);
  /**
   * КАРТОЧКА БЕЗ АГЕНТА ПОСЛЕ ВОССТАНОВЛЕНИЯ — В РАЗДАЧУ, И РУКОВОДСТВО ЗНАЕТ
   * (23.09.2026, проверка раздачи, пункты 20 и 24). Раньше при уволенном агенте
   * ставился escalatedAt без агента: утренняя волна такие карточки пропускает,
   * напоминаний нет, в счётчиках её нет, пуша не было — карточка пропадала из
   * виду. Карточка, лежавшая в Корзине вовсе без агента, тоже восстанавливалась
   * молча, а в режиме «Вручную» о ней не узнавал никто. Теперь карточка для
   * агентов (не «Прочее») встаёт в очередь как новый лид: волна отдаст её
   * агенту, и тот примет её сам. Руководство получает пуш «назначьте агента».
   */
  const endsWithoutAgent = !restoredAgentId && (ownerGone || client.assignedAgentId == null);
  const toQueue = !completedAssignment && endsWithoutAgent && client.kind !== "OTHER";
  const queueData = toQueue
    ? { escalatedAt: null, acceptedAt: null, assignedAt: new Date(), triedAgentIds: [], reassignCount: 0 }
    : {};

  const restoreConflict = new Error("Restore conflict");
  let duplicateOf: { id: string; shortId: number } | null = null;
  const restored = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${client.id} FOR UPDATE`;
    const current = await tx.client.findUnique({ where: { id: client.id } });
    if (!current?.deletedAt || current.updatedAt.getTime() !== client.updatedAt.getTime()) {
      return false;
    }
    /**
     * ВОССТАНОВЛЕНИЕ НЕ ДЕЛАЕТ ВТОРУЮ ЖИВУЮ КАРТОЧКУ ТОГО ЖЕ ЧЕЛОВЕКА (CRM-38, 26.11.2026).
     *
     * Пока карточка лежала в Корзине, человек мог написать снова: бот завёл новую заявку, или слияние
     * дублей перенесло номер живой карточке запасным. Кнопка «Восстановить» оживляла старую оболочку
     * рядом: два агента звонят одному клиенту, переписка и сделки расходятся. Номер — один хозяин
     * (lib/clientPhones.ts): если живая карточка уже держит любой из номеров этой (главный, WhatsApp,
     * запасной), восстановление отказывает и называет её. Проверка внутри транзакции, под блокировкой
     * восстанавливаемой строки.
     */
    const phones = [current.phone, current.whatsappPhone, ...(current.extraPhones ?? [])].filter((p): p is string => !!p);
    const [live] = await findPhoneOwners(phones, { exceptClientId: client.id, limit: 1, db: tx });
    if (live) {
      duplicateOf = { id: live.id, shortId: live.shortId };
      return false;
    }
    const checkedOwners = [[client.assignedAgentId, eligible(owner)], [historicalOwner?.id ?? null, eligible(historicalOwner)]] as const;
    // Не назначать сотрудника, которого заморозили/уволили между выбором и записью.
    // FOR SHARE удерживает eligibility до коммита; одинаковый порядок исключает
    // взаимную блокировку двух восстановлений с обратной парой владельцев.
    for (const [id, expected] of [...checkedOwners].sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""))) {
      if (id && !completedAssignment) {
        await tx.$queryRaw`SELECT id FROM "Agent" WHERE id = ${id} FOR SHARE`;
        const agent = await tx.agent.findUnique({ where: { id }, select: { isActive: true, frozenAt: true, role: true } });
        if (eligible(agent) !== expected) return false;
      }
    }
    // Часы ночного переноса в Корзину — заново с момента восстановления
    // (23.09.2026). Карточку, которую перенос убрал сам (Потерянный/Неактивный
    // старше срока), он в ту же ночь уносил обратно: lostAt
    // оставались прежними. Статус не трогаем — это решение человека, а не кнопки.
    const now = new Date();
    await tx.client.update({
      where: { id: client.id },
      data: {
        deletedAt: null,
        deletedById: null,
        ...(ownerGone ? {} : queueData),
        ...(client.status === "LOST" ? { lostAt: now } : {}),
      },
    });
    if (ownerGone || restoredAgentId) {
      const changed = await changeClientAgent({
        clientId: client.id,
        toAgentId: restoredAgentId,
        reason: restoredAgentId ? "Восстановление из Корзины: возвращена прежнему активному агенту" : "Восстановление из Корзины: агент карточки недоступен — карточка в очереди раздачи",
        actorId: actorId,
        source: "restore",
        data: restoredAgentId ? { assignedAt: now, acceptedAt: null, escalatedAt: null } : toQueue ? queueData : { escalatedAt: new Date() },
        tx,
      });
      if (!changed.ok) throw restoreConflict;
    }
    return true;
  }).catch(error => { if (error === restoreConflict) return false; throw error; });
  if (duplicateOf) {
    const dup: { id: string; shortId: number } = duplicateOf;
    return { ok: false, status: 409, duplicateOf: dup,
      error: `Номер этого клиента уже у живой карточки №${dup.shortId}. Работайте в ней или объедините карточки` };
  }
  if (!restored) return { ok: false, status: 409, error: "Карточка изменилась. Обновите страницу" };
  if (toQueue) {
    const supervisors = (await findAgentsWithPermission("clients.assign")).filter((id) => id !== actorId);
    sendPushToAgents(supervisors, {
      title: "♻️ Карточка восстановлена без агента",
      body: `${client.fullName} — вернулась из Корзины, агента у неё нет. Раздача отдаст её сама, либо назначьте вручную`,
      url: `/clients/${client.shortId}`,
      tag: `restore-no-agent-${client.id}`,
    }).catch((err) => console.error("[push] восстановление без агента:", err));
  }

  // Живое обновление ПОСЛЕ коммита (аудит 11.09.2026, второй заход по осиротевшим
  // спутникам, п.4 задания): карточка ушла из Корзины и снова видна в списках —
  // ownerGone=true уже опубликовал changeClientAgent сам (через
  // closeOwnershipSatellites), здесь покрываем и обычный случай «агент тот же».
  publishClientUpdated({ clientId: client.id, agentIds: [client.assignedAgentId] });
  return {
    ok: true,
    client: { id: client.id, shortId: client.shortId, fullName: client.fullName, phone: client.phone },
    ownerReassignedToQueue: ownerGone,
  };
}
