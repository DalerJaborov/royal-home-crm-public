import { prisma } from "../../db.js";
import { isDayOff, normalizeDaysOff } from "@royal-home/shared";
import { callbackPromise, hoursCalendar, loadClientHours } from "../../ai/agencyFacts.js";
import { findAgentsWithPermission } from "../recipients.js";

/**
 * КОМУ И КОГДА ПЕРЕЗВОНИТЬ ПОСЛЕ РАЗГОВОРА С КОНСУЛЬТАНТОМ (02.10.2026, аудит «клиенты
 * и задачи теряются», пункты Б7–Б9).
 *
 * Консультант обещает человеку «агент перезвонит» — и это обещание должно дойти до
 * того, кого назвали, в то время, которое назвали. Раньше задача шла «тому, кто ведёт
 * клиента», на +15 минут, с пушем, в любой час:
 *  - Б7: робот сказал «этот объект ведёт Нурмухаммад, он перезвонит», а задача шла
 *    другому агенту — тому, за кем числится клиент;
 *  - Б8: агент мог быть в отпуске (заморожен) или уволен — задача висела у человека,
 *    который её не увидит, а клиент оставался без звонка;
 *  - Б9: ночью робот говорит «перезвонит утром», а задача ставилась на +15 минут,
 *    агент получал ночной пуш, и задача была просрочена с ночи.
 */

/** Агент, которому можно поручить звонок: работает и не в отпуске. Выходные — для срока. */
async function usableAgent(agentId: string | null | undefined): Promise<{ id: string; weeklyDaysOff: number[] } | null> {
  if (!agentId) return null;
  const a = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, isActive: true, frozenAt: true, weeklyDaysOff: true },
  });
  return a && a.isActive && !a.frozenAt ? { id: a.id, weeklyDaysOff: normalizeDaysOff(a.weeklyDaysOff) } : null;
}

export type CallbackTargetSource = "named" | "assigned" | "duty" | "management";

export interface CallbackTarget {
  /** Кому задача. null — общая задача руководству (никого из личных адресатов нет). */
  agentId: string | null;
  source: CallbackTargetSource;
  /** Руководители, которых надо разбудить, когда личного адресата нет. */
  supervisorIds: string[];
  /** Личные выходные адресата — срок задачи ставится на ЕГО рабочий день (11.10.2026). */
  agentDaysOff: number[];
}

/**
 * Кому перезванивать. По порядку:
 *  1. агент, которого консультант назвал в разговоре (ведёт объект) — если работает;
 *  2. агент, за которым числится клиент — если работает;
 *  3. дежурный для перевода / дежурный оператор обратных звонков (Настройки);
 *  4. руководство: общая задача и пуш тем, кто раздаёт клиентов, — звонок обещан, и
 *     «никому» не вариант.
 *
 * ЛИЧНЫЙ ВЫХОДНОЙ (владелец 11.10.2026) адресата НЕ меняет: выходной не делает агента
 * «недоступным» — задача всё равно ему, а срок ставится на ЕГО следующий рабочий день
 * (callbackDueAt с `agentDaysOff`). Закреплённый клиент дежурному не уходит никогда из-за
 * выходного (дежурный/оператор принимает только незакреплённых — решение 11.10).
 */
export async function pickCallbackAgent(input: {
  namedAgentId: string | null;
  assignedAgentId: string | null;
}): Promise<CallbackTarget> {
  const named = await usableAgent(input.namedAgentId);
  if (named) return { agentId: named.id, source: "named", supervisorIds: [], agentDaysOff: named.weeklyDaysOff };
  const assigned = await usableAgent(input.assignedAgentId);
  if (assigned) return { agentId: assigned.id, source: "assigned", supervisorIds: [], agentDaysOff: assigned.weeklyDaysOff };
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { liveVoiceTransferAgentId: true, callbackOperatorAgentId: true },
  });
  const duty = (await usableAgent(settings?.liveVoiceTransferAgentId)) ?? (await usableAgent(settings?.callbackOperatorAgentId));
  if (duty) return { agentId: duty.id, source: "duty", supervisorIds: [], agentDaysOff: duty.weeklyDaysOff };
  // Замороженные руководители (отпуск) и неактивные пуш «ответственного нет» не получают:
  // findAgentsWithPermission фильтрует только isActive (третий аудит, п.16).
  const supervisors = await findAgentsWithPermission("clients.assign");
  const working = supervisors.length
    ? await prisma.agent.findMany({
        where: { id: { in: supervisors }, isActive: true, frozenAt: null },
        select: { id: true },
      })
    : [];
  return { agentId: null, source: "management", supervisorIds: working.map((a) => a.id), agentDaysOff: [] };
}

/** Через сколько минут перезванивать в рабочее время. */
export const CALLBACK_SOON_MINUTES = 15;

/**
 * Когда поставить задачу. В рабочее время — через пятнадцать минут, как раньше. Вне
 * рабочего времени робот обещал «утром» — задача на начало следующего рабочего окна
 * (Настройки → workHoursStart, по Душанбе через lib/dushanbeTime.ts, не через
 * setHours: контейнер живёт в UTC), без пуша ночью.
 *
 * ВЫХОДНЫЕ — ИЗ НАСТРОЕК (владелец 11.10.2026; до этого воскресенье, решение 08.09):
 * в общий выходной «окно» закрыто целиком; если известен адресат (`agentDaysOff`), срок
 * ложится на ЕГО ближайший рабочий день. Пусто — выходных нет. Праздников нет нигде.
 *
 * `promisedSoon` — робот был в рабочем окне на СТАРТЕ звонка и обещал «скоро» (п.18):
 * звонок, перевалившийся через закрытие, не должен тихо уйти на утро без пуша.
 */
export async function callbackDueAt(
  now: Date = new Date(),
  opts: { promisedSoon?: boolean | null; agentDaysOff?: readonly number[] | null } = {}
): Promise<{ at: Date; deferredToMorning: boolean }> {
  // Срок задачи — из того же решения, что сказано клиенту (ai/agencyFacts.ts::callbackPromise,
  // 10.10.2026): «сегодня» — через пятнадцать минут; «завтра / в понедельник после …» —
  // на начало того окна, без ночного пуша.
  const hours = await loadClientHours();
  const promise = callbackPromise(now, hours, opts.agentDaysOff);
  if (!isDayOff(now, hoursCalendar(hours, opts.agentDaysOff)) && (opts.promisedSoon === true || promise.kind === "today")) {
    return { at: new Date(now.getTime() + CALLBACK_SOON_MINUTES * 60_000), deferredToMorning: false };
  }
  return { at: promise.startsAt, deferredToMorning: true };
}
