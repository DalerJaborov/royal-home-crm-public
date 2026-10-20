/**
 * Человекочитаемая причина отказа fetch.
 *
 * У сетевых сбоев `message` — это всегда «fetch failed», а настоящая причина
 * (ENOTFOUND, ECONNREFUSED, истёкший сертификат) лежит в `cause`. Без неё запись
 * в журнале не отличала недоступный домен от отказа Meta — на этом однажды потеряли
 * вечер, разбираясь, почему Instagram «принимает, но молчит».
 *
 * Живёт отдельным модулем, а не в messengers/meta.ts, где появилась изначально:
 * загрузчик вложений тоже пишет ей причину в журнал, а meta.ts в свою очередь берёт
 * у загрузчика тип источника — получался цикл импортов. Тип при компиляции стирается,
 * поэтому сборка и тесты цикла не замечали, и его поймала только проверка
 * зависимостей (`npm run audit:deps`).
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (!cause) return err.message;
  const detail = cause instanceof Error ? `${(cause as { code?: string }).code ?? ""} ${cause.message}`.trim() : String(cause);
  return detail ? `${err.message} (${detail})` : err.message;
}
