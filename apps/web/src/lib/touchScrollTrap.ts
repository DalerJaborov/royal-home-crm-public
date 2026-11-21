/**
 * ПРОКРУТКА НЕ «ПРОВАЛИВАЕТСЯ» ПОД ОКНО (21.11.2026, владелец с iPhone: «когда делаешь вниз, палец как
 * будто в другое окно идёт и его вниз-вверх двигает»).
 *
 * Пока открыто окно (шторка, полноэкранная переписка), страница под ним заблокирована (useScrollLock), но
 * iPhone двигает и то, что блокировкой не закрыть:
 *  - при открытой клавиатуре видимая область меньше окна, и палец, ведущий по шапке, полю ввода или по
 *    ленте, упёршейся в край, тащит саму видимую область — вместе с ней «плывёт» вся переписка;
 *  - лента или тело шторки, докрученные до края, отдают жест наружу (резинка всего экрана).
 * `overscroll-behavior: contain` второе гасит только у блока, которому есть куда прокручиваться, а первое
 * не гасит вовсе. Как в нативных мессенджерах: жест двигает только ближайшую ленту, которая в эту сторону
 * ещё может ехать; всё остальное движение пальца гасится (`preventDefault` на `touchmove`).
 *
 * Здесь — только решение (чистая функция, её проверяет vitest); слушатель ставит useScrollLock.
 */

/** Блок с прокруткой на пути пальца, от ближнего к дальнему. */
export interface ScrollBox {
  /** Можно ли прокручивать по вертикали (overflow-y auto/scroll и есть что прокручивать). */
  y: boolean;
  /** Можно ли прокручивать по горизонтали. */
  x: boolean;
  top: number;
  maxTop: number;
  left: number;
  maxLeft: number;
}

/**
 * Гасить ли движение пальца. `dx`/`dy` — смещение от точки касания (палец вниз — `dy > 0`, то есть
 * содержимое едет к своему началу). Решает ближайший блок, который прокручивается по главной оси жеста:
 * едет в эту сторону — пропускаем, упёрся в край — гасим (дальше по цепочке жест не отдаём). Такого блока
 * нет вовсе — гасим: двигать за окном нечего, а иначе двигалась бы видимая область.
 */
export function shouldBlockTouchMove(dx: number, dy: number, boxes: readonly ScrollBox[]): boolean {
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return false;
  const vertical = Math.abs(dy) >= Math.abs(dx);
  const box = boxes.find((b) => (vertical ? b.y : b.x));
  if (!box) return true;
  if (vertical) return dy > 0 ? box.top <= 0 : box.top >= box.maxTop - 1;
  return dx > 0 ? box.left <= 0 : box.left >= box.maxLeft - 1;
}

/** Цепочка прокручиваемых блоков от цели касания вверх, до `<body>` (саму страницу не берём — она заблокирована). */
export function scrollBoxesFrom(target: EventTarget | null): ScrollBox[] {
  const boxes: ScrollBox[] = [];
  let node = target instanceof Element ? target : null;
  while (node && node !== document.body && node !== document.documentElement) {
    if (node instanceof HTMLElement) {
      const style = getComputedStyle(node);
      const scrollableY = /(auto|scroll)/.test(style.overflowY) || node instanceof HTMLTextAreaElement;
      const scrollableX = /(auto|scroll)/.test(style.overflowX);
      const maxTop = node.scrollHeight - node.clientHeight;
      const maxLeft = node.scrollWidth - node.clientWidth;
      const y = scrollableY && maxTop > 1;
      const x = scrollableX && maxLeft > 1;
      if (y || x) boxes.push({ y, x, top: node.scrollTop, maxTop, left: Math.abs(node.scrollLeft), maxLeft });
    }
    node = node.parentElement;
  }
  return boxes;
}

/** Касания, которые не трогаем вовсе: щипок двумя пальцами, ползунки, области со своим жестом. */
export function touchIsExempt(event: TouchEvent): boolean {
  if (event.touches.length > 1) return true;
  const target = event.target instanceof Element ? event.target : null;
  return !!target?.closest('input[type="range"], [data-allow-touchmove]');
}

/**
 * Касание пришло из СВОЕГО DOM, а не из окна-портала, открытого поверх (21.11.2026).
 *
 * Шторки рисуются порталом в <body>, но React ведёт их события по дереву JSX — к тому, кто окно открыл:
 * к строке со смахиванием, к шторке-родителю, к «потянуть-обновить». Без этой проверки палец во внутреннем
 * окне двигал то, что лежит под ним. Одна проверка на все жесты на React-обработчиках касаний.
 */
export function touchFromOwnDom(event: { currentTarget: EventTarget | null; target: EventTarget | null }): boolean {
  const own = event.currentTarget;
  return own instanceof Node && event.target instanceof Node && own.contains(event.target);
}
