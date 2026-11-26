import { useCallback, useRef } from "react";

/**
 * ПОДГРУЗКА СПИСКА ПРИ ПРОКРУТКЕ БЕЗ КНОПКИ (владелец 26.11.2026: «Показать ещё (N)» убрать, на телефоне и на ПК).
 *
 * Вешается ref-ом на невидимую полоску под последней строкой. Когда полоска подходит к краю прокручиваемой
 * области ближе чем на `MARGIN_PX`, зовётся `onLoadMore`: следующая порция приходит ещё до того, как человек
 * долистал, и список течёт без остановки.
 *
 * Два места, где такие хуки обычно ломаются:
 *  - СПИСОК КОРОТКИЙ. Если после порции полоска всё ещё на виду, IntersectionObserver второй раз сам не сработает
 *    (пересечение не менялось). Поэтому наблюдатель пересоздаётся на каждое изменение `watch` (число строк) и на
 *    каждое включение `active`: новый наблюдатель сообщает текущее состояние сразу.
 *  - ВЛОЖЕННАЯ ПРОКРУТКА. Отступ `rootMargin` работает только от корня наблюдателя, поэтому корнем берётся
 *    ближайший прокручиваемый родитель (колонка списка), а не окно: иначе подгрузка срабатывала бы лишь тогда,
 *    когда полоска уже видна, и список спотыкался бы.
 *
 * `active=false` (идёт загрузка или показано всё) отключает наблюдателя. Нет IntersectionObserver (старый
 * браузер, тест без заглушки) — тихо ничего не делает: список остаётся на первой порции, а не падает.
 */
const MARGIN_PX = 480;

/**
 * Ближайший родитель, который РЕАЛЬНО прокручивается (есть что прокручивать). Тот, у кого `overflow: auto`, но он
 * растёт по содержимому (список на телефоне листает окно), корнем быть не может: он никогда не прокручивается,
 * сторожок в нём всегда «виден», и порции сыпались бы без прокрутки. Тогда корень окно (null).
 */
function scrollParent(node: HTMLElement): Element | null {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const overflowY = getComputedStyle(el).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight + 1) return el;
  }
  return null;
}

export function useLoadMoreSentinel(onLoadMore: () => void, active: boolean, watch: number): (node: HTMLElement | null) => void {
  const latest = useRef(onLoadMore);
  latest.current = onLoadMore;
  const observer = useRef<IntersectionObserver | null>(null);
  // `watch` в зависимостях нарочно: новая функция-ref заставляет React отцепить и снова прицепить узел.
  return useCallback(
    (node: HTMLElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (!node || !active || typeof IntersectionObserver === "undefined") return;
      const next = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) latest.current();
        },
        { root: scrollParent(node), rootMargin: `0px 0px ${MARGIN_PX}px 0px` }
      );
      next.observe(node);
      observer.current = next;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, watch]
  );
}
