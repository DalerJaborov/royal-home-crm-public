import { useEffect } from "react";
import { scrollBoxesFrom, shouldBlockTouchMove, touchIsExempt } from "../lib/touchScrollTrap";

/**
 * Пока открыто окно, страница под ним не прокручивается.
 *
 * ЗАЧЕМ. На телефоне это самая заметная разница между окном приложения и окном
 * сайта. Палец промахивается мимо содержимого шторки — и вместо неё едет список
 * клиентов под ней; человек закрывает окно и обнаруживает, что потерял место в
 * списке. В приложениях фон под шторкой неподвижен всегда.
 *
 * ПОЧЕМУ ЧЕРЕЗ position: fixed, А НЕ overflow: hidden. `overflow: hidden` на body
 * Safari на iPhone просто игнорирует — страница продолжает тянуться. Приём с
 * фиксацией работает везде: страница физически перестаёт быть прокручиваемой.
 * Плата за него — прокрутка сбрасывается в ноль, поэтому положение запоминается и
 * возвращается при закрытии. Без этого возврата закрытие окна выбрасывало бы
 * человека в начало списка — то есть чинили бы одну потерю места, а получили другую.
 *
 * СЧЁТЧИК, а не булево значение: окна открываются поверх друг друга (подбор объекта
 * → назначение показа). Без счётчика закрытие внутреннего окна разблокировало бы
 * фон, пока внешнее ещё открыто.
 */
let lockCount = 0;
let savedScrollY = 0;
let stopOverhang: (() => void) | null = null;
let stopTouchTrap: (() => void) | null = null;

/** Заблокирована ли сейчас страница каким-нибудь окном. Жесты страницы (потянуть-обновить) спрашивают здесь. */
export function isScrollLocked(): boolean {
  return lockCount > 0;
}

/**
 * Палец двигает только ленту, которой есть куда ехать (lib/touchScrollTrap.ts). Слушатель на документе и
 * НЕ пассивный: только такой может отменить движение. Направление берём от прошлого движения, а не от
 * точки касания — палец, развернувшийся посреди жеста, меряется по текущему направлению.
 */
function trapTouchMoves(): () => void {
  let lastX = 0;
  let lastY = 0;
  const onStart = (event: TouchEvent) => {
    const t = event.touches[0];
    if (t) { lastX = t.clientX; lastY = t.clientY; }
  };
  const onMove = (event: TouchEvent) => {
    const t = event.touches[0];
    if (!t || !event.cancelable || touchIsExempt(event)) return;
    const dx = t.clientX - lastX;
    const dy = t.clientY - lastY;
    lastX = t.clientX;
    lastY = t.clientY;
    if (shouldBlockTouchMove(dx, dy, scrollBoxesFrom(event.target))) event.preventDefault();
  };
  document.addEventListener("touchstart", onStart, { passive: true, capture: true });
  document.addEventListener("touchmove", onMove, { passive: false, capture: true });
  return () => {
    document.removeEventListener("touchstart", onStart, { capture: true });
    document.removeEventListener("touchmove", onMove, { capture: true });
  };
}

/**
 * ШТОРКА НЕ ДОХОДИЛА ДО НИЗА ЭКРАНА НА iPhone (кадры владельца 20.11.2026: серая полоса ~62 px под
 * любой нижней шторкой — Ассистент, «Сведения о сообщении», «Подбор»).
 *
 * Слои `position: fixed` привязаны к layout viewport, а iOS (особенно «приложение на экране Домой»)
 * местами делает видимую область больше или смещает её: нижняя кромка layout viewport оказывается
 * выше нижней кромки экрана. Мы не знаем заранее на сколько — читаем это у visualViewport и отдаём CSS
 * переменной `--rh-vv-over` (px, ≥ 0): на столько видимая область выходит за нижнюю кромку.
 * Шторка и подложка (theme-2026-mobile-shell.css, п. 6) опускают свой низ на эту величину.
 * Нет расхождения — переменная 0 и вёрстка прежняя.
 */
function trackViewportOverhang(): () => void {
  const root = document.documentElement;
  const vv = window.visualViewport;
  if (!vv) return () => undefined;
  // Пишем в стиль <html> только при ИЗМЕНЕНИИ значения и не чаще кадра: события visualViewport на iOS
  // сыплются на каждый кадр прокрутки, а запись переменной на корне пересчитывает стили всей страницы.
  let frame = 0;
  let written = "";
  const apply = () => {
    frame = 0;
    const over = Math.round(vv.offsetTop + vv.height - window.innerHeight);
    // Меньше 2 px — шум округления; больше 160 — не «хвост экрана», а клавиатура и т. п.
    const next = over >= 2 && over <= 160 ? `${over}px` : "0px";
    if (next === written) return;
    written = next;
    root.style.setProperty("--rh-vv-over", next);
  };
  const update = () => {
    if (!frame) frame = typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame(apply) : (apply(), 0);
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  window.addEventListener("resize", update);
  apply();
  return () => {
    if (frame && typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(frame);
    vv.removeEventListener("resize", update);
    vv.removeEventListener("scroll", update);
    window.removeEventListener("resize", update);
    root.style.removeProperty("--rh-vv-over");
  };
}

function lock() {
  lockCount += 1;
  if (lockCount > 1) return;
  stopOverhang = trackViewportOverhang();
  stopTouchTrap = trapTouchMoves();
  savedScrollY = window.scrollY;
  const body = document.body;
  body.style.position = "fixed";
  body.style.top = `-${savedScrollY}px`;
  body.style.left = "0";
  body.style.right = "0";
  body.style.width = "100%";
}

function unlock() {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount > 0) return;
  stopOverhang?.();
  stopOverhang = null;
  stopTouchTrap?.();
  stopTouchTrap = null;
  const body = document.body;
  body.style.position = "";
  body.style.top = "";
  body.style.left = "";
  body.style.right = "";
  body.style.width = "";
  // `instant`, а не плавно: это не путешествие по странице, а возврат в то место,
  // где человек и стоял. Плавная прокрутка выглядела бы как самопроизвольный уезд.
  window.scrollTo({ top: savedScrollY, behavior: "instant" as ScrollBehavior });
}

/** Вешается на компонент окна: пока он смонтирован, фон не прокручивается. */
export function useScrollLock(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    lock();
    return unlock;
  }, [enabled]);
}
