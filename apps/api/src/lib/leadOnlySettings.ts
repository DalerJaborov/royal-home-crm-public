/**
 * РЕЖИМ «ТОЛЬКО ЗАЯВКИ» — «СЕЙЧАС» ПО ДУШАНБЕ ДЛЯ ВРЕМЕНИ ЗВОНКА (владелец 12–13.11.2026).
 *
 * Настройки режима читает ТОЛЬКО lib/leadOnlyConfig.ts (вынесено 13.11.2026: его зовут и общие уведомления CRM). С 19.11.2026
 * ход в режиме ведёт оператор (ai/operator): прежние «варианты от N», «прочее обращение» и разбор вопроса об объекте удалены.
 */
import { dushanbeTimeString } from "./dushanbeTime.js";
import { leadOnlyCallbackWhen, type LeadOnlyConfig } from "../ai/leadOnlyMode.js";
export { leadOnlyQuietBeforeLead, loadLeadOnlyConfig } from "./leadOnlyConfig.js";

/** Когда агент позвонит, по Душанбе (lib/dushanbeTime.ts), по окну Настроек. */
export function leadOnlyWhen(config: Pick<LeadOnlyConfig, "workHoursStart" | "workHoursEnd">, at: Date = new Date()) {
  return leadOnlyCallbackWhen({ now: dushanbeTimeString(at), workHoursStart: config.workHoursStart, workHoursEnd: config.workHoursEnd });
}
