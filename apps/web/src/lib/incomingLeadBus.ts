/**
 * Шина «какой лид сейчас открыт полноэкранным окном» — тот же лёгкий приём,
 * что и в aiFaceEvents.ts (внешний стор без React/Zustand, только оповестить
 * подписчиков), и по той же причине: `IncomingLeadWindow` (смонтировано в
 * AppLayout, живёт над всеми 25 разделами) и секция «Ждут вашего принятия»
 * (телефонная Главная агента, слита в components/home/AgentHome.tsx 06.10.2026
 * и больше шину не читает: «Сначала это» показывает лид всегда) читали один и тот же список
 * pendingAcceptance, но общего родителя ближе App у них нет.
 *
 * ЗАЧЕМ. Владелец 15.09.2026: пока лид висит во весь экран (или свёрнут в
 * тихую строку сверху — он и там не закрыт, просто свёрнут), повторять его же
 * строкой на Главной незачем — дубль. Но секция не должна пустеть НАВСЕГДА:
 * второй одновременный лид сверх первого (полноэкранное показывает по одному),
 * будущий режим «выдавать сразу 2-3» или крайний случай, когда окно почему-то
 * не поднялось — во всех них лид обязан остаться виден хоть где-то, и Главная
 * снова его покажет.
 *
 * Один читатель, один писатель за раз (`IncomingLeadWindow` — единственный
 * экземпляр, смонтированный один раз), поэтому карта «источник → флаг», как у
 * тревоги в aiFaceEvents.ts, здесь избыточна: значение одно на всё приложение.
 */

type Listener = () => void;

const listeners = new Set<Listener>();
let shownLeadId: string | null = null;

/** Подписка для `useSyncExternalStore`. */
export function subscribeIncomingLeadShown(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getIncomingLeadShownId(): string | null {
  return shownLeadId;
}

/** Полноэкранное окно сообщает, какой лид сейчас показывает (или `null`,
 *  когда закрылось). Вызывающий обязан снять значение при размонтировании. */
export function setIncomingLeadShown(id: string | null): void {
  if (shownLeadId === id) return;
  shownLeadId = id;
  for (const fn of listeners) fn();
}

/** Только для тестов: вернуть модуль в исходное состояние. */
export function resetIncomingLeadBus(): void {
  shownLeadId = null;
}
