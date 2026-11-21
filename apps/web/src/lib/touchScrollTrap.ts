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

/** Ось жеста фиксируется, когда палец ушёл от точки касания на столько px, и не меняется до отпускания. */
export const AXIS_LOCK_PX = 7;

export type Axis = "x" | "y";

/** Прокручиваемый блок на пути пальца (от ближнего к дальнему), снятый один раз на касание. */
export interface ScrollLink {
  el: { scrollTop: number; scrollLeft: number };
  y: boolean;
  x: boolean;
  maxTop: number;
  maxLeft: number;
}

/** Ось жеста: зафиксированная — она; иначе по текущему смещению от точки касания (вертикаль при равенстве). */
export function gestureAxis(locked: Axis | null, dx: number, dy: number): { axis: Axis; lock: Axis | null } {
  if (locked) return { axis: locked, lock: locked };
  const axis: Axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
  return { axis, lock: Math.max(Math.abs(dx), Math.abs(dy)) >= AXIS_LOCK_PX ? axis : null };
}

/** Может ли блок ехать вдоль оси в сторону движения пальца (`delta > 0` — палец вниз/вправо, к началу). */
function canMove(link: ScrollLink, axis: Axis, delta: number): boolean {
  if (axis === "y") {
    if (!link.y) return false;
    const top = link.el.scrollTop;
    return delta > 0 ? top > 0 : top < link.maxTop - 1;
  }
  if (!link.x) return false;
  const left = Math.abs(link.el.scrollLeft);
  return delta > 0 ? left > 0 : left < link.maxLeft - 1;
}

/**
 * Гасить ли шаг движения. `delta` — шаг пальца вдоль оси жеста с прошлого движения. Жест отдаём первому блоку
 * цепочки, который в эту сторону ещё может ехать: упёрлось поле ввода или вложенная лента — едет следующий
 * прокручиваемый предок (так ведёт себя и сам браузер). Не может никто — гасим: за окном двигать нечего, иначе
 * поехала бы видимая область.
 */
export function shouldBlockTouchMove(axis: Axis, delta: number, chain: readonly ScrollLink[]): boolean {
  if (Math.abs(delta) < 0.5) return false;
  return !chain.some((link) => canMove(link, axis, delta));
}

/**
 * Цепочка прокручиваемых предков от цели касания до `<body>` (саму страницу не берём — она заблокирована).
 * Считается ОДИН раз на касание: стили и размеры не читаем на каждом кадре движения, только `scrollTop`.
 */
export function scrollChainFrom(target: EventTarget | null): ScrollLink[] {
  const chain: ScrollLink[] = [];
  let node = target instanceof Element ? target : null;
  while (node && node !== document.body && node !== document.documentElement) {
    if (node instanceof HTMLElement) {
      const style = getComputedStyle(node);
      const maxTop = node.scrollHeight - node.clientHeight;
      const maxLeft = node.scrollWidth - node.clientWidth;
      const y = (/(auto|scroll)/.test(style.overflowY) || node instanceof HTMLTextAreaElement) && maxTop > 1;
      const x = /(auto|scroll)/.test(style.overflowX) && maxLeft > 1;
      if (y || x) chain.push({ el: node, y, x, maxTop, maxLeft });
    }
    node = node.parentElement;
  }
  return chain;
}

const NOT_TEXT_INPUTS = ["checkbox", "radio", "button", "submit", "reset", "file", "range", "color", "image"];

/** Поле, где палец двигает курсор или выделение. */
function isTextField(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !NOT_TEXT_INPUTS.includes(el.type);
  return el instanceof HTMLElement && el.isContentEditable === true;
}

/** Идёт ли выделение текста (в поле или на странице) — его ручки двигает палец, мешать нельзя. */
function selectingText(target: Element | null): boolean {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    try {
      if (target.selectionStart !== null && target.selectionStart !== target.selectionEnd) return true;
    } catch {
      /* у части типов input нет selectionStart */
    }
  }
  const sel = typeof window.getSelection === "function" ? window.getSelection() : null;
  return !!sel && !sel.isCollapsed;
}

/**
 * Касание, которое не трогаем вовсе (решается на старте; масштаб и второй палец проверяются и на ходу):
 *  - два пальца (щипок) и увеличенная страница (`visualViewport.scale > 1.01`): палец водит по увеличенному
 *    фото или тексту, и гасить это — значит запереть человека в углу картинки (ревью #375);
 *  - ползунки и области со своим жестом (`data-allow-touchmove`);
 *  - выделение текста: ручки выделения ведёт палец.
 */
export function touchIsExempt(event: TouchEvent, viewportScale: number | undefined): boolean {
  if (event.touches.length > 1) return true;
  if ((viewportScale ?? 1) > 1.01) return true;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("input[type=range], [data-allow-touchmove]")) return true;
  return selectingText(target);
}

/** Горизонтальный жест по полю ввода — это курсор (iOS двигает его пальцем), а не прокрутка: не трогаем. */
export function cursorGesture(target: EventTarget | null, axis: Axis): boolean {
  return axis === "x" && isTextField(target instanceof Element ? target : null);
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
