import { isSellerSwitchOn, SELLER_AUTOMATION_MASTER_KEY, type SellerSwitchKey } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";

/**
 * ОДНА ДВЕРЬ: «ВКЛЮЧЕНА ЛИ ЭТА АВТОМАТИКА ПО ПРОДАВЦАМ» (владелец 14.11.2026).
 *
 * Каждый тик и задание из списка packages/shared/src/sellerAutomationSwitches.ts
 * спрашивает здесь первым делом и при «нет» молча выходит: без ошибки, без
 * тревоги, без записи в журнал — выключенное владельцем не поломка.
 *
 * Без кэша нарочно: вызов один на тик (раз в 30–60 минут) или на задание, а
 * выключение обязано действовать с ближайшего же прохода — кэш в памяти
 * процесса жил бы отдельно в api и в worker и выключал бы в них в разное время.
 *
 * Нет строки настроек — включено: то же умолчание, что у колонок в базе.
 */
export async function sellerSwitchOn(key: SellerSwitchKey, db: Pick<TxClient, "settings"> = prisma): Promise<boolean> {
  const row = await db.settings.findUnique({
    where: { id: "singleton" },
    select: { [SELLER_AUTOMATION_MASTER_KEY]: true, [key]: true } as Record<string, true>,
  });
  return isSellerSwitchOn(row as Partial<Record<string, boolean>> | null, key);
}
