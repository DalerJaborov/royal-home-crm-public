import { prisma } from "../db.js";
import { BOT_NAMES_ASSIGNED_AGENT, callbackPromise, loadClientHours } from "../ai/agencyFacts.js";

/**
 * ЧТО БОТ ОБЕЩАЕТ ПРИ ПЕРЕДАЧЕ ЗАЯВКИ (решение Dan 02.10.2026, карточка «Имя и
 * срок»). Живой менеджер говорит «вам позвонит Фарход сегодня», а ночью — «завтра
 * после 9:30». Прежнее безликое «агент скоро свяжется» ночью было неправдой: заявка
 * ждёт утренней раздачи.
 *
 * С 10.10.2026 (аудит «одно окно», P1-1) срок решает ОДНА функция на чат и голос —
 * ai/agencyFacts.ts::callbackPromise: с выходными из Настроек (11.10.2026: общие и личные
 * того агента, кому ушла заявка), с тем же источником часов (CLIENT_HOURS) и без «в течение часа» (по данным
 * 10.10 такой срок выдерживался в половине случаев). Называть ли имя агента — флаг
 * BOT_NAMES_ASSIGNED_AGENT там же. Обещанный срок держит не эта функция, а окно первого
 * звонка по принятой заявке (services/leads/firstCall.ts) — второй задачи не заводим.
 */
export type CallWhen = { ru: string; tg: string };

/** Срок звонка словами — тонкая обёртка над общим решением (для прежних вызовов и тестов). */
export function callWhenPhrase(start: string, end: string, at: Date = new Date()): CallWhen {
  const p = callbackPromise(at, { start, end });
  return { ru: p.ru, tg: p.tg };
}

/** Указание модели: кто и когда позвонит. Имя — только того, кому заявка уже ушла. */
export async function handoffInstruction(clientId: string, at: Date = new Date()): Promise<string> {
  const [hours, client] = await Promise.all([
    loadClientHours(),
    BOT_NAMES_ASSIGNED_AGENT
      ? prisma.client
          .findUnique({ where: { id: clientId }, select: { assignedAgent: { select: { fullName: true, weeklyDaysOff: true } } } })
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  // Звонить будет агент, кому ушла заявка: его выходной — его следующий рабочий день.
  const when = callbackPromise(at, hours, client?.assignedAgent?.weeklyDaysOff);
  const full = client?.assignedAgent?.fullName?.trim();
  const name = full ? full.split(/\s+/)[0] : null;
  const who = name ? `клиенту позвонит наш агент ${name}` : "клиенту позвонит наш агент";
  return (
    `Одной короткой фразой повтори, что клиент ищет (по черновику заявки, без выдумок), и скажи, что ${who} ` +
    `${when.ru} (по-таджикски: «${when.tg}»). Других имён и сроков не придумывай, «скоро», «прямо сейчас» и минуты не пиши.`
  );
}
