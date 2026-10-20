import { useEffect, useState } from "react";

/**
 * Телефонное поведение интерфейса — по УСТРОЙСТВУ, а не по облику.
 *
 * ЧТО БЫЛО НЕ ТАК. Шторки снизу, смахивание строк и потягивание для обновления
 * включались условием `look === "live2"` (прежний useSheetMode в BottomSheet.tsx),
 * а облик по умолчанию — «Классический». То есть сотрудник, никогда не заходивший
 * в настройки внешнего вида — а это большинство, — работал с телефона в интерфейсе,
 * рассчитанном на мышь: окна по центру экрана, никаких жестов. Владелец 10.08.2026:
 * «на телефоне — всегда как приложение».
 *
 * Облик при этом никуда не делся: он по-прежнему меняет цвета, шрифты и характер
 * движения. Он просто перестал решать, работают ли жесты, — это свойство телефона
 * в руке, а не вкуса в настройках.
 *
 * ПОЧЕМУ ДВА УСЛОВИЯ, А НЕ ОДНА ШИРИНА. Узкий экран — это телефон, тут всё ясно.
 * Второе условие ловит планшет: экран широкий, но управление пальцем, и окно по
 * центру с крестиком там так же неудобно. Ограничение по ширине во втором условии
 * обязательно — без него сенсорный ноутбук с диагональю 15 дюймов получил бы
 * шторки снизу, чего никто не просил.
 *
 * ЧИСЛА (06.10.2026, контракт оболочки): две точки перелома, 820 и 1180 px —
 * `screens.md` и `screens.lg` в tailwind.config.js. Запрос берёт на единицу
 * меньше каждой (819 и 1179), чтобы `md:`/`lg:` в разметке и этот признак
 * переключались на одной и той же ширине. Расхождение ловит тест
 * hooks/__tests__/breakpoints.test.ts.
 */
export const MOBILE_UX_QUERY = "(max-width: 819px), (max-width: 1179px) and (pointer: coarse)";

/** Без React — для кода вне компонентов (инициализация признака на <html>). */
export function isMobileUx(): boolean {
  return typeof window !== "undefined" && window.matchMedia(MOBILE_UX_QUERY).matches;
}

/**
 * Признак `data-mobile-ux` на <html> — им пользуется CSS.
 *
 * Правила шторки записаны один раз на `[role="dialog"]` (см. index.css): так любое
 * окно приложения становится шторкой без переписывания его разметки. Значит CSS
 * нужен признак, который нельзя вычислить одним медиа-запросом — «телефон ИЛИ
 * планшет с пальцем». Ставится один раз при запуске, дальше сам следит за поворотом
 * экрана и изменением размера окна.
 */
export function initMobileUxFlag(): () => void {
  const mq = window.matchMedia(MOBILE_UX_QUERY);
  const apply = (matches: boolean) => {
    if (matches) document.documentElement.dataset.mobileUx = "1";
    else delete document.documentElement.dataset.mobileUx;
  };
  apply(mq.matches);
  const onChange = (e: MediaQueryListEvent) => apply(e.matches);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** Тот же признак для React-логики: жесты, выбор разметки, поведение кнопок. */
export function useMobileUx(): boolean {
  const [mobile, setMobile] = useState(isMobileUx);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_UX_QUERY);
    const onChange = (e: MediaQueryListEvent) => setMobile(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return mobile;
}
