/**
 * ПРИБЫЛЬ КОМПАНИИ — ОДНО ПРАВИЛО НА ВСЮ CRM (глубокая проверка 02.10.2026, C2).
 *
 *   прибыль = доля компании в комиссии − расходы, КРОМЕ строк «Зарплата из сделок».
 *
 * Почему так. Доход компании везде считается уже БЕЗ доли риелтора (снапшот
 * commissionCompanyAmount). А ночной крон 1-го числа заводит на каждого агента
 * строку SALARY с autoKey `salary:<агент>:<месяц>` — это ТЕ ЖЕ доли риелторов
 * (lib/financeAutomation.ts, upsertSalaryExpenses). Вычитать их второй раз
 * значило проваливать прибыль закрытого месяца в ноль 1-го числа следующего, а
 * «Заработали сегодня» на пульте — в минус на всю зарплату.
 *
 * Строки зарплаты, заведённые РУКАМИ (офис, бухгалтер), — настоящий расход и в
 * прибыль идут как обычно: исключаются только авто-строки долей из сделок.
 *
 * Пользуются: «Финансы» (routes/expenses.ts /summary), «Пульс» и «Заработали
 * сегодня» (lib/financePulse.ts), ИИ-ассистент (ai/assistant.ts), прогноз
 * расходов (lib/financeAutomation.ts). Новое место, где считается прибыль, —
 * только через эти функции.
 */

/** Префикс autoKey строки «Зарплата из сделок» (доля агента за месяц). */
export const DEAL_SALARY_AUTO_KEY_PREFIX = "salary:";

/** autoKey строки зарплаты из сделок для агента за месяц («2026-08»). */
export function dealSalaryAutoKey(agentId: string, month: string): string {
  return `${DEAL_SALARY_AUTO_KEY_PREFIX}${agentId}:${month}`;
}

/** Строка расхода — это авто-зарплата из долей сделок (уже вычтена из дохода компании)? */
export function isDealSalaryExpense(expense: { autoKey?: string | null }): boolean {
  return typeof expense.autoKey === "string" && expense.autoKey.startsWith(DEAL_SALARY_AUTO_KEY_PREFIX);
}
