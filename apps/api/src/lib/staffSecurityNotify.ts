import { prisma } from "../db.js";
import { sendPushToAgents } from "../push.js";
import { dushanbeDateTimeString } from "./dushanbeTime.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";

/**
 * ОДНО СООБЩЕНИЕ РУКОВОДСТВУ О ЧУВСТВИТЕЛЬНОМ ИЗМЕНЕНИИ СОТРУДНИКА (10.11.2026).
 *
 * Права, роль, телефон-логин, отключение, удаление, сброс второго фактора — и из
 * CRM, и через помощницу — плюс серия неверных кодов Google Authenticator в
 * Telegram (признак чужих рук). Одна дверь: lib/staffAdmin.ts и
 * telegram/assistantStepUp.ts зовут только эту функцию.
 *
 * ПОЛУЧАТЕЛИ: все активные директора и администраторы, кроме того, кто действовал
 * (он уже видел итог в карточке). Если других нет — приходит ему самому: хотя бы
 * он узнает о событии из ленты CRM. Доставка — штатный модуль
 * (push.ts::sendPushToAgents): запись в колокольчике CRM всегда, пуш на телефон —
 * по подпискам и тихим часам. Одно сообщение на одно изменение.
 */
export type StaffSecurityChange =
  | "created"
  | "permissions"
  | "role"
  | "phone"
  | "frozen"
  | "handover"
  | "deactivated"
  | "deleted"
  | "reset2fa"
  | "lockout";

/** Откуда пришло: экран CRM, помощница в Telegram или помощница в панели CRM. */
export type StaffChangeChannel = "rest" | "telegram" | "crm";

const TITLES: Record<StaffSecurityChange, string> = {
  created: "👤 Новый сотрудник",
  permissions: "🔐 Изменены права",
  role: "🔐 Изменена роль",
  phone: "📱 Сменён телефон для входа",
  frozen: "❄️ Сотрудник заморожен",
  handover: "📦 Переданы дела",
  deactivated: "🚫 Учётка отключена",
  deleted: "🗑 Сотрудник удалён",
  reset2fa: "🔐 Сброшен Google Authenticator",
  lockout: "⛔ Неверные коды Google Authenticator",
};

const VIA: Record<StaffChangeChannel, string> = {
  rest: "в CRM",
  telegram: "через Шабнам в Telegram",
  crm: "через Шабнам в CRM",
};

export interface StaffChangeNotice {
  change: StaffSecurityChange;
  actorId: string;
  targetId: string;
  targetName: string;
  details?: string;
  channel: StaffChangeChannel;
  at?: Date;
}

/** Кому: активные DIRECTOR и ADMIN, кроме автора; никого — автор сам. */
export async function staffNoticeRecipients(actorId: string): Promise<string[]> {
  const rows = await prisma.agent.findMany({
    where: { role: { in: ["DIRECTOR", "ADMIN"] }, isActive: true, NOT: { phone: { contains: "-deleted:" } } },
    select: { id: true },
    take: 50,
  });
  const others = rows.map((r) => r.id).filter((id) => id !== actorId);
  if (others.length > 0) return others;
  const self = await prisma.agent.findUnique({ where: { id: actorId }, select: { isActive: true } });
  return self?.isActive ? [actorId] : [];
}

export async function notifyDirectorsOfStaffChange(input: StaffChangeNotice): Promise<number> {
  const at = input.at ?? new Date();
  const [actor, recipients] = await Promise.all([
    prisma.agent.findUnique({ where: { id: input.actorId }, select: { fullName: true } }),
    staffNoticeRecipients(input.actorId),
  ]);
  if (recipients.length === 0) return 0;
  const when = `${dushanbeDateTimeString(at)} по Душанбе`;
  const who = input.change === "lockout" ? "Telegram" : `${actor?.fullName ?? "Сотрудник"} ${VIA[input.channel]}`;
  const body = [`${input.targetName}.`, input.details ? `${input.details}.` : null, `Кто: ${who}. Когда: ${when}.`]
    .filter(Boolean)
    .join(" ");
  return sendPushToAgents(recipients, {
    title: TITLES[input.change],
    body,
    url: input.change === "deleted" ? "/team" : `/team/${input.targetId}`,
    tag: `staff-security-${input.change}-${input.targetId}-${at.getTime()}`,
  });
}

/** В фоне: сбой сообщения не делает сделанное несделанным, но попадает в «Здоровье системы». */
export function notifyStaffChangeLater(input: StaffChangeNotice): void {
  void notifyDirectorsOfStaffChange(input).catch((err) =>
    logSystemError("api", `Сообщение руководству об изменении сотрудника не ушло: ${describeError(err)}`)
  );
}
