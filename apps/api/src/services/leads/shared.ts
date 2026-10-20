import { dushanbeNextOccurrence, isWithinDushanbeWindow } from "../../lib/dushanbeTime.js";

/**
 * НИЖНЯЯ ГРАНИЦА ОКНА КАНДИДАТОВ ДЛЯ АВТО-КРУГОВ ЛИДА (найдено на проде 17.09.2026:
 * `penalizeMissedFirstCalls` и `reassignStaleLeads` выбирали кандидатов только по
 * верхней границе — «остыл раньше такого-то момента» — без нижней. Ручной возврат
 * старой карточки в работу (`revert-orphan-sellers`, `revert-carousel`,
 * `release-for-morning-wave`, вечер 16.09) переставляет `acceptedAt`/`assignedAt` на
 * «сейчас», и карточка, принятая или отработанная месяц назад, снова выглядит как
 * свежий кандидат для правила «не позвонил/не принял за N минут» — хотя это дело
 * прошлых тиков или вовсе ручной правки, а не текущего срыва.
 *
 * Общая механика для обоих правил: нижняя граница = `now - max(cycleMinutes, 60) * 4`.
 * `cycleMinutes` — длина одного полного круга конкретного правила (для первого
 * звонка это окно звонка + окно пула «ничьих», для принятия — само окно принятия).
 * Умножение на 4 и пол в 60 минут — «несколько кругов правила, но не меньше часа»:
 * всё, что старше, уже либо решено прошлыми тиками крона, либо перевыставлено рукой
 * администратора и трогать его этим правилом больше не нужно.
 */
export function candidateWindow(cycleMinutes: number, cutoffMinutes: number, now: Date): { from: Date; to: Date } {
  const windowMinutes = Math.max(cycleMinutes, 60) * 4;
  return {
    from: new Date(now.getTime() - windowMinutes * 60_000),
    to: new Date(now.getTime() - cutoffMinutes * 60_000),
  };
}

// `nextAgentForTrainingCycle` («режим обучения», Settings.leadEscalationEnabled)
// УДАЛЕНА 25.09.2026 решением владельца — оба вызывающих (reassignment.ts,
// firstCall.ts) больше не читают этот тумблер и всегда идут обычной веткой
// (карусель и так не эскалирует, пока есть кому предложить — правило
// 17.09.2026, «пусть крутится»; сама логика восстановления круга и рестарта на
// держателя осталась и живёт прямо в reassignStaleLeads). Колонка в схеме
// осталась (см. её комментарий в schema.prisma) — старый контейнер во время
// выката ещё читает Settings целиком.

export type LeadHours = { start: string; end: string };

/** Окно «Когда лиды уходят агентам» (Настройки → workHoursStart/End) — те же
 *  умолчания, что у lib/workingHours.ts::isWithinWorkingHours. */
export function leadHoursOf(settings: { workHoursStart?: string | null; workHoursEnd?: string | null } | null): LeadHours {
  return { start: settings?.workHoursStart ?? "09:30", end: settings?.workHoursEnd ?? "18:00" };
}

/** Последний момент по Душанбе, когда часы показывали `hhmm`, не позже `at`. */
export function dushanbePrevOccurrence(hhmm: string, at: Date): Date {
  return new Date(dushanbeNextOccurrence(hhmm, at).getTime() - 24 * 60 * 60 * 1000);
}

/**
 * НИЖНЯЯ ГРАНИЦА ОКНА ПОСЛЕ НОЧНОЙ ПАУЗЫ (23.09.2026). Ночью круг стоит
 * (staleLeadCircleOpen), поэтому лид, выданный в 20:55 и не
 * принятый, к 10:00 старше обычного окна `candidateWindow` (4 часа) и без
 * этой поправки выпал бы из круга навсегда — висел бы «Ждёт принятия» у
 * вечернего агента. В первые часы рабочего дня граница отодвигается к
 * моменту, когда круг встал вечером, минус то же окно: кандидатами остаются
 * ровно те лиды, что были кандидатами в момент остановки. Днём граница прежняя.
 */
export function widenAfterNight(from: Date, hours: LeadHours, now: Date): Date {
  const windowMs = now.getTime() - from.getTime();
  const lastStart = dushanbePrevOccurrence(hours.start, now);
  const lastEnd = dushanbePrevOccurrence(hours.end, now);
  // Пауза была (конец раньше начала) и день начался не дальше одного окна назад.
  const nightJustEnded = lastEnd < lastStart && now.getTime() - lastStart.getTime() < windowMs;
  if (!nightJustEnded) return from;
  const widened = new Date(lastEnd.getTime() - windowMs);
  return widened < from ? widened : from;
}

/**
 * СКОЛЬКО СРОК ПЕРВОГО ЗВОНКА СТОИТ НОЧЬЮ (23.09.2026, проверка раздачи, пункт 10).
 *
 * Срок «позвонить за N минут» идёт только в часы раздачи — как и круг «не
 * принял» (staleLeadCircleOpen): настройка обещает, что время ответа не идёт,
 * пока агент спит. Раньше срок шёл круглосуточно, а проверял его только дневной
 * тик. Лид, принятый в 20:50, истекал в 21:05, когда тик уже молчал, а к утру
 * выпадал из окна проверки: его не проверял никто. Лид, принятый в 07:00,
 * в 10:00 оказывался «не прозвонен за 15 минут», и агента штрафовали за ночь.
 *
 * Возвращает, сколько закрытого времени лежит между приёмом и сроком, если
 * N минут отсчитывать только по открытым часам. Окно нулевой длины
 * (start === end) читается как «ограничений нет», чтобы опечатка в настройке
 * не останавливала срок навсегда.
 */
export function closedMsBeforeDue(acceptedAt: Date, minutes: number, hours: LeadHours): number {
  if (hours.start === hours.end) return 0;
  let t = acceptedAt;
  let remaining = minutes * 60_000;
  let paused = 0;
  // Каждый проход съедает один открытый отрезок; больше пары суток срок не бывает.
  for (let i = 0; i < 14; i++) {
    if (!isWithinDushanbeWindow(hours.start, hours.end, t)) {
      const open = dushanbeNextOccurrence(hours.start, t);
      paused += open.getTime() - t.getTime();
      t = open;
    }
    const close = dushanbeNextOccurrence(hours.end, t);
    const available = close.getTime() - t.getTime();
    if (remaining <= available) return paused;
    remaining -= available;
    t = close;
  }
  return paused;
}

/**
 * СРОК В РАБОЧИХ МИНУТАХ (решение владельца 02.10.2026, проверка B4).
 * Момент, когда истекут `minutes` минут, если считать только открытые часы
 * раздачи (Настройки → workHoursStart/End) — тем же правилом, что срок первого
 * звонка (closedMsBeforeDue выше). Заявка в 19:00 при рабочем дне до 18:00 со
 * сроком 120 минут истекает в 11:30 утра, а не в 21:00: агент получает свои
 * 120 минут, предупреждение и напоминание приходят днём.
 */
export function workingDueAt(start: Date, minutes: number, hours: LeadHours): Date {
  return new Date(start.getTime() + minutes * 60_000 + closedMsBeforeDue(start, minutes, hours));
}

/**
 * Сколько ОТКРЫТОГО времени (часы раздачи) лежит между `from` и `to`; 0, если
 * `to` не позже `from`. Окно нулевой длины — «ограничений нет», как в
 * closedMsBeforeDue. Нужна там, где срок сравнивают с «сейчас»: «сколько
 * рабочих минут осталось» и «сколько рабочих минут прошло после срока».
 */
export function openMsBetween(from: Date, to: Date, hours: LeadHours): number {
  if (to.getTime() <= from.getTime()) return 0;
  if (hours.start === hours.end) return to.getTime() - from.getTime();
  let t = from;
  let open = 0;
  // Один проход — одни сутки; дольше двух месяцев срока не бывает.
  for (let i = 0; i < 62 && t.getTime() < to.getTime(); i++) {
    if (!isWithinDushanbeWindow(hours.start, hours.end, t)) {
      t = dushanbeNextOccurrence(hours.start, t);
      if (t.getTime() >= to.getTime()) break;
    }
    const close = dushanbeNextOccurrence(hours.end, t);
    const segmentEnd = close.getTime() < to.getTime() ? close : to;
    open += segmentEnd.getTime() - t.getTime();
    t = close;
  }
  return open;
}
