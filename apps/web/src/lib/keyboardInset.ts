/**
 * Экранная клавиатура телефона — ОДНО место, где она считается (21.11.2026, аудит К07).
 *
 * ПРОБЛЕМА. Клавиатура iOS и Android поднимает только visualViewport и не двигает layout viewport,
 * а слои `position: fixed` (нижнее меню, шторки) привязаны именно к layout viewport. Поэтому при
 * фокусе в поле нижнее меню оставалось над клавиатурой, а подвал шторки с «Сохранить» уходил под неё.
 * Считали это в четырёх местах по-разному (ассистент, переписка, шторка, чистая оболочка).
 *
 * ЧТО ОТДАЁТ. На <html>:
 *  - `--rh-kb-inset` — px от низа layout viewport до верха клавиатуры (0, пока её нет): `bottom:` шторки;
 *  - `--rh-vv-h` — высота видимой области в px, пока клавиатура открыта: потолок высоты шторки;
 *  - `data-kb-open` — признак «клавиатура открыта»: им CSS прячет нижнее меню везде разом.
 * Счётчик подписчиков: окна открываются друг над другом, а переменные снимает последний ушедший.
 */

/** Видимая область ниже окна меньше чем на столько px — это дрожание адресной строки, не клавиатура. */
export const KEYBOARD_MIN_SHRINK = 140;

export interface KeyboardReading {
  open: boolean;
  /** px от низа layout viewport до верха клавиатуры. */
  inset: number;
  /** Высота видимой области. */
  height: number;
}

export function readKeyboard(innerHeight: number, vv: { height: number; offsetTop: number; scale?: number }): KeyboardReading {
  const shrink = innerHeight - vv.height;
  // Щипок (zoom) тоже уменьшает видимую область, но клавиатурой не является.
  const zoomed = (vv.scale ?? 1) > 1.02;
  const open = !zoomed && shrink > KEYBOARD_MIN_SHRINK;
  // Порога на сам отступ нет: если клавиатура уже признана открытой, шторку поднимаем ровно на её высоту,
  // даже когда Safari сдвинул видимую область почти на всю клавиатуру (остаток в 56 px — это настоящие 56 px).
  // Дрожание адресной строки отсекает KEYBOARD_MIN_SHRINK выше, а не этот расчёт.
  const raw = Math.max(0, Math.round(shrink - vv.offsetTop));
  return { open, inset: open ? raw : 0, height: Math.round(vv.height) };
}

let subscribers = 0;
let stop: (() => void) | null = null;

function start(): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => undefined;
  const root = document.documentElement;
  let written = "";
  const apply = () => {
    const k = readKeyboard(window.innerHeight, vv);
    const key = `${k.open}|${k.inset}|${k.height}`;
    if (key === written) return;
    written = key;
    root.style.setProperty("--rh-kb-inset", `${k.inset}px`);
    if (k.open) {
      root.style.setProperty("--rh-vv-h", `${k.height}px`);
      root.dataset.kbOpen = "1";
    } else {
      root.style.removeProperty("--rh-vv-h");
      delete root.dataset.kbOpen;
    }
  };
  // iOS присылает resize видимой области уже ПОСЛЕ закрытия клавиатуры: через 350 мс после focusout — запасной пересчёт.
  let lateTimer: ReturnType<typeof setTimeout> | undefined;
  const onFocusOut = () => { clearTimeout(lateTimer); lateTimer = setTimeout(apply, 350); };
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  document.addEventListener("focusout", onFocusOut);
  apply();
  return () => {
    clearTimeout(lateTimer);
    vv.removeEventListener("resize", apply);
    vv.removeEventListener("scroll", apply);
    document.removeEventListener("focusout", onFocusOut);
    root.style.removeProperty("--rh-kb-inset");
    root.style.removeProperty("--rh-vv-h");
    delete root.dataset.kbOpen;
  };
}

/** Подписаться на клавиатуру; возвращает отписку. Без React — для тестов и кода вне компонентов. */
export function trackKeyboard(): () => void {
  subscribers += 1;
  if (subscribers === 1) stop = start();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    subscribers = Math.max(0, subscribers - 1);
    if (subscribers === 0) { stop?.(); stop = null; }
  };
}
