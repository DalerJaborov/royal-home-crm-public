import { prisma } from "../db.js";
import { isWithinDushanbeWindow } from "./dushanbeTime.js";

/** Рабочие часы распределения лидов (Настройки → workHoursStart/End) — НЕ влияют
 * на доступность самого бота: он отвечает, читает вложения и принимает заявки
 * круглосуточно и без урезанного режима (решение владельца 31.07.2026). Влияют
 * только на то, идёт ли новый лид агенту сразу или ждёт утренней волны (см. leads.ts).
 *
 * Заготовленный ответ «вне рабочих часов» здесь был и удалён вместе с самим
 * режимом: он обрывал разговор и уходил по-русски даже таджикоязычному клиенту. */
export async function isWithinWorkingHours(at: Date = new Date()): Promise<boolean> {
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { workHoursStart: true, workHoursEnd: true },
    });
    return isWithinDushanbeWindow(settings?.workHoursStart ?? "09:30", settings?.workHoursEnd ?? "18:00", at);
  } catch {
    return true; // настройки недоступны — безопаснее не блокировать распределение
  }
}

/**
 * ЧАСЫ АЛАРМОВ РУКОВОДИТЕЛЮ (владелец 07.09.2026) — НЕ то же самое, что
 * isWithinWorkingHours выше: то окно решает, когда лид уходит агенту, это —
 * когда директору можно слать пуши/алармы (антифрод, «заявлено/сделано»,
 * пропущенный показ и т.п.). Отдельная настройка (Settings.alarmHoursStart/End),
 * чтобы смена одного окна не сдвигала тихо другое. Накопленное вне окна не
 * пропадает: тик просто молчит, следующий тик после начала окна досчитает —
 * тот же приём, что у isWithinWorkingHours.
 */
export async function isWithinAlarmHours(at: Date = new Date()): Promise<boolean> {
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { alarmHoursStart: true, alarmHoursEnd: true },
    });
    return isWithinDushanbeWindow(settings?.alarmHoursStart ?? "09:50", settings?.alarmHoursEnd ?? "14:45", at);
  } catch {
    return true; // настройки недоступны — безопаснее не блокировать аларм
  }
}

