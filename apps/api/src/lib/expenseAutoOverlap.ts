import {
  autoExpenseOverlapText, findAutoExpenseOverlap, type AutoExpenseOverlap, type ManualExpenseLike,
} from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { describeError } from "./describeError.js";
import { loadMoneyContext, type MoneyContext } from "./money.js";
import { logSystemError } from "./systemError.js";

/**
 * Серверная половина правила «автоматический расход руками второй раз не вносится»
 * (packages/shared/src/expenseAutoOverlap.ts — само правило и текст для людей).
 *
 * Прямая сторона — `findManualOverlap` зовёт `createExpense` (одна дверь записи: форма,
 * Шабнам, пачка из фото/Excel, чек из Telegram). Обратная — `warnManualOverlapsForAuto`
 * зовут автоматические строки (реклама, ИИ, зарплата из сделок) при первом появлении за
 * месяц: ручная строка уже была — тревога в журнал ошибок, директор решает, какую убрать.
 */

const MONTH_AUTO_ROWS_LIMIT = 500;

/** "2026-10" → первый день месяца UTC — так месяц хранит Expense. */
const monthDate = (month: string) => new Date(`${month}-01T00:00:00.000Z`);

export interface ManualOverlapResult { overlap: AutoExpenseOverlap; text: string }

type AutoRow = { autoKey: string | null; category: string; amount: unknown; currency: string; exchangeRate: unknown; agentId: string | null };
/** Кэш на одну пачку строк (см. findManualOverlap). */
export interface OverlapCache { rows: Map<string, Promise<AutoRow[]>>; money?: MoneyContext }
export const newOverlapCache = (): OverlapCache => ({ rows: new Map() });

export async function findManualOverlap(
  month: string,
  manual: ManualExpenseLike,
  opts: { db?: TxClient; money?: MoneyContext; cache?: OverlapCache } = {},
): Promise<ManualOverlapResult | null> {
  const db = opts.db ?? prisma;
  const load = () => db.expense.findMany({
    where: { month: monthDate(month), deletedAt: null, autoKey: { not: null } },
    select: { autoKey: true, category: true, amount: true, currency: true, exchangeRate: true, agentId: true },
    take: MONTH_AUTO_ROWS_LIMIT,
  });
  // Пачка из тысячи строк — не тысяча запросов: автоматические строки читаются раз на месяц.
  let pending = opts.cache?.rows.get(month);
  if (!pending) { pending = load(); opts.cache?.rows.set(month, pending); }
  const autoRows = await pending;
  if (!autoRows.length) return null;
  if (opts.cache && !opts.cache.money) opts.cache.money = opts.money ?? await loadMoneyContext(db);
  const money = opts.cache?.money ?? opts.money ?? await loadMoneyContext(db);
  const overlap = findAutoExpenseOverlap(manual, autoRows.map((r) => ({ ...r, autoKey: r.autoKey! })), money.usdToTjs);
  return overlap ? { overlap, text: autoExpenseOverlapText(overlap, month) } : null;
}

/**
 * Автоматическая строка `autoKey` за `month` только что ПОЯВИЛАСЬ. Ручные строки того же
 * месяца, похожие на неё, — в журнал ошибок (одна запись на пару: dedupKey).
 * Ничего не удаляем сами: какая из двух лишняя, решает человек.
 */
export async function warnManualOverlapsForAuto(autoKey: string, month: string): Promise<number> {
  try {
    const auto = await prisma.expense.findUnique({
      where: { autoKey },
      select: { category: true, amount: true, currency: true, exchangeRate: true, agentId: true, deletedAt: true },
    });
    if (!auto || auto.deletedAt) return 0;
    const manual = await prisma.expense.findMany({
      where: { month: monthDate(month), deletedAt: null, autoKey: null },
      select: { id: true, category: true, source: true, agentId: true, note: true, counterparty: true, amount: true, currency: true, exchangeRate: true },
      take: 2000,
    });
    if (!manual.length) return 0;
    const money = await loadMoneyContext();
    let found = 0;
    for (const row of manual) {
      const overlap = findAutoExpenseOverlap(row, [{ ...auto, autoKey }], money.usdToTjs);
      if (!overlap) continue;
      found++;
      void logSystemError("api",
        `Расход, возможно, учтён дважды: ручная строка «${(row.note ?? "").slice(0, 60)}» ${Number(row.amount)} ${row.currency} (id ${row.id}) `
        + `и автоматическая ${autoKey}. ${autoExpenseOverlapText(overlap, month)} Лишнюю строку удалите в Финансы → Расходы.`,
        { dedupKey: `expense-overlap:${autoKey}:${row.id}` });
    }
    return found;
  } catch (err) {
    void logSystemError("api", `Проверка двойного расхода для ${autoKey} не прошла: ${describeError(err)}`);
    return 0;
  }
}
