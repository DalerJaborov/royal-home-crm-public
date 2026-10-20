/**
 * Итог публикации на сайт по строкам ответа `bulk-sync`. Сервер отвечает 200 и
 * по строке на объект, поэтому отказ по объекту (`ok: false`) приходит как
 * УСПЕХ запроса, и общий тост рапортовал «Сохранено» поверх неудачи (аудит
 * 04.10.2026, WEB-PAGES20). `null` — всё прошло.
 */
export function siteSyncFailureText(results: { ok: boolean; error?: string | null }[]): string | null {
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return null;
  const reason = failed[0].error ?? "Не удалось синхронизировать с сайтом";
  return results.length > 1 ? `${failed.length} из ${results.length} объектов не синхронизированы: ${reason}` : reason;
}
