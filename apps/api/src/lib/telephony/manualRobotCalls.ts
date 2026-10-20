import { prisma } from "../../db.js";
import { dushanbeStartOfToday } from "../dushanbeTime.js";

/**
 * ЗВОНКИ РОБОТОМ, ЗАПУЩЕННЫЕ РУКОЙ (02.10.2026, защита робота-консультанта).
 *
 * Два входа, где сотрудник сам велит роботу позвонить: «Звонок роботом» в
 * карточке клиента (routes/clients/communications.ts) и проверочный звонок в
 * Настройках → «Живой голос» (routes/settings.ts). Звонок реальный и платный, а
 * проверочный — на ЛЮБОЙ таджикский номер. До этой правки ни один из них не
 * оставлял следа: кто, кому и сколько раз звонил роботом, не знал никто.
 *
 * Теперь каждая попытка ложится в журнал действий (logAudit — одним из двух
 * действий ниже), и по тому же журналу считается суточный предел на сотрудника.
 * Предел — грубая защита от ошибки и злоупотребления (зависшая вкладка, обида на
 * клиента), а не квота работы: тридцать звонков роботом в день руками — больше,
 * чем нужно руководителю. Запись в журнал идёт «в отрыве» (lib/audit.ts), поэтому
 * предел мягкий: пара запросов в одну и ту же секунду может проскочить на один
 * звонок дальше — для этой цели это неважно.
 */

export const MANUAL_ROBOT_CALLS_PER_DAY = 30;

/** Действия журнала, по которым считается предел. */
export const MANUAL_ROBOT_CALL_ACTIONS = ["LIVE_VOICE_CALL_CLIENT", "LIVE_VOICE_TEST_CALL"] as const;

export const MANUAL_ROBOT_CALL_LIMIT_ERROR =
  `Сегодня вы уже запускали звонок роботом ${MANUAL_ROBOT_CALLS_PER_DAY} раз — это предел на день. ` +
  "Счётчик обнулится в полночь по Душанбе.";

/** Достиг ли сотрудник суточного предела (сутки — по Душанбе). */
export async function manualRobotCallLimitReached(agentId: string): Promise<boolean> {
  const count = await prisma.auditLog.count({
    where: { agentId, action: { in: [...MANUAL_ROBOT_CALL_ACTIONS] }, createdAt: { gte: dushanbeStartOfToday() } },
  });
  return count >= MANUAL_ROBOT_CALLS_PER_DAY;
}
