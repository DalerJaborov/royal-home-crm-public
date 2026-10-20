import { PROPERTY_PIPELINE_STATUSES, type PropertyStatus } from "@royal-home/shared";

/**
 * Серверная проверка смены статуса объекта в PATCH /properties/:id (находка №182).
 *
 * Раньше переходы ограничивал только выпадающий список в карточке: прямой запрос
 * ставил «Резерв»/«Продано» без сделки и уводил объект из продажи обратно в любой
 * этап подготовки. Права на сам шаг конвейера (properties.moderate) проверяет
 * requiresPropertyModeration из @royal-home/shared — здесь то, чего таблица
 * агента не покрывает: переходы, которых нет ни у кого.
 */

const isPipeline = (s: PropertyStatus) => (PROPERTY_PIPELINE_STATUSES as readonly string[]).includes(s);
const isDealDriven = (s: PropertyStatus) => s === "RESERVED" || s === "SOLD";

export interface TransitionBlock {
  status: 403 | 409;
  error: string;
}

/**
 * Нужна ли сделка под целевым статусом. «Резерв» ставит заведённая сделка,
 * «Продано» — завершённая (routes/deals.ts, lib/propertyAutoStatus.ts).
 */
export function dealStageForManualStatus(to: PropertyStatus): "RESERVED" | "SOLD" | null {
  return isDealDriven(to) ? (to as "RESERVED" | "SOLD") : null;
}

/**
 * Чисто ролевая и «табличная» часть проверки (без обращения к базе).
 * null — переход допустим; иначе — готовый ответ клиенту.
 */
export function propertyStatusTransitionBlock(
  from: PropertyStatus,
  to: PropertyStatus,
  canModerate: boolean
): TransitionBlock | null {
  if (from === to) return null;

  // «Резерв» и «Продано» не ставятся из подготовки: туда объект не продают.
  if (isDealDriven(to) && (isPipeline(from) || from === "WITHDRAWN")) {
    return {
      status: 409,
      error: "Объект не в продаже — резерв и продажу оформляет сделка, а не смена статуса.",
    };
  }

  // Из резерва и «Продано» назад в подготовку не возвращают никогда.
  if (isDealDriven(from) && isPipeline(to)) {
    return {
      status: 409,
      error: "Объект в резерве или продан — вернуть его в подготовку нельзя. Сначала отмените сделку.",
    };
  }

  // Из продажи в подготовку объект возвращает только маркетинг (то же право, что у
  // кнопки «Запросить новые материалы»): агент таким образом выводил своё объявление
  // из продажи и обходил проверку.
  if (from === "AVAILABLE" && isPipeline(to) && !canModerate) {
    return {
      status: 403,
      error: "Вернуть объект из продажи в подготовку может только маркетинг.",
    };
  }

  return null;
}
