import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";

/**
 * Первое ли это нажатие с таким id. Повторная доставка того же callback_query
 * (вебхук повторил, поллер перечитал) — false, и решение второй раз не исполняется.
 *
 * Отдельный модуль без зависимостей (10.11.2026): lib/telegramModeration.ts
 * тянет за собой проверку объектов и монтаж, и дверь сообщений помощницы
 * (telegram/staffNotice.ts), импортируя отсюда через модерацию, замыкала круг
 * импортов. telegramModeration.ts переизлучает эту функцию — вызовы не тронуты.
 */
export async function claimCallback(id: string): Promise<boolean> {
  try {
    await prisma.telegramCallbackSeen.create({ data: { id } });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false;
    throw err;
  }
}
