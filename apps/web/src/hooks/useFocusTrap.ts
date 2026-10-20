import { useEffect, useRef } from "react";

// Render activation order also handles parent/child traps mounted in one commit.
let activationOrder = 0;
const activeTraps: { token: symbol; order: number; node: HTMLElement; returnTo: HTMLElement | null }[] = [];
function topTrap() {
  return activeTraps.reduce<(typeof activeTraps)[number] | undefined>((top, trap) =>
    !top || trap.order > top.order ? trap : top, undefined);
}

/**
 * Удержание фокуса внутри модального окна.
 *
 * ЗАЧЕМ. Окно перекрывает страницу, но клавиша Tab об этом не знает: за окном
 * оставалось два-три десятка кнопок и ссылок фона, и человек, работающий с
 * клавиатуры, «проваливался» из формы в невидимый интерфейс под ней. Дальше он
 * жмёт Enter вслепую и попадает неизвестно куда. Для того, кто пользуется
 * экранным диктором, это не неудобство, а невозможность заполнить форму.
 *
 * ЧТО ДЕЛАЕТ. Заворачивает Tab по кругу внутри окна и возвращает фокус туда,
 * откуда окно открыли, — на кнопку «Клиент», а не в начало страницы.
 *
 * Esc здесь намеренно НЕ обрабатывается: у форм своя логика закрытия с вопросом
 * «данные будут потеряны», и дублировать её тут значило бы завести второй путь
 * закрытия, который однажды разойдётся с первым.
 */
export function useFocusTrap<T extends HTMLElement>(enabled = true) {
  const ref = useRef<T | null>(null);

  // Куда вернуть фокус после закрытия — запоминаем ВО ВРЕМЯ РЕНДЕРА, в момент
  // включения, а не в эффекте. Эффект идёт после commit, а `autoFocus` поля
  // внутри окна срабатывает во время commit: к эффекту activeElement — уже это
  // поле, оно исчезает вместе с окном, и фокус после Esc падал на <body>
  // (проверка 10.09.2026, окно «Новый клиент»). До commit активна ещё кнопка,
  // открывшая окно, — она и нужна.
  const returnToRef = useRef<HTMLElement | null>(null);
  const wasEnabled = useRef(false);
  const orderRef = useRef(0);
  if (enabled && !wasEnabled.current) {
    returnToRef.current = document.activeElement as HTMLElement | null;
    orderRef.current = ++activationOrder;
  }
  wasEnabled.current = enabled;

  useEffect(() => {
    if (!enabled) return;
    const node = ref.current;
    if (!node) return;
    // Элемент может исчезнуть вместе с перерисовкой списка — тогда просто
    // ничего не делаем.
    const token = Symbol("focus-trap");
    const entry = { token, order: orderRef.current, node, returnTo: returnToRef.current };
    activeTraps.push(entry);

    function focusable(): HTMLElement[] {
      if (!node) return [];
      return [...node.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (!node || e.key !== "Tab" || topTrap()?.token !== token) return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;

      // Фокус вне окна (пришёл из фона) — возвращаем внутрь.
      if (!active || !node.contains(active) || active === node) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const wasTop = topTrap()?.token === token;
      const index = activeTraps.findIndex((trap) => trap.token === token);
      if (index !== -1) activeTraps.splice(index, 1);
      // A route can remove the entire modal tree, with parent cleanup first.
      // Its child's opener would then be disconnected: inherit the outer opener.
      for (const trap of activeTraps) {
        if (trap.returnTo && node.contains(trap.returnTo)) trap.returnTo = entry.returnTo;
      }
      // Removing a lower window must never steal focus from its open child.
      if (!wasTop) return;
      const parent = topTrap()?.node;
      const returnTo = entry.returnTo;
      if (returnTo && document.contains(returnTo) && (!parent || parent.contains(returnTo))) {
        returnTo.focus({ preventScroll: true });
      } else if (parent && document.contains(parent)) {
        parent.focus({ preventScroll: true });
      }
    };
  }, [enabled]);

  return ref;
}
