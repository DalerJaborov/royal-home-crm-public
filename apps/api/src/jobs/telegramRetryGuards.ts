import { prisma } from "../db.js";

/**
 * Карточка диалога для повтора хода в Telegram (03.10.2026, аудит audit-1,
 * находка 14): «deleted» — клиент в Корзине, отвечать незачем (тот же довод, что
 * jobs/aiReplyRetry.ts); иначе — есть ли у карточки номер, чтобы повтор не
 * попросил его снова (phoneKnown, как у живого хода в telegram/bot.ts).
 * Отказ базы — «номера не знаем»: лишняя просьба лучше молчания.
 */
export async function clientPhoneKnownOrDeleted(clientId: string | null): Promise<boolean | "deleted"> {
  if (!clientId) return false;
  const client = await prisma.client
    .findUnique({ where: { id: clientId }, select: { phone: true, deletedAt: true } })
    .catch(() => undefined);
  if (client === undefined) return false;
  if (!client || client.deletedAt) return "deleted";
  return !!client.phone;
}
