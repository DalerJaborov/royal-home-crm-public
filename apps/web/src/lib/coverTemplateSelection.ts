/**
 * Новый список «участвует в выборе» после клика по отметке. Список всегда
 * строится от ТЕКУЩИХ отметок: если они устарели (после прошлой правки список
 * шаблонов не перечитан), второй PATCH возвращает то, что только что сняли
 * (аудит 04.10.2026, WEB-PAGES11). Поэтому раздел перечитывает список после
 * каждой правки и не даёт кликать, пока он перечитывается.
 *
 * `null` — снять последнюю отметку нельзя, хотя бы один шаблон участвует.
 */
export function nextEnabledIds(templates: { id: string; enabled: boolean }[], id: string, enabled: boolean): string[] | null {
  const current = templates.filter((t) => t.enabled).map((t) => t.id);
  const next = enabled ? [...new Set([...current, id])] : current.filter((x) => x !== id);
  return next.length === 0 ? null : next;
}
