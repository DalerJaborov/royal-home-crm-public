import { KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors, type KeyboardCoordinateGetter } from "@dnd-kit/core";

/**
 * СЕНСОРЫ ПЕРЕТАСКИВАНИЯ, НЕ МЕШАЮЩИЕ ЛИСТАТЬ ПАЛЬЦЕМ — одни на все `DndContext`
 * (17.11.2026, аудит F2-3).
 *
 * `PointerSensor` ловит и мышь, и палец: перетаскивание начиналось после сдвига
 * на несколько точек В ЛЮБУЮ сторону. На телефоне попытка пролистать страницу,
 * начатая на плитке, читалась как «тащу»: страница не ехала, плитка уезжала за
 * пальцем. В сетке фото объекта это молча меняло ГЛАВНОЕ фото (обложку на сайте и
 * в рекламе) — порядок сразу уходил на сервер. Тот же механизм уже чинили в
 * «Сделках» (pages/Deals.tsx), но починка жила в одном файле, и сетка фото и
 * шторка порядка вкладок остались со старым сенсором.
 *
 * Мышь — как было: сдвиг на `mouseDistance` точек. Палец — только долгое нажатие
 * 200 мс с допуском 8 точек: пролистывание уходит странице. Сторож
 * `lib/__tests__/dragSensorsGuard.test.ts` не пускает `PointerSensor` в код мимо
 * этого хука.
 *
 * Элементу, который тащат, ставить `touch-action: manipulation`, а не `none`:
 * `none` запрещает браузеру прокрутку с первого касания.
 */
export function useTouchSafeDragSensors({
  mouseDistance = 8,
  keyboard,
}: { mouseDistance?: number; keyboard?: KeyboardCoordinateGetter } = {}) {
  const mouse = useSensor(MouseSensor, { activationConstraint: { distance: mouseDistance } });
  const touch = useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } });
  // Хук нельзя звать условно, поэтому клавиатурный сенсор создаётся всегда, а в
  // список попадает только по запросу: иначе Enter на плитке фото начинал бы
  // перетаскивание вместо открытия снимка. `useSensors` сам отбрасывает null.
  const kb = useSensor(KeyboardSensor, keyboard ? { coordinateGetter: keyboard } : undefined);
  return useSensors(mouse, touch, keyboard ? kb : null);
}
