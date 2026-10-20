/**
 * СБОРКА ЛЕНТЫ ИЗ СТРАНИЦ (аудит 23.09.2026, №38) — чистая часть
 * hooks/useAccumulatedPages.ts, вынесена, чтобы её можно было проверить тестом.
 *
 * Каждая страница хранится в своей ячейке, и свежий ответ по странице
 * ЗАМЕНЯЕТ её ячейку. Раньше после «Показать ещё» перечитанная страница
 * выбрасывалась, а первая не перечитывалась вовсе: новые сообщения, звонки и
 * клиенты не появлялись, пока человек не сменит фильтр.
 */
export type PageSlots<T> = Map<number, T[]>;

function idOf(item: unknown): unknown {
  return item && typeof item === "object" && "id" in item ? (item as { id: unknown }).id : undefined;
}

/**
 * Лента по порядку страниц. Строка, у которой есть `id`, показывается один раз:
 * когда наверху появилось новое, строки сползают вниз, и последняя строка
 * первой страницы оказывается ещё и первой строкой второй. Побеждает верхняя
 * (более свежая) копия.
 */
export function mergePageSlots<T>(slots: PageSlots<T>): T[] {
  const pages = [...slots.keys()].sort((a, b) => a - b);
  const seen = new Set<unknown>();
  const out: T[] = [];
  for (const p of pages) {
    for (const item of slots.get(p) ?? []) {
      const id = idOf(item);
      if (id !== undefined) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      out.push(item);
    }
  }
  return out;
}

/** Страница `page` пришла заново — её ячейка заменяется, остальные не трогаются. */
export function putPage<T>(slots: PageSlots<T>, page: number, items: T[]): PageSlots<T> {
  const next: PageSlots<T> = new Map(slots);
  next.set(Math.max(1, page), items);
  return next;
}
