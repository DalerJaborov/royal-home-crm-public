/**
 * Курсор следующей страницы ленты с догрузкой «Показать ещё». У курсора ТРИ
 * состояния: undefined (догрузки ещё не было, берём курсор первой страницы),
 * строка (есть следующая) и null (последняя догруженная страница вернула конец).
 * Выражение `extra ?? first` не различало null и undefined: после конца ленты
 * оно снова отдавало курсор первой страницы, кнопка оставалась живой и заново
 * грузила тот же хвост (LOCAL-ONLY-WEB03, аудит 04.10.2026).
 */
export function resolveNextCursor(
  extraCursor: string | null | undefined,
  firstPageCursor: string | null | undefined
): string | null {
  return extraCursor !== undefined ? extraCursor : (firstPageCursor ?? null);
}
