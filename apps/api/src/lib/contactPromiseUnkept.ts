import type { ConversationMessage } from "@royal-home/shared";
import { lastAgentContactPromise } from "./phoneLeadWatchdog.js";
import { dushanbeStartOfToday } from "./dushanbeTime.js";

/**
 * ОБЕЩАНИЕ СВЯЗАТЬСЯ НЕ ВЫПОЛНЕНО (разбор суток 23.11.2026, C6). Бот (или прежний бот) сказал клиенту «агент позвонит /
 * с вами свяжутся», а потом ни звонка агента (`Client.lastAgentAttemptAt`), ни ответа сотрудника в переписке не было. Клиент
 * пишет снова — второй раз бот не обещает (ai/operator/decide.ts), а агент и РОП получают сигнал (lib/clientWaitingAlert.ts).
 *
 * Обещание ищет тот же словарь, что и сторож лидов (ai/callbackPromiseGuard.ts через lib/phoneLeadWatchdog.ts), только в
 * репликах БОТА: слова сотрудника — не обещание бота. Обещанию, у которого прошло меньше двух РАБОЧИХ часов (окно из Настроек,
 * по Душанбе), ещё рано быть «не выполненным»: ночное «позвонит завтра с 09:30» в 01:00 не нарушено, и каждое «когда
 * позвонят?» через час не звало бы РОПа; старше трёх месяцев — уже не про этот
 * разговор (C6: обещание 16.10, клиент вернулся 22.11 — через 37 дней). Чистая функция.
 */
export const UNKEPT_PROMISE_MIN_AGE_MS = 2 * 60 * 60_000;
export const UNKEPT_PROMISE_MAX_AGE_MS = 90 * 24 * 60 * 60_000;

type Row = { role?: unknown; content?: unknown; at?: unknown; by?: { kind?: unknown } | null };
const staffKinds = new Set(["agent", "manual"]);
const isStaff = (m: Row) => m.role === "assistant" && staffKinds.has(String(m.by?.kind ?? ""));

/** Сколько миллисекунд рабочего окна (по Душанбе, каждый день) между `from` и `to`. Выходные не учитываются (ОЦЕНКА). Чистая. */
export function workingMsBetween(from: Date, to: Date, hours: { start: string; end: string }): number {
  const minutes = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
  const start = minutes(hours.start), end = minutes(hours.end);
  if (!(end > start)) return Math.max(0, to.getTime() - from.getTime());
  let total = 0;
  for (let day = dushanbeStartOfToday(from).getTime(); day < to.getTime(); day += 24 * 60 * 60_000) {
    const a = Math.max(day + start * 60_000, from.getTime()), b = Math.min(day + end * 60_000, to.getTime());
    if (b > a) total += b - a;
  }
  return total;
}

export function contactPromiseUnkept(messages: unknown, lastAgentAttemptAt: Date | null, now: Date,
  /** Рабочее окно из Настроек: «два часа» считаются только в нём. Нет — по часам на стене. */
  hours?: { start: string; end: string }): boolean {
  if (!Array.isArray(messages)) return false;
  const rows = messages as Row[];
  const botOnly = rows.filter(m => !isStaff(m)) as unknown as ConversationMessage[];
  const promise = lastAgentContactPromise(botOnly, null, now);
  if (!promise || now.getTime() - promise.at.getTime() > UNKEPT_PROMISE_MAX_AGE_MS) return false;
  const waited = hours ? workingMsBetween(promise.at, now, hours) : now.getTime() - promise.at.getTime();
  if (waited < UNKEPT_PROMISE_MIN_AGE_MS) return false;
  if (lastAgentAttemptAt && lastAgentAttemptAt.getTime() >= promise.at.getTime()) return false;
  return !rows.some(m => isStaff(m) && typeof m.at === "string" && Date.parse(m.at) > promise.at.getTime());
}
