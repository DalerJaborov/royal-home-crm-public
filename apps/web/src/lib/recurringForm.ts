export type RecurringFormResult =
  | { ok: true; amount: number; dayOfMonth: number }
  | { ok: false; error: string };

/**
 * Разбор полей правки шаблона регулярного расхода. Поле суммы текстовое с
 * десятичной клавиатурой, и «1200,50» или «1 200» давали NaN: форма молча
 * отправляла ПРЕЖНЮЮ сумму, закрывалась и выглядела сохранённой (FORMS06). Теперь
 * ввод нормализуется (пробелы и NBSP убираются, запятая становится точкой), а
 * негодное значение возвращает ошибку, и редактор остаётся открытым. Число
 * месяца ограничено 1..28 (как на сервере), без молчаливого зажима.
 */
export function parseRecurringForm(amountInput: string, dayInput: string): RecurringFormResult {
  const amount = Number(amountInput.replace(/[\s\u00a0]/g, "").replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Введите сумму числом больше нуля" };
  }
  const day = Number(dayInput.trim());
  if (!Number.isInteger(day) || day < 1 || day > 28) {
    return { ok: false, error: "Число месяца: от 1 до 28" };
  }
  return { ok: true, amount, dayOfMonth: day };
}
