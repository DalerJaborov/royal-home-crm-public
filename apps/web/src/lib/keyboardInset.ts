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

/**
 * ВЫСОТА LAYOUT VIEWPORT — НЕ `window.innerHeight` (21.11.2026, кадр владельца с iPhone, iOS 26).
 *
 * Слои `position: fixed` привязаны к layout viewport, и клавиатуру мы узнаём по тому, насколько видимая
 * область ниже него. Раньше «высотой окна» брали `innerHeight`, но в WebKit на iPhone это высота
 * НЕЗАКРЫТОЙ части окна: с клавиатурой она падает вместе с visualViewport, разница выходила около нуля,
 * и клавиатура считалась закрытой. Переписка тогда вставала на `top: 0`, а Safari сдвигал видимую область
 * вниз на offsetTop — поле ввода улетало к верху экрана, под ним до клавиатуры оставалась пустота
 * (docs/design/oblik-2026-11-17/owner-shots-21-11-1931/04-chat-keyboard.png: отступ поля снизу 42 px —
 * то есть признака клавиатуры на странице не было). ОЦЕНКА по кадру; цифры с телефона даёт /ui-check.
 *
 * `documentElement.clientHeight` — высота начального блока, клавиатура её не трогает ни в Safari, ни в
 * Chrome (по умолчанию resizes-visual). Берём большее из двух: в Chrome без адресной строки `innerHeight`
 * бывает выше `clientHeight`, и тогда правдой является он.
 */
export function layoutViewportHeight(win: { innerHeight: number } = window, doc: { documentElement?: { clientHeight?: number } | null } = document): number {
  return Math.max(win.innerHeight || 0, doc.documentElement?.clientHeight || 0);
}

/**
 * ГДЕ ВИДИМАЯ ОБЛАСТЬ — ОНА ЖЕ КАРКАС ПОЛНОЭКРАННОЙ ПЕРЕПИСКИ (21.11.2026).
 *
 * Слой `position: fixed` с `top: T` виден на экране на высоте `T − visualViewport.offsetTop`. Значит,
 * чтобы каркас стоял ровно в видимой части, его верх — `offsetTop`, высота — `visualViewport.height`.
 * Это верно с клавиатурой и без неё, поэтому от признака «клавиатура открыта» каркас НЕ зависит: ошибка
 * в этом признаке (см. выше) больше не может увести переписку за экран. Отрицательный сдвиг (резиновая
 * прокрутка) обрезаем нулём, сдвиг ниже низа окна (хвост закрывшейся клавиатуры) — до низа окна.
 */
export function visibleFrame(vv: { height: number; offsetTop: number } | null | undefined, layoutHeight: number): { top: number; height: number } {
  if (!vv) return { top: 0, height: Math.round(layoutHeight) };
  // Видимая область не может уйти ниже layout viewport: сдвиг больше «окно − видимая высота» — это хвост
  // закрывшейся клавиатуры (iOS присылает новый offsetTop позже новой высоты), верх тогда прижимаем.
  const maxTop = Math.max(0, layoutHeight - vv.height);
  return { top: Math.round(Math.min(Math.max(0, vv.offsetTop), maxTop)), height: Math.round(vv.height) };
}

let subscribers = 0;
let stop: (() => void) | null = null;

function start(): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => undefined;
  const root = document.documentElement;
  let written = "";
  const apply = () => {
    const k = readKeyboard(layoutViewportHeight(), vv);
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
