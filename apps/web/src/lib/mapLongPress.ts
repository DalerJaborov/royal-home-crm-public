/**
 * Долгое нажатие на пустом месте карты объектов — «завести объект здесь»
 * (PropertyMapExplorer.tsx). Вынесено из компонента 24.09.2026 вместе с
 * починкой, чтобы правило проверялось тестом без браузера.
 *
 * ЧТО БЫЛО НЕ ТАК (Дэн 24.09.2026, «16 известных поломок карты»):
 *   1. Щипок двумя пальцами открывал мастер нового объекта. Каждый touchstart
 *      заводил свой таймер, второй палец ПЕРЕЗАПИСЫВАЛ ссылку на таймер, не
 *      погасив первый, — и первый, уже ничем не отменяемый, срабатывал через
 *      550 мс посреди обычного масштабирования.
 *   2. Палец, задержанный на плашке цены или кластера (это DOM-маркеры внутри
 *      той же обёртки холста, их mousedown/touchstart долетает до карты), тоже
 *      уводил в мастер — вместо того чтобы открыть сам объект.
 * Поэтому: любой новый старт сначала гасит прежний таймер; второй палец жест
 * отменяет, а не начинает; старт считается только с самого холста.
 */

/** Можно ли начинать отсчёт долгого нажатия для этого касания/нажатия мыши. */
export function longPressAllowed(p: { touchCount: number; onCanvas: boolean }): boolean {
  return p.onCanvas && p.touchCount <= 1;
}

export interface LongPressPointer {
  x: number;
  y: number;
  /** Сколько пальцев на экране сейчас (0 — мышь). */
  touchCount: number;
  /** Нажатие пришлось на сам холст, а не на DOM-маркер поверх него. */
  onCanvas: boolean;
}

export function createLongPress<T>(opts: { delayMs: number; moveTolerancePx: number; onFire: (payload: T) => void }) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: { x: number; y: number } | null = null;
  let fired = false;

  const cancel = () => {
    if (timer != null) clearTimeout(timer);
    timer = null;
    start = null;
  };

  return {
    start(p: LongPressPointer, payload: T) {
      // Сначала погасить прежний отсчёт — ровно то, чего не хватало второму пальцу.
      cancel();
      fired = false;
      if (!longPressAllowed(p)) return;
      start = { x: p.x, y: p.y };
      timer = setTimeout(() => {
        timer = null;
        start = null;
        fired = true;
        opts.onFire(payload);
      }, opts.delayMs);
    },
    move(p: { x: number; y: number; touchCount: number }) {
      if (p.touchCount > 1) {
        cancel();
        return;
      }
      if (!start) return;
      if (Math.hypot(p.x - start.x, p.y - start.y) > opts.moveTolerancePx) cancel();
    },
    cancel,
    /** Долгое нажатие сработало — обычный клик того же жеста (mouseup после
     *  таймера) пропускается. Читается один раз: следующий клик уже обычный. */
    consumeFired(): boolean {
      const was = fired;
      fired = false;
      return was;
    },
  };
}
