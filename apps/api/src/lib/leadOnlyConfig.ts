/**
 * РЕЖИМ «ТОЛЬКО ЗАЯВКИ» — НАСТРОЙКИ РЕЖИМА (рубильники экрана «Бот»).
 *
 * Обоим маршрутам бота (ядро и старый путь) и общим уведомлениям CRM настройки режима отдаёт ТОЛЬКО этот
 * файл — второго места, где читается botLeadOnlyMode, быть не должно. Отдельно от lib/leadOnlySettings.ts,
 * потому что его зовут и уведомления «по вашему объекту пишут» (lib/propertyInterestNotice.ts), а тот файл
 * тянет поиск объектов и приём заявок: круг импортов (audit:deps:gate).
 */
import { prisma } from "../db.js";
import { clampMaxPhoneAsks, leadOnlyAppliesTo, LEAD_ONLY_DEFAULTS, type LeadOnlyConfig } from "../ai/leadOnlyMode.js";

export async function loadLeadOnlyConfig(): Promise<LeadOnlyConfig> {
  try {
    const row = await prisma.settings.findUnique({ where: { id: "singleton" }, select: {
      botLeadOnlyMode: true, botUseWhatsappNumber: true, botMaxPhoneAsks: true, botHotIntentHandover: true,
      workHoursStart: true, workHoursEnd: true,
    } });
    if (!row) return LEAD_ONLY_DEFAULTS;
    return { enabled: row.botLeadOnlyMode === true, useWhatsappNumber: row.botUseWhatsappNumber !== false,
      maxPhoneAsks: clampMaxPhoneAsks(row.botMaxPhoneAsks), hotIntentHandover: row.botHotIntentHandover !== false,
      workHoursStart: row.workHoursStart || LEAD_ONLY_DEFAULTS.workHoursStart, workHoursEnd: row.workHoursEnd || LEAD_ONLY_DEFAULTS.workHoursEnd };
  } catch {
    // Настройки недоступны — режим считаем выключенным: прежнее поведение безопаснее молчания.
    return LEAD_ONLY_DEFAULTS;
  }
}

/**
 * В этом канале действует режим «только заявки»: до заявки (номера) людей не зовут вовсе, ни ботом, ни
 * общими уведомлениями CRM «по вашему объекту пишут» (решение владельца 13.11.2026: «никаких уведомлений
 * не надо никому высылать пока он не станет лидом»). Одна проверка для всех таких уведомлений; режим
 * выключен (по умолчанию) или канал не WhatsApp/Instagram/Facebook — false, всё как раньше.
 */
export async function leadOnlyQuietBeforeLead(channel: string | null | undefined): Promise<boolean> {
  if (!leadOnlyAppliesTo(channel)) return false;
  return (await loadLeadOnlyConfig()).enabled;
}
