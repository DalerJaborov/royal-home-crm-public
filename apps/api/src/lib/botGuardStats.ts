import type { BotGuardDropShare, BotGuardStatsResponse } from "@royal-home/shared";
import { prisma } from "../db.js";
import { GUARD_LABELS, type GuardName } from "../ai/guardMetrics.js";
import { dushanbeDateString } from "./dushanbeTime.js";
import { summarizeCustomerAgentAnswerDay, summarizeCustomerAgentSayDay } from "./customerAgentSayStats.js";

/**
 * СВОД СЧЁТЧИКОВ ФИЛЬТРОВ ЗА ОКНО — для Настроек → «Бот» → «Проверка бота».
 *
 * Раньше это отдавал /bot-training/guard-stats экрана «Обучение бота» (удалён
 * 23.11.2026). Доли нового помощника считают ТЕ ЖЕ чистые функции, что и дневная
 * строка владельцу (lib/customerAgentSayStats.ts): намеренно выключенное в долю не
 * входит — одно правило на строку в журнале и на экран.
 */
export const BOT_GUARD_STATS_DAYS = 14;

const toPercent = (share: number) => Math.round(share * 100);

export function summarizeBotGuardStats(rows: readonly { guard: string; count: number }[], days = BOT_GUARD_STATS_DAYS): BotGuardStatsResponse {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.guard, (totals.get(row.guard) ?? 0) + row.count);
  const summed = [...totals.entries()].map(([guard, count]) => ({ guard, count }));

  const sayDay = summarizeCustomerAgentSayDay(summed);
  const answerDay = summarizeCustomerAgentAnswerDay(summed);
  const say: BotGuardDropShare = {
    total: sayDay.total, dropped: sayDay.dropped, sharePercent: toPercent(sayDay.share),
    intentional: sayDay.intentional, reasons: sayDay.reasons,
  };
  return {
    days,
    say,
    answer: {
      total: answerDay.total, dropped: answerDay.dropped, sharePercent: toPercent(answerDay.share),
      intentional: answerDay.intentional, reasons: answerDay.reasons, factAttempts: answerDay.factAttempts,
    },
    // Вердикты помощника уже сведены в доли выше; в полосах — только фильтры, чинящие ответ.
    filters: summed
      .filter((row) => row.count > 0 && !row.guard.startsWith("say_") && !row.guard.startsWith("answer_"))
      // Неизвестный ключ (фильтр переименовали, а в базе старые строки) — как есть: честнее пропуска.
      .map((row) => ({ guard: row.guard, label: GUARD_LABELS[row.guard as GuardName] ?? row.guard, count: row.count }))
      .sort((a, b) => b.count - a.count),
  };
}

/**
 * Сумма по фильтру считается в базе, а не по строкам «день × фильтр»: фильтров под
 * сотню, за 14 дней это больше тысячи строк, и прежний предел в 500 строк молча
 * отрезал самые старые дни из суммы. Граница окна — по Душанбе, как и ключ дня
 * (ai/guardMetrics.ts::guardFired).
 */
export async function loadBotGuardStats(days = BOT_GUARD_STATS_DAYS): Promise<BotGuardStatsResponse> {
  const from = dushanbeDateString(new Date(Date.now() - (days - 1) * 86_400_000));
  const grouped = await prisma.guardHit.groupBy({ by: ["guard"], where: { day: { gte: from } }, _sum: { count: true } });
  return summarizeBotGuardStats(grouped.map((row) => ({ guard: row.guard, count: row._sum.count ?? 0 })), days);
}
