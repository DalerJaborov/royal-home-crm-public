import type { Query } from "@tanstack/react-query";

/**
 * «ПОКАЗАТЬ ЕЩЁ» НЕ ДОЛЖНО ПУСТИТЬ СПИСОК НА ВРЕМЯ ЗАГРУЗКИ.
 *
 * Номер страницы входит в ключ запроса, поэтому на «Показать ещё» ключ новый, данных
 * по нему нет, и `data` на 0,2–2 секунды становится `undefined`. Экраны рисуют
 * список и кнопку под `data && …` — лента схлопывалась в скелетон, страница
 * укорачивалась, браузер прыгал наверх, и человеку приходилось пролистывать всё
 * заново («обновляет страницу», владелец 30.09.2026). Пока грузится следующая
 * страница, держим на экране предыдущую.
 *
 * Только при том же срезе: сменился фильтр/поиск (отличается что-то, кроме
 * `page`) — старые строки чужого запроса показывать нельзя, отдаём `undefined`.
 */
function withoutPage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPage);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "page") continue;
      out[k] = withoutPage(v);
    }
    return out;
  }
  return value;
}

export function sameSliceIgnoringPage(a: readonly unknown[] | undefined, b: readonly unknown[]): boolean {
  if (!a) return false;
  return JSON.stringify(withoutPage(a)) === JSON.stringify(withoutPage(b));
}

/**
 * Для `placeholderData` хука списка: `placeholderData: keepWhilePaging(key)`,
 * где `key` — тот же ключ, что у самого запроса. Числовой ключ-страница
 * (`["audit-log", 2]`) сравнивается по хвосту так же — см. `pageIndexKey`.
 */
export function keepWhilePaging<T>(key: readonly unknown[]) {
  return (prev: T | undefined, prevQuery: Query<T> | undefined): T | undefined =>
    prev !== undefined && sameSliceIgnoringPage(prevQuery?.queryKey, key) ? prev : undefined;
}

/** Ключи вида `["audit-log", page]`: страница — голое число последним элементом. */
export function keepWhilePagingIndexed<T>(key: readonly unknown[]) {
  const head = key.slice(0, -1);
  return (prev: T | undefined, prevQuery: Query<T> | undefined): T | undefined => {
    const pk = prevQuery?.queryKey;
    if (prev === undefined || !pk || pk.length !== key.length) return undefined;
    return JSON.stringify(pk.slice(0, -1)) === JSON.stringify(head) ? prev : undefined;
  };
}

/**
 * Ключи, где страница — не последний элемент и не поле объекта
 * (`["security", "lost-clients", page, verdict, fault]`): держим прежние данные,
 * если всё, кроме элемента `pageIndex`, совпало.
 */
export function keepWhilePagingAt<T>(key: readonly unknown[], pageIndex: number) {
  const rest = JSON.stringify(key.filter((_, i) => i !== pageIndex));
  return (prev: T | undefined, prevQuery: Query<T> | undefined): T | undefined => {
    const pk = prevQuery?.queryKey;
    if (prev === undefined || !pk || pk.length !== key.length) return undefined;
    return JSON.stringify(pk.filter((_, i) => i !== pageIndex)) === rest ? prev : undefined;
  };
}
