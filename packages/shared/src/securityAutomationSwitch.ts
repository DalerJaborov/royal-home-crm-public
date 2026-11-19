import { z } from "zod";

/**
 * РУБИЛЬНИК «СЛУЖБА БЕЗОПАСНОСТИ: АВТОМАТИКА» (владелец 18.11.2026).
 *
 * Слова владельца: «Нужно чтобы таких больше не было и временно выключить всю
 * логику сб можно? Просто чтобы уведомление было руководителю тоже». Повод —
 * продавец, которую проверка СБ закрыла 19.10, хотя её объект продавался.
 *
 * ПОКА ВЫКЛЮЧЕН (так стоит после выката, `@default(false)` в базе):
 *  - никакая автоматика СБ/антифрода сама не меняет карточку и агента: не ставит
 *    «на проверку СБ», не убирает в Корзину, не снимает и не передаёт агента;
 *  - каждый сигнал, по которому она раньше действовала, записывается в закрытую
 *    хронологию и дело СБ (ничего не теряется) и уходит уведомлением директору и
 *    РОП (lib/securityAutomation.ts, reportSecuritySignal).
 *
 * Сервер читает рубильник через apps/api/src/lib/securityAutomation.ts, экран —
 * apps/web/src/pages/settings/SecurityAutomationSection.tsx. Подписи — здесь.
 */
export const SECURITY_AUTOMATION_KEY = "securityAutomationEnabled" as const;

/** Нет строки настроек — ВЫКЛЮЧЕНО: то же умолчание, что у колонки в базе. */
export const SECURITY_AUTOMATION_DEFAULT = false;

export type SecurityAutomationSwitch = Record<typeof SECURITY_AUTOMATION_KEY, boolean>;

/** Часть схемы PATCH /settings — встраивается через `.shape`. */
export const securityAutomationSwitchUpdateSchema = z.object({
  [SECURITY_AUTOMATION_KEY]: z.boolean().optional(),
});

export function isSecurityAutomationOn(
  settings: Partial<Record<typeof SECURITY_AUTOMATION_KEY, boolean | null | undefined>> | null | undefined
): boolean {
  return settings?.[SECURITY_AUTOMATION_KEY] ?? SECURITY_AUTOMATION_DEFAULT;
}

export const SECURITY_AUTOMATION_LABEL = {
  title: "Служба безопасности: автоматика",
  /** Пока ВКЛЮЧЁН (подпись SwitchRow — про текущее положение). */
  on: "Подозрительные случаи сами уходят на проверку СБ. Карточку с объектом в продаже, сделкой или свежей работой агента проверка не закрывает.",
  /** Пока ВЫКЛЮЧЕН. */
  off: "Автоматика СБ карточки и агентов не трогает. Обо всём, что она нашла, приходит уведомление директору и РОП, запись остаётся в деле.",
} as const;
