/**
 * Адрес карточки клиента или объекта в URL: короткий номер (/clients/1042) или
 * настоящий id (UUID).
 *
 * Экраны строят ссылки по короткому номеру, но часть пушей и уведомлений с
 * сервера — «Клиент просит звонок», «Соединяю с клиентом», «Похоже на
 * дубликат», «Новый ролик на монтаж» — вела по UUID, и карточка отвечала «не
 * найден» (аудит 23.09.2026, №12). Уже разосланные пуши не переписать, поэтому
 * читатель понимает оба вида.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function cardWhereFromParam(raw: string): { shortId: number } | { id: string } | null {
  if (UUID_RE.test(raw)) return { id: raw.toLowerCase() };
  const shortId = Number(raw);
  return Number.isInteger(shortId) ? { shortId } : null;
}
