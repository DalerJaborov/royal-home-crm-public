import { prisma } from "../db.js";
import { sendPushToAgents } from "../push.js";
import { dushanbeDateTimeString } from "./dushanbeTime.js";

/**
 * ОДНО СООБЩЕНИЕ ДИРЕКТОРАМ О ЧУВСТВИТЕЛЬНОМ ИЗМЕНЕНИИ СОТРУДНИКА (10.11.2026).
 *
 * Права, удаление или отключение учётки, сброс второго фактора — изменения, о
 * которых владелец должен знать, даже если их сделал другой руководитель через
 * помощницу в Telegram. Одно сообщение на одно изменение, штатным модулем
 * уведомлений (лента + пуш, тихие часы и маска телефонов — его же,
 * push.ts::sendPushToAgents), всем активным директорам, кроме того, кто нажал
 * сам: себе о своём действии он уже прочитал в карточке (решение владельца
 * «редко беспокоить людей»).
 *
 * Сейчас зовётся из действий помощницы (ai/assistant/tools/staffWriteTools.ts).
 * REST (экран «Команда») это сообщение не шлёт — его поведение в этой правке не
 * менялось; включить и там — решение владельца (docs/journal/2026-11-10-shabnam-staff-rights.md).
 */
export type StaffSecurityChange = "permissions" | "role" | "deactivated" | "deleted" | "reset2fa";

const TITLES: Record<StaffSecurityChange, string> = {
  permissions: "🔐 Изменены права",
  role: "🔐 Изменена роль",
  deactivated: "🚫 Учётка отключена",
  deleted: "🗑 Сотрудник удалён",
  reset2fa: "🔐 Сброшен Google Authenticator",
};

export async function notifyDirectorsOfStaffChange(input: {
  change: StaffSecurityChange;
  actorId: string;
  targetId: string;
  targetName: string;
  details?: string;
  /** Откуда нажали: помощница в Telegram или помощница в CRM. */
  channel: "telegram" | "crm";
  at?: Date;
}): Promise<number> {
  const [actor, directors] = await Promise.all([
    prisma.agent.findUnique({ where: { id: input.actorId }, select: { fullName: true } }),
    prisma.agent.findMany({
      where: { role: "DIRECTOR", isActive: true, id: { not: input.actorId } },
      select: { id: true },
      take: 50,
    }),
  ]);
  if (directors.length === 0) return 0;
  const when = dushanbeDateTimeString(input.at ?? new Date());
  const who = `${actor?.fullName ?? "Сотрудник"} через Шабнам ${input.channel === "telegram" ? "в Telegram" : "в CRM"}`;
  const body = [`${input.targetName}.`, input.details ? `${input.details}.` : null, `Кто: ${who}. Когда: ${when}.`]
    .filter(Boolean)
    .join(" ");
  return sendPushToAgents(
    directors.map((d) => d.id),
    {
      title: TITLES[input.change],
      body,
      url: input.change === "deleted" ? "/team" : `/team/${input.targetId}`,
      tag: `staff-security-${input.change}-${input.targetId}-${(input.at ?? new Date()).getTime()}`,
    }
  );
}
