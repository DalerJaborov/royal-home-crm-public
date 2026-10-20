import { useCallback, useEffect, useRef } from "react";
import { useMobileUx } from "../hooks/useMobileUx";
import { isMotionDisabled } from "../lib/motionPolicy";

/**
 * Поведение шторки снизу для модальных окон.
 *
 * ЗАЧЕМ. К 2026 году шторка — стандартный контейнер телефонных приложений для
 * всего, что не заслуживает полного экрана. Причина физическая: три четверти
 * касаний делаются большим пальцем, а он достаёт только до нижней трети экрана.
 * Окно, выехавшее снизу, начинается там, где палец уже есть; окно по центру
 * заставляет перехватывать телефон.
 *
 * ПОЧЕМУ ТАК, А НЕ ОТДЕЛЬНЫМ КОМПОНЕНТОМ-ОБЁРТКОЙ. Формы клиента и объекта —
 * это сотни строк разметки со своей прокруткой и липким низом. Оборачивать их в
 * ещё один контейнер значит переписать обе и получить два разных набора багов
 * на телефоне и на компьютере. Вместо этого вид шторки (положение, скругление,
 * выезд снизу) даёт CSS облика «Живая 2.0» — одно правило на все окна разом, —
 * а здесь остаётся только то, чего CSS не умеет: перетаскивание пальцем.
 *
 * ПЕРЕНОС НА ТЕМУ «ROYAL HOME 2026» ЕГО НЕ КАСАЕТСЯ (09.09.2026). В этом файле
 * нет ни одного элемента разметки: только два хука — «сейчас режим шторки?» и
 * «тяни пальцем вниз». Переносить нечего, и это не пропуск, а свойство файла:
 * облик шторки задаёт `.sheet` эталона в `components/rh2/Rh2Sheet.tsx`, а жест
 * по-прежнему приходит отсюда, чтобы не заводить вторую его реализацию.
 *
 * ГДЕ РАБОТАЕТ. Только облик live2 и только узкий экран. В прежних обликах окна
 * остаются прежними (владелец 08.08.2026 просил новый облик отдельно, «чтобы
 * вдруг не потерять» старый), на компьютере шторка бессмысленна — там мышь.
 */

/** Утянули больше четверти высоты — закрываем. */
const CLOSE_FRACTION = 0.25;
/** …или дёрнули вниз быстрее этого (px/мс): резкий смах закрывает, не доходя до
 *  четверти экрана. Порог намеренно высокий — 0.5 срабатывал на обычном коротком
 *  движении пальца, и форма с введёнными данными закрывалась от случайного дёрга. */
const FLING_VELOCITY = 0.9;
/** Ниже этого рывок не считается жестом вовсе, какой бы быстрой ни была скорость:
 *  сорок пикселей — это промах по кнопке, а не «закрой окно». */
const MIN_FLING_DISTANCE = 60;

/**
 * Идёт ли сейчас режим шторки.
 *
 * РАНЬШЕ ЗДЕСЬ БЫЛО `look === "live2" && narrow` — и это оказалось главной причиной,
 * по которой мобильная версия не ощущалась приложением. Облик по умолчанию —
 * «Классический», а значит у сотрудника, не заходившего в настройки внешнего вида,
 * не работали ни шторки, ни смахивание, ни потягивание для обновления: он держал в
 * руках телефон, а интерфейс вёл себя как настольный. Решение владельца 10.08.2026:
 * поведение определяет устройство, а не облик (см. hooks/useMobileUx.ts).
 *
 * Имя сохранено: им пользуются PullToRefresh, SwipeRow и обе большие формы, и
 * переименование ради переименования только затруднило бы чтение истории правок.
 */
export function useSheetMode(): boolean {
  return useMobileUx();
}

export interface SwipeToDismiss {
  /** Вешается на контейнер окна. */
  ref: (node: HTMLElement | null) => void;
  /** Пустой объект, когда режим шторки выключен, — вызывающему коду ничего не менять. */
  handlers: {
    onTouchStart?: (e: React.TouchEvent) => void;
    onTouchMove?: (e: React.TouchEvent) => void;
    onTouchEnd?: () => void;
  };
}

/**
 * Смахивание вниз закрывает окно. Возвращает ref и обработчики касаний.
 *
 * Тянуть можно только вниз и только когда содержимое прокручено в самый верх:
 * иначе жест «листаю форму вверх» посреди заполнения закрывал бы её вместе со
 * всем введённым.
 */
export function useSwipeToDismiss(enabled: boolean, onClose: () => void): SwipeToDismiss {
  const nodeRef = useRef<HTMLElement | null>(null);
  const drag = useRef<{ startY: number; startTime: number; offset: number; allowed: boolean } | null>(null);

  const setNode = useCallback((node: HTMLElement | null) => {
    nodeRef.current = node;
  }, []);

  useEffect(() => {
    // Окно закрылось или режим выключили — снимаем сдвиг, иначе он «прилипнет»
    // к следующему открытию.
    if (!enabled && nodeRef.current) nodeRef.current.style.transform = "";
  }, [enabled]);

  if (!enabled) return { ref: setNode, handlers: {} };

  /** Прокручиваемая область внутри окна — по ней решаем, можно ли тянуть. */
  const scrollTop = () => {
    const el = nodeRef.current?.querySelector<HTMLElement>("[data-sheet-scroll], .overflow-y-auto");
    return el ? el.scrollTop : 0;
  };

  return {
    ref: setNode,
    handlers: {
      onTouchStart: (e) => {
        drag.current = {
          startY: e.touches[0].clientY,
          startTime: performance.now(),
          offset: 0,
          allowed: scrollTop() <= 0,
        };
      },
      onTouchMove: (e) => {
        const d = drag.current;
        if (!d || !d.allowed || !nodeRef.current) return;
        const delta = Math.max(0, e.touches[0].clientY - d.startY);
        d.offset = delta;
        nodeRef.current.style.transition = "none";
        nodeRef.current.style.transform = `translateY(${delta}px)`;
      },
      onTouchEnd: () => {
        const d = drag.current;
        drag.current = null;
        const node = nodeRef.current;
        if (!d || !node) return;
        const instant = isMotionDisabled();
        node.style.transition = instant ? "none" : "transform 220ms cubic-bezier(0.16, 1, 0.3, 1)";
        const height = node.getBoundingClientRect().height || window.innerHeight;
        const velocity = d.offset / Math.max(1, performance.now() - d.startTime);
        if (d.offset > height * CLOSE_FRACTION || (velocity > FLING_VELOCITY && d.offset > MIN_FLING_DISTANCE)) {
          if (instant) {
            node.style.transform = "";
            onClose();
            return;
          }
          // Доводим до низа и только потом снимаем: мгновенное исчезновение
          // читается как сбой, а не как закрытие.
          node.style.transform = `translateY(${height}px)`;
          window.setTimeout(() => {
            onClose();
            // ВАЖНО: onClose не всегда закрывает окно. Если в форме есть введённые
            // данные, оно вместо закрытия спрашивает «Закрыть без сохранения?» — и
            // на «Отмена» человек остаётся в форме. Но окно к этому моменту уже
            // уехало вниз и без сброса так там и оставалось: владелец 08.08.2026
            // сообщил, что после «Отмена» форма не возвращается. Сбрасываем сдвиг
            // всегда: если окно правда закрылось, узел уже размонтирован и эта
            // строка ни на что не влияет.
            node.style.transform = "";
          }, 170);
          return;
        }
        node.style.transform = "";
      },
    },
  };
}
