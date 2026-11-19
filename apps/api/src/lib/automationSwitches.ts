import { isAutomationSwitchOn, type AutomationSwitchKey } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";

/**
 * ОДНА ДВЕРЬ: «ВКЛЮЧЕНА ЛИ ЭТА АВТОМАТИКА ИИ ИЛИ ЭТО НАПОМИНАНИЕ» (владелец 19.11.2026).
 *
 * Список и подписи — packages/shared/src/automationSwitches.ts. Механизм спрашивает
 * здесь первым делом и при «нет» молча ничего не делает: без записи, без задачи, без
 * уведомления и без тревоги в журнал ошибок — выключенное владельцем не поломка.
 *
 * Без кэша нарочно (тот же довод, что у lib/sellerSwitches.ts): api и worker — разные
 * процессы, выключение обязано действовать в обоих с ближайшего вызова. Один
 * findUnique на проверку: вызывающий читает её там, где решает, действовать ли (в цикле по строкам — один раз до цикла).
 *
 * Нет строки настроек — включено: то же умолчание, что у колонок в базе. Сбой чтения
 * не выключает механизм: ошибка уходит вызывающему, как и у соседних дверей.
 */
export async function automationSwitchOn(key: AutomationSwitchKey, db: Pick<TxClient, "settings"> = prisma): Promise<boolean> {
  const row = await db.settings.findUnique({ where: { id: "singleton" }, select: { [key]: true } as Record<string, true> });
  return isAutomationSwitchOn(row as Partial<Record<AutomationSwitchKey, boolean>> | null, key);
}
