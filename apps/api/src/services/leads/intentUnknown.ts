/**
 * Пометка «тип обращения не определён» (17.11.2026, services/leads/intakePolicy.ts).
 *
 * Отдельный модуль без импортов: её читают и правило отбора (intakePolicy.ts), и заведение
 * карточки (intake.ts). Пока константа жила в intakePolicy.ts, intake.ts импортировал её оттуда
 * и замыкал круг импортов intakePolicy → assignment → … → intake (сторож audit:deps).
 */
export const INTENT_UNKNOWN_NOTE = "❓ ТИП ОБРАЩЕНИЯ НЕ ОПРЕДЕЛЁН — уточните первым звонком: покупает или продаёт";
export const INTENT_UNKNOWN_REASON = "тип обращения не определён — в общей раздаче";
