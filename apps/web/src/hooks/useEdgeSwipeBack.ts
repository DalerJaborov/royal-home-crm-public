import { useEffect } from "react";
import { useGoBack } from "./useGoBack";
import { useMobileUx } from "./useMobileUx";

/**
 * Свайп от левого края экрана — «назад», как в любом телефонном приложении.
 *
 * ЗАЧЕМ. В установленном приложении нет кнопки «назад» браузера: адресной строки
 * нет, и единственный способ вернуться — найти стрелку в интерфейсе. В нативных
 * приложениях её и не ищут: тянут пальцем от края. Без этого жеста установленная
 * CRM ощущается как сайт, у которого отобрали навигацию (владелец 10.08.2026).
 *
 * ТОЛЬКО ОТ КРАЯ. Двадцать пикселей от левой границы — там нет ни кнопок, ни
 * прокручиваемых списков. Иначе жест спорил бы со смахиванием строки (SwipeRow) и с
 * горизонтальной прокруткой таблиц: человек листает таблицу вправо, а его выкидывает
 * на предыдущий экран.
 *
 * ПОЧЕМУ НЕ ТЯНЕМ ЭКРАН ЗА ПАЛЬЦЕМ. Живое перетаскивание страницы требует держать
 * в памяти предыдущий экран и двигать оба слоя. Это тот случай, когда анимация
 * начинает отвечать за то, что видно на экране, — а в этом проекте такое трижды за
 * день заканчивалось невидимым интерфейсом (см. память royal-home-animation-never-hides-ui).
 * Поэтому жест распознаётся и просто выполняет переход: результат тот же, риска нет.
 */

/**
 * Насколько близко к краю должно начаться движение.
 *
 * Значение экспортируется: смахивание строки (components/SwipeRow.tsx) обязано
 * знать ту же кромку и НЕ брать касание, начатое в ней. Два горизонтальных жеста
 * из одной точки — это строка, уезжающая вбок одновременно с уходом на предыдущий
 * экран; в артефакте владельца конфликта нет потому, что зона `.edge` там лежит
 * НАД экраном отдельным слоем и до строки касание просто не доходит. У нас слоя
 * нет, жест слушает окно, поэтому границу знают обе стороны.
 */
export const EDGE_BACK_ZONE_PX = 20;
const EDGE_ZONE_PX = EDGE_BACK_ZONE_PX;
/** Насколько далеко нужно утянуть, чтобы это считалось жестом, а не касанием. */
const MIN_DISTANCE_PX = 70;
/** Вертикальный увод, после которого это прокрутка списка, а не «назад». */
const MAX_VERTICAL_DRIFT_PX = 45;

export function useEdgeSwipeBack(): void {
  const goBack = useGoBack("/");
  /**
   * Хук, а не разовый вызов `isMobileUx()`: признак меняется при повороте
   * телефона и при изменении размера окна. Разовое чтение внутри эффекта
   * навсегда запоминало ответ, данный при первом заходе, — открыл CRM на
   * планшете в книжной ориентации, повернул в альбомную, и жест исчезал до
   * перезагрузки.
   */
  const mobile = useMobileUx();

  useEffect(() => {
    if (!mobile) return;

    let startX = 0;
    let startY = 0;
    let tracking = false;

    function onTouchStart(e: TouchEvent) {
      const touch = e.touches[0];
      if (!touch || e.touches.length > 1) return;
      /**
       * Жест не работает ВНУТРИ поверхностей, которые сами занимают край экрана.
       *
       * Окно оператора входящих начинается в восьми пикселях от левого края, то
       * есть целиком лежит в зоне жеста: движение пальцем по его левой части
       * уводило человека на предыдущий экран посреди живого разговора. Отдельного
       * списка исключений не заводим — признак `data-keeps-touch` ставит сама
       * поверхность, которая знает про себя, что её край рабочий.
       */
      const target = touch.target as Element | null;
      if (target?.closest?.("[data-keeps-touch]")) return;
      tracking = touch.clientX <= EDGE_ZONE_PX;
      startX = touch.clientX;
      startY = touch.clientY;
    }

    function onTouchEnd(e: TouchEvent) {
      if (!tracking) return;
      tracking = false;
      const touch = e.changedTouches[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = Math.abs(touch.clientY - startY);
      if (dx < MIN_DISTANCE_PX || dy > MAX_VERTICAL_DRIFT_PX) return;
      // Первый экран истории: возвращаться некуда, и navigate(-1) увёл бы человека
      // из приложения обратно в браузер (а в установленном PWA — на пустой экран).
      // Отклик вибрацией, как в артефакте (haptic(8) на распознанном жесте):
      // переход назад без него читается как случайное срабатывание.
      if (typeof navigator.vibrate === "function") navigator.vibrate(8);
      goBack();
    }

    // passive: браузер не ждёт, будем ли мы отменять прокрутку, — жест не подтормаживает.
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [goBack, mobile]);
}
