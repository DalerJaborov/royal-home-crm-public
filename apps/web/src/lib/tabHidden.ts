/** Флаг «вкладка свёрнута/неактивна» на <html> — одна CSS-переменная состояния
 *  для всего приложения (TASKS.md ~403/~740: «всё быстро на ПК и телефоне, без
 *  зависаний»). Бесконечные CSS-анимации (знак ИИ, аврора фона, пульс
 *  микрофона, эквалайзер записи, presence-точка, окно звонка — их больше
 *  десятка и они появляются со временем) не должны тикать на вкладке, которую
 *  никто не видит: `document.hidden` — тот же признак, что использует
 *  Chrome DevTools Performance/Lighthouse для «фоновой» вкладки.
 *
 *  Правило `html[data-tab-hidden="1"] * { animation-play-state: paused }`
 *  живёт в index.css сразу после @tailwind — сюда вынесена только установка
 *  атрибута, по тому же приёму, что initMobileUxFlag() в hooks/useMobileUx.ts. */
/** Вкладка сейчас скрыта — для таймеров, которым на ней тикать незачем (hooks/useNow.ts). */
export function isTabHidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

export function initTabHiddenFlag(): () => void {
  const apply = () => {
    if (document.hidden) document.documentElement.dataset.tabHidden = "1";
    else delete document.documentElement.dataset.tabHidden;
  };
  apply();
  document.addEventListener("visibilitychange", apply);
  return () => document.removeEventListener("visibilitychange", apply);
}
