import { useSyncExternalStore } from "react";

/**
 * «Новый вид» для мелких общих деталей (переключатель, строка числа, раздел
 * настроек, меню профиля), 18.11.2026.
 *
 * Страницы спрашивают `useRoyalLook()` (ему нужны роутер и запрос /ui-shell).
 * Детали, которые рисуются и вне роутера (тесты, шторки в портале), читают
 * готовый итог — атрибут `data-ui-look="royal"` на <html>, который ставит
 * AppLayout по тому же `useRoyalLook()`. Так разметка нового вида появляется
 * ровно тогда, когда действуют его стили, и никогда без признака с сервера.
 */
function read(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.uiLook === "royal";
}

function subscribe(notify: () => void) {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => {};
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-ui-look"] });
  return () => observer.disconnect();
}

export function useRoyalLookAttr(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
