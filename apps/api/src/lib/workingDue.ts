import { prisma } from "../db.js";
import { leadHoursOf, workingDueAt } from "../services/leads/shared.js";

/**
 * СРОКИ В РАБОЧИХ МИНУТАХ (решение владельца 02.10.2026, проверка B4).
 *
 * Срок принять вернувшегося клиента (`returnAcceptDueAt`, Настройки →
 * lostReturnAcceptMinutes, 120 мин) и срок проверки дубля
 * (`duplicateReviewDueAt`, duplicateReviewTimeoutHours, 6 ч) идут только в часы
 * раздачи (workHoursStart/End) — тем же правилом, что срок первого звонка
 * (services/leads/shared.ts::closedMsBeforeDue). Заявка в 19:00 при рабочем дне
 * до 18:00 получает срок 11:30 утра: агенту достаются его 120 минут, а не ночь.
 */
export async function returnAcceptDueFromNow(now: Date = new Date()): Promise<Date> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { lostReturnAcceptMinutes: true, workHoursStart: true, workHoursEnd: true },
  });
  return workingDueAt(now, s?.lostReturnAcceptMinutes ?? 120, leadHoursOf(s));
}

/** Срок проверки дубля: `timeoutHours` рабочих часов от `now`. */
export async function duplicateReviewDueFrom(now: Date, timeoutHours: number): Promise<Date> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { workHoursStart: true, workHoursEnd: true },
  });
  return workingDueAt(now, Math.round(timeoutHours * 60), leadHoursOf(s));
}

/** Часы раздачи из настроек — для сравнения сроков с «сейчас» в рабочих минутах. */
export async function leadHoursFromSettings() {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { workHoursStart: true, workHoursEnd: true },
  });
  return leadHoursOf(s);
}
