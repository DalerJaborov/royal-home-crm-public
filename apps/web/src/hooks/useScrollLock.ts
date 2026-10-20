import { useEffect } from "react";

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

function lock() {
  lockCount += 1;
  if (lockCount > 1) return;
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
