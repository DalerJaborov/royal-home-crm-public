import { READ_ONLY_ROLES, type PermissionId, type Role } from "@royal-home/shared";
import { prisma } from "../db.js";
import { automationSwitchOn } from "./automationSwitches.js";
import { findAgentsWithPermission } from "./recipients.js";

/**
 * ОДНА ДВЕРЬ: КТО ПОЛУЧАЕТ ОТЧЁТЫ ДЛЯ ЧТЕНИЯ (27.11.2026, владелец: «добавь нового
 * учредителя… с автоматическими отчётами как и у директора»).
 *
 * Отчёт — это то, что читают, а не то, по чему действуют: утренняя сводка, разбор
 * проблемных мест, месячный отчёт, разбор маркетинга, советы ИИ к собранию, финансовый
 * PDF. Его получает и акционер (роль режима просмотра) — пока включён рубильник
 * «Отчёты акционеру» (Settings.shareholderReportsEnabled, по умолчанию ВКЛ).
 *
 * Тревоги с действием (передать клиента, ответить, починить канал, оплатить) сюда НЕ
 * ходят: обычный `findAgentsWithPermission` режим просмотра исключает сам
 * (lib/recipients.ts), а списки ролей тревог акционера не называют. Поэтому новый
 * отчёт для акционера — только через эту дверь, а не дописыванием SHAREHOLDER в
 * чужой список ролей: так рубильник выключает их все разом.
 */
export async function shareholderReportsOn(): Promise<boolean> {
  return automationSwitchOn("shareholderReportsEnabled");
}

/** Роли получателей отчёта: те, что у отчёта были, плюс режим просмотра под рубильником. */
export async function reportRecipientRoles(base: readonly Role[]): Promise<Role[]> {
  const roles = [...base];
  if (await shareholderReportsOn()) for (const r of READ_ONLY_ROLES) if (!roles.includes(r)) roles.push(r);
  return roles;
}

/** Получатели отчёта по праву: обычные сотрудники с правом и акционер под рубильником. */
export async function findReportRecipients(permission: PermissionId): Promise<string[]> {
  return findAgentsWithPermission(permission, { includeReadOnly: await shareholderReportsOn() });
}

/** Получатели отчёта по ролям (активные), id. */
export async function findReportRecipientsByRoles(base: readonly Role[]): Promise<string[]> {
  const roles = await reportRecipientRoles(base);
  const rows = await prisma.agent.findMany({ where: { role: { in: roles }, isActive: true }, select: { id: true } });
  return rows.map((r) => r.id);
}
