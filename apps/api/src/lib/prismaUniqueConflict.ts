/**
 * Совпало ли нарушенное уникальное ограничение Prisma с полем `field`.
 *
 * Форма `err.meta.target` у P2002 не стабильна и зависит от движка: до Prisma 7
 * это было имя поля (или массив полей), а с драйверным адаптером (`@prisma/adapter-pg`,
 * см. db.ts) `meta.target` не приходит вовсе — вместо него `meta.driverAdapterError`
 * и имя ограничения БД только в тексте `message` («Unique constraint failed on the
 * constraint: `Client_phone_key`»). Проверка, полагавшаяся на один конкретный вид,
 * после перехода на адаптер молча переставала узнавать свою же гонку и пробрасывала
 * 500 вместо идемпотентного ответа (найдено 15.09.2026 полным прогоном тестов —
 * apps/api/tests/website-webhook.test.ts).
 *
 * Поэтому ищем подстроку по всем видам сразу: массив/строка target (если вдруг
 * есть) и текст message (реальный источник сейчас).
 */
export function matchesUniqueConstraint(err: unknown, field: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, meta, message } = err as { code?: string; meta?: { target?: unknown }; message?: string };
  if (code !== "P2002") return false;
  const target = meta?.target;
  const names = Array.isArray(target) ? target.map(String) : typeof target === "string" ? [target] : [];
  if (names.some((n) => n.includes(field))) return true;
  return typeof message === "string" && message.includes(field);
}
