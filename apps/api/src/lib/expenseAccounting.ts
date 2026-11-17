import type { Prisma } from "../generated/prisma/client.js";

/**
 * К КАКОЙ ДАТЕ ОТНОСИТСЯ РАСХОД — одно правило для списка расходов за период, помощницы и «Пульса»
 * (аудит денег 17.11.2026, находка «один расход на трёх путях — три даты»).
 *
 * Строка с днём оплаты (`paymentDate`) — к этому дню. Строка без дня — автоматическая за месяц
 * (реклама из кабинета, оценка ИИ, доля по сделкам) — к своему месяцу учёта (`month`), как в «Финансах».
 * Период «01.10–31.10» раньше видел только строки с днём оплаты: 7 822 с. против 16 608 с. «за октябрь».
 *
 * Месячная строка попадает в период, только если период накрывает её месяц ЦЕЛИКОМ: часть месяца
 * («5–20 октября») не может честно взять весь месяц рекламы. Разложение по дням — забота «Пульса»
 * (lib/financePulse.ts считает рекламу и ИИ по дневным источникам).
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Первые числа месяцев (UTC-полночь, как хранит Expense.month), целиком лежащих в [from, to]. */
export function fullMonthKeysWithin(from: string | undefined, to: string | undefined): { gte?: Date; lte?: Date } | null {
  if ((from && !DAY.test(from)) || (to && !DAY.test(to))) return null;
  let first: Date | undefined;
  if (from) {
    const d = new Date(`${from}T00:00:00.000Z`);
    // Месяц, начинающийся не раньше from: если from — первое число, этот же месяц, иначе следующий.
    first = d.getUTCDate() === 1 ? d : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  }
  let last: Date | undefined;
  if (to) {
    const d = new Date(`${to}T00:00:00.000Z`);
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    // Месяц, кончающийся не позже to: если to — последнее число, этот же месяц, иначе предыдущий.
    last = d.getUTCDate() === lastDay ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)) : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  }
  if (first && last && first > last) return null;
  return { ...(first ? { gte: first } : {}), ...(last ? { lte: last } : {}) };
}

/** Фильтр «расходы за период» по правилу выше. */
export function expensePeriodWhere(from: string | undefined, to: string | undefined): Prisma.ExpenseWhereInput {
  const byDay: Prisma.ExpenseWhereInput = {
    paymentDate: { ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}), ...(to ? { lte: new Date(`${to}T00:00:00.000Z`) } : {}) },
  };
  const months = fullMonthKeysWithin(from, to);
  return months ? { OR: [byDay, { paymentDate: null, month: months }] } : byDay;
}
