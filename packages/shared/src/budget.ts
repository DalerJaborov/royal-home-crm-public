/**
 * Бюджет клиента 0, пустая строка или отрицательный — «не указан», а не «до 0 сомони» (21.11.2026).
 * Сервер превращает такую запись в null при записи (db.ts), а читающие места — этой функцией,
 * потому что в базе уже могли остаться нули (Decimal приходит строкой «0.00», она истинна).
 */
export function positiveBudget(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
