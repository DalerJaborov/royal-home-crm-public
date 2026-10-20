import { resolvePermissions, parsePermissionOverrides, type PermissionId, type Role } from "@royal-home/shared";
import { prisma } from "../db.js";

/**
 * Кому уходит служебное уведомление — по праву, а не по роли.
 *
 * Роли в CRM больше не жёсткие: директор раздаёт права галочками любому
 * сотруднику, и роль стала лишь пресетом на старте. Список получателей,
 * прибитый к ролям DIRECTOR/ADMIN/MANAGER, этого не знал: сотрудник, которому
 * директор специально выдал право назначать риелтора, уведомлений о непринятых
 * заявках не получал, а менеджер, у которого это право отобрали, продолжал их
 * получать — и оба факта были не видны в интерфейсе прав.
 *
 * Directоr-only права сюда не подходят по смыслу: уведомление должно приходить
 * тем, кто может ПОЧИНИТЬ ситуацию, а не только владельцу.
 */
export async function findAgentsWithPermission(permission: PermissionId): Promise<string[]> {
  // Права лежат в overrides поверх пресета роли и считаются в памяти, поэтому
  // отфильтровать их запросом к базе нельзя. Активных сотрудников в агентстве
  // десятки, выборка дешёвая — берём id, роль и overrides и решаем на месте.
  const agents = await prisma.agent.findMany({
    where: { isActive: true },
    select: { id: true, role: true, permissions: true },
  });

  return agents
    .filter((a) =>
      resolvePermissions(a.role as Role, parsePermissionOverrides(a.permissions)).has(permission)
    )
    .map((a) => a.id);
}

/**
 * Те же права, но для УЖЕ известного списка получателей: кому из них можно
 * показать то, что закрыто правом, а кому нет.
 *
 * Нужно там, где одно событие уходит пачке сотрудников с разными правами —
 * прежде всего пушам и ленте уведомлений (см. push.ts): текст там собирается
 * ОДИН на всех, и решить «показывать номер клиента или маску» можно только
 * разложив получателей на две группы.
 *
 * Считается в памяти по той же причине, что и у findAgentsWithPermission:
 * надстройки прав лежат поверх пресета роли в Json-колонке, запросом их не
 * отфильтровать. Выборка идёт строго по переданным id и ничего лишнего не
 * читает.
 *
 * Уволенный сотрудник (isActive: false) сюда попадёт как «без права»: пуш ему
 * и так не уедет (подписок нет), а запись в ленте безопаснее оставить закрытой.
 */
export async function partitionByPermission(
  agentIds: string[],
  permission: PermissionId
): Promise<{ granted: string[]; denied: string[] }> {
  if (agentIds.length === 0) return { granted: [], denied: [] };
  const agents = await prisma.agent.findMany({
    where: { id: { in: agentIds }, isActive: true },
    select: { id: true, role: true, permissions: true },
  });
  const granted = new Set(
    agents
      .filter((a) => resolvePermissions(a.role as Role, parsePermissionOverrides(a.permissions)).has(permission))
      .map((a) => a.id)
  );
  return {
    granted: agentIds.filter((id) => granted.has(id)),
    denied: agentIds.filter((id) => !granted.has(id)),
  };
}
