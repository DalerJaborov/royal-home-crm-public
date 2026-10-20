import { useRef } from "react";
import { mergePageSlots, putPage, type PageSlots } from "../lib/accumulatePages";

/**
 * МЯГКАЯ ПОДГРУЗКА ВМЕСТО СТРАНИЦ (решение владельца, 15.09.2026): «Показать
 * ещё» дописывает строки в конец ленты, а не заменяет список — сервер как
 * отдавал `page`/`pageSize`, так и отдаёт, копим на клиенте.
 *
 * Общий хук, а не копия в каждом экране: при росте `page` новая страница
 * встаёт в хвост, при смене `resetKey` (фильтр, поиск, срез) накопленное
 * сбрасывается и лента начинается заново со страницы 1.
 *
 * СВЕЖИЙ ОТВЕТ ЗАМЕНЯЕТ СВОЮ СТРАНИЦУ (аудит 23.09.2026, №38). Раньше при
 * `page > 1` перечитанная страница выбрасывалась, чтобы не задвоить строки, а
 * первую страницу после «Показать ещё» никто не перечитывал: чаты, клиенты,
 * звонки и комментарии замирали до смены фильтра. Теперь у каждой страницы
 * своя ячейка (lib/accumulatePages.ts), а `head` — свежая первая страница
 * того же запроса: экран держит её подписанной вторым вызовом того же хука
 * данных с `page: 1` (при `page = 1` это тот же самый запрос, лишнего похода
 * на сервер нет).
 *
 * Сравниваем по ССЫЛКЕ на массивы: React Query отдаёт новый массив на каждый
 * успешный (пере)запрос — так ловится именно свежий ответ (16.09.2026: список
 * замирал пустым, пока первая страница не переписывалась свежим ответом).
 */
export function useAccumulatedPages<T>(
  items: T[] | undefined,
  page: number,
  resetKey: unknown,
  head?: T[] | undefined
): T[] {
  const slotsRef = useRef<PageSlots<T>>(new Map());
  const keyRef = useRef(resetKey);
  const itemsRef = useRef<T[] | undefined>(undefined);
  const headRef = useRef<T[] | undefined>(undefined);
  const mergedRef = useRef<T[]>([]);

  if (keyRef.current !== resetKey) {
    keyRef.current = resetKey;
    slotsRef.current = new Map();
    itemsRef.current = undefined;
    headRef.current = undefined;
    mergedRef.current = [];
  }

  let changed = false;
  if (items && items !== itemsRef.current) {
    itemsRef.current = items;
    // Первая страница — голова ленты: пришла заново без «Показать ещё» — лента с нуля.
    slotsRef.current = page <= 1 ? new Map([[1, items]]) : putPage(slotsRef.current, page, items);
    changed = true;
  }
  if (head && page > 1 && head !== headRef.current) {
    headRef.current = head;
    slotsRef.current = putPage(slotsRef.current, 1, head);
    changed = true;
  }
  if (changed) mergedRef.current = mergePageSlots(slotsRef.current);

  return mergedRef.current;
}
