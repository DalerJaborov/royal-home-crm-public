/**
 * Склейка ленты звонков из голов и страниц «Показать ещё». Строки одной
 * страницы заменяют одноимённые из предыдущих, поэтому свежая голова ставится
 * ПОСЛЕДНЕЙ: перечитанная голова несёт новые расшифровки и новые звонки и не
 * должна проиграть старой копии из страницы глубже (аудит 04.10.2026,
 * WEB-PAGES03). Лента всегда отсортирована по времени, новое сверху.
 */
export function mergeCallFeed<T extends { id: string; at: string }>(prev: T[], ...pagesOldestFirst: (T[] | undefined)[]): T[] {
  const byId = new Map(prev.map((r) => [r.id, r]));
  for (const page of pagesOldestFirst) {
    for (const row of page ?? []) byId.set(row.id, row);
  }
  return [...byId.values()].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}
