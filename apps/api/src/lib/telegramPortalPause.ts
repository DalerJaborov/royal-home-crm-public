import { prisma } from "../db.js";

/**
 * ПАУЗА TELEGRAM-УВЕДОМЛЕНИЙ С ПЛОЩАДОК Somon/Paydo (03.11.2026, владелец: «временно приостановить»).
 *
 * ОДНА ДВЕРЬ: Settings.telegramPortalAlertsPaused (по умолчанию true; нет строки Settings — тоже пауза).
 * Единственный путь отправки в Telegram по этим площадкам — lib/somonLeads/sendReserved.ts (Paydo в Telegram
 * ничего не шлёт, это сбор рынка). Читают его и тик мониторинга (monitor.ts), и сама отправка. В CRM
 * (колокольчик, ленты, карточки) пауза ничего не меняет.
 *
 * СНЯТЬ ПАУЗУ: `UPDATE "Settings" SET "telegramPortalAlertsPaused" = false WHERE id = 'singleton';`
 * (или через Prisma Studio). Новый путь отправки по площадкам обязан звать эту функцию —
 * держит тест tests/telegram-portal-pause.test.ts.
 */
type Reader = { settings: { findUnique: typeof prisma.settings.findUnique } };

export async function portalAlertsPausedIn(db: Reader): Promise<boolean> {
  const row = await db.settings.findUnique({ where: { id: "singleton" }, select: { telegramPortalAlertsPaused: true } });
  return row?.telegramPortalAlertsPaused ?? true;
}

export function isTelegramPortalAlertsPaused(): Promise<boolean> {
  return portalAlertsPausedIn(prisma);
}
