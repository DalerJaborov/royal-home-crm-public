import { PROPERTY_PIPELINE_STATUSES, requiresPropertyModeration, type PropertyStatus } from "@royal-home/shared";

/**
 * «Снят» стоит и в подготовке: таблица переходов (PROPERTY_AGENT_TRANSITIONS)
 * разрешает снять объект с любого этапа, а в списке этого пункта не было —
 * собственник передумал, а агенту на этапе фото/видео нечем было это отметить
 * (аудит 24.09.2026, №179).
 */
const PIPELINE_OPTIONS = ["PENDING_REVIEW", "AWAITING_PHOTOS", "AWAITING_VIDEO", "EDITING", "AVAILABLE", "WITHDRAWN"] as const;
const SALE_OPTIONS = ["AVAILABLE", "WITHDRAWN"] as const;
/**
 * Снятый объект: вернуть в продажу напрямую может только маркетинг, а агенту
 * остаётся «на проверку» — оттуда объект выходит в продажу обычным путём.
 * Раньше у агента в списке был один «Снят», и вернуть объект, когда собственник
 * передумал, было нечем (аудит 23.09.2026, №60). Сервер этот переход и раньше
 * принимал (requiresPropertyModeration).
 */
const WITHDRAWN_OPTIONS = ["WITHDRAWN", "PENDING_REVIEW", "AVAILABLE"] as const;

/**
 * Статусы в выпадающем списке карточки объекта. Шаги, закрытые правом
 * properties.moderate, агенту не показываются — правило общее с сервером.
 */
export function propertyStatusOptions(current: PropertyStatus, canModerate: boolean): PropertyStatus[] {
  const inPipeline = (PROPERTY_PIPELINE_STATUSES as readonly string[]).includes(current);
  const base: readonly PropertyStatus[] = inPipeline ? PIPELINE_OPTIONS : current === "WITHDRAWN" ? WITHDRAWN_OPTIONS : SALE_OPTIONS;
  return base.filter((s) => canModerate || !requiresPropertyModeration(current, s));
}
