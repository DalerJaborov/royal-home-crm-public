import { z } from "zod";
import { INTERACTION_TYPES, type InteractionType } from "./enums.js";

/**
 * Сводка раздела «Активность» за выбранный период.
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ СВОДКА. Плитки экрана («Звонков», «Сообщений», «Показов»,
 * «Встреч») раньше считались по ЗАГРУЖЕННОЙ странице ленты, то есть число
 * зависело от того, докрутил ли человек список. Такая цифра выглядит фактом за
 * период, не будучи им, и однажды по ней приняли бы решение. Пока сводки не
 * было, под плитками стояла честная подпись «по загруженным событиям»
 * (решение владельца 09.09.2026, docs/theme-2026-missing.md §8).
 *
 * Схема живёт в @royal-home/shared, а не в apps/api: одну и ту же форму ответа
 * читают маршрут и экран, и расходиться им нельзя.
 */

/**
 * Разбивка по типу события.
 *
 * Ключи — ВЕСЬ перечень INTERACTION_TYPES, и он же единственный источник правды:
 * форма выводится из него, а не переписывается руками. Отсюда же и предел
 * выборки, которого правило репозитория требует от любого маршрута с массивом:
 * разбивка ограничена по построению — типов ровно столько, сколько в перечне,
 * и никакой параметр запроса это число не увеличит.
 *
 * Отсутствующие в периоде типы приходят нулями, а не пропущенными ключами:
 * клиенту не нужно знать, «событий нет» или «поле забыли».
 */
export const activitySummaryByTypeSchema = z.object(
  Object.fromEntries(INTERACTION_TYPES.map((type) => [type, z.number().int().nonnegative()])) as Record<
    InteractionType,
    z.ZodNumber
  >,
);
export type ActivitySummaryByType = z.infer<typeof activitySummaryByTypeSchema>;

export const activitySummarySchema = z.object({
  /** Всего событий за период в области видимости запросившего. */
  total: z.number().int().nonnegative(),
  byType: activitySummaryByTypeSchema,
  /**
   * Границы, по которым на самом деле посчитано, — в ISO. Сервер выравнивает
   * период по календарным суткам Душанбе (контейнер живёт в UTC), поэтому
   * возвращать «что просили» было бы неправдой. null — граница не задана.
   */
  from: z.string().nullable(),
  to: z.string().nullable(),
});
export type ActivitySummary = z.infer<typeof activitySummarySchema>;

/** Нулевая разбивка — общая заготовка для сервера (типы без событий) и клиента (до ответа). */
export function emptyActivitySummaryByType(): ActivitySummaryByType {
  return Object.fromEntries(INTERACTION_TYPES.map((type) => [type, 0])) as ActivitySummaryByType;
}
